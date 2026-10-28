import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { stopProcess } from "@sys4sys/agent";
import {
  aggregatePortRows,
  killRequestSchema,
  killTokenQuerySchema,
  portHistoryQuerySchema,
  portOwnerFromRow,
  reservationCreateSchema,
  type PortOwner,
  type PortRow,
} from "@sys4sys/shared";
import { and, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import { tryWriteAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { actions, portHistory, portReservations, ports } from "../db/schema.js";
import {
  findReservationForEndpoint,
  findReservationForRow,
  findReservationView,
  isEndpointInUse,
  toReservationView,
  type ReservationView,
} from "../ports/reservations.js";
import { scanAndPersist } from "../ports/scanner.js";
import {
  allRequestedScopesFailed,
  scanFailureDetail,
  scopeFailed,
} from "../ports/scope-status.js";
import { signKillToken, verifyKillToken } from "../security/confirm-token.js";

const listQuerySchema = z.object({
  scope: z.enum(["all", "windows", "wsl"]).default("all"),
  protocol: z.enum(["tcp", "udp"]).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  serviceId: z.string().optional(),
  q: z.string().max(200).optional(),
});

const idParamsSchema = z.object({ id: z.string().min(1) });
const portParamsSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535),
});

function endpointKey(row: {
  scope: string;
  protocol: string;
  address: string;
  port: number;
}): string {
  return [row.scope, row.protocol, row.address, row.port].join(":");
}

function ownersFromPortRow(row: PortRow): PortOwner[] {
  return row.owners?.length ? row.owners : [portOwnerFromRow(row)];
}

function toPortOwnerResponse(owner: PortOwner) {
  return {
    pidScope: owner.pidScope ?? null,
    pid: owner.pid ?? null,
    ppid: owner.ppid ?? null,
    process: owner.process ?? null,
    processPath: owner.processPath ?? null,
    commandLine: owner.commandLine ?? null,
    startedAt: owner.startedAt ?? null,
    likelyWslForward: owner.likelyWslForward ?? false,
  };
}

type KillCandidate = PortRow & { pid: number };

function killCandidatesFromScan(rows: PortRow[]): KillCandidate[] {
  const candidates: KillCandidate[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    for (const owner of ownersFromPortRow(row)) {
      const pid = owner.pid ?? row.pid;
      if (pid === null) continue;

      const candidate: KillCandidate = {
        scope: row.scope,
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid,
        pidScope: owner.pidScope ?? row.pidScope ?? null,
        ppid: owner.ppid ?? row.ppid ?? null,
        process: owner.process ?? row.process ?? null,
        processPath: owner.processPath ?? row.processPath ?? null,
        commandLine: owner.commandLine ?? row.commandLine ?? null,
        startedAt: owner.startedAt ?? row.startedAt ?? null,
        likelyWslForward:
          owner.likelyWslForward || row.likelyWslForward || false,
      };

      const key = [
        candidate.scope,
        candidate.protocol,
        candidate.address,
        candidate.port,
        candidate.pid,
        candidate.pidScope ?? "",
        candidate.startedAt ?? "",
        candidate.process ?? "",
      ].join("\u0000");

      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function endpointLabel(scope: string, protocol: string, port: number): string {
  return `port:${scope}:${protocol}:${port}`;
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    detail,
  });
}

function actor(request: FastifyRequest) {
  const user = request.authUser;
  if (!user) throw new Error("authenticated user is missing");
  return user;
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.includes("SQLITE_CONSTRAINT");
}

function reservationResponse(view: ReservationView) {
  return {
    id: view.id,
    scope: view.scope,
    protocol: view.protocol,
    port: view.port,
    serviceId: view.serviceId,
    note: view.note,
    createdAt: view.createdAt,
    status: view.status,
    inUse: view.inUse,
  };
}

export async function portRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/ports",
    { preHandler: requireAuth, config: { scopes: ["ports:read"] } },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);
      const { scan, reservationViews } = await scanAndPersist({
        scope: query.scope,
      });

      if (allRequestedScopesFailed(scan, query.scope)) {
        const detail =
          query.scope === "all"
            ? `${scanFailureDetail(scan, "windows")} / ${scanFailureDetail(
                scan,
                "wsl",
              )}`
            : scanFailureDetail(scan, query.scope);
        return problem(reply, 503, "Service Unavailable", detail);
      }

      const persisted = await db.select().from(ports);
      const persistedByKey = new Map(
        persisted.map((row) => [endpointKey(row), row]),
      );

      const rows = aggregatePortRows(scan.rows);
      const needle = query.q?.toLowerCase();
      const items = rows
        .filter((row) =>
          query.protocol ? row.protocol === query.protocol : true,
        )
        .filter((row) => (query.port ? row.port === query.port : true))
        .filter((row) => {
          if (!needle) return true;
          const values = [
            row.process,
            row.commandLine,
            row.pidScope,
            ...(row.owners ?? []).flatMap((owner) => [
              owner.process,
              owner.commandLine,
              owner.pidScope,
            ]),
          ];
          return values.some(
            (value) =>
              typeof value === "string" && value.toLowerCase().includes(needle),
          );
        })
        .map((row) => {
          const reservation =
            findReservationView(reservationViews, row.protocol, row.port) ??
            null;
          const stored = persistedByKey.get(endpointKey(row));
          const owners = (
            row.owners?.length ? row.owners : [portOwnerFromRow(row)]
          ).map(toPortOwnerResponse);
          const primary =
            owners[0] ?? toPortOwnerResponse(portOwnerFromRow(row));

          return {
            id: endpointKey(row),
            scope: row.scope,
            pidScope: primary.pidScope ?? row.pidScope ?? null,
            seenIn: row.seenIn ?? [],
            protocol: row.protocol,
            address: row.address,
            port: row.port,
            pid: primary.pid ?? row.pid ?? null,
            ppid: primary.ppid ?? row.ppid ?? null,
            process: primary.process ?? row.process ?? null,
            processPath: primary.processPath ?? row.processPath ?? null,
            commandLine: primary.commandLine ?? row.commandLine ?? null,
            startedAt: primary.startedAt ?? row.startedAt ?? null,
            likelyWslForward:
              row.likelyWslForward ?? primary.likelyWslForward ?? false,
            owners,
            ownerCount: owners.length,
            serviceId: reservation?.serviceId ?? stored?.serviceId ?? null,
            firstSeen: stored?.firstSeen.toISOString() ?? null,
            lastSeen: stored?.lastSeen.toISOString() ?? null,
            reservation,
            conflict: Boolean(reservation),
            status: reservation ? "conflict" : "in_use",
          };
        })
        .filter((item) =>
          query.serviceId ? item.serviceId === query.serviceId : true,
        );

      return {
        scannedAt: scan.scannedAt,
        items,
        reservations: reservationViews,
        conflicts: reservationViews.filter(
          (reservation) => reservation.status === "conflict",
        ),
        skipped: scan.skipped,
        scanErrors: scan.scanErrors,
        warnings: scan.warnings,
        distros: scan.distros,
      };
    },
  );

  app.get(
    "/ports/history",
    { preHandler: requireAuth, config: { scopes: ["ports:read"] } },
    async (request) => {
      const query = portHistoryQuerySchema.parse(request.query);
      const rows = await db
        .select()
        .from(portHistory)
        .where(
          and(
            eq(portHistory.scope, query.scope),
            eq(portHistory.port, query.port),
            query.protocol
              ? eq(portHistory.protocol, query.protocol)
              : undefined,
            query.from
              ? gte(portHistory.openedAt, new Date(query.from))
              : undefined,
            query.to
              ? lte(portHistory.openedAt, new Date(query.to))
              : undefined,
          ),
        )
        .orderBy(desc(portHistory.openedAt))
        .limit(query.limit);

      return rows.map((row) => ({
        id: row.id,
        scope: row.scope,
        pidScope: row.pidHostId,
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid: row.pid,
        ppid: row.ppid,
        process: row.processName,
        processPath: row.processPath,
        commandLine: row.commandLine,
        startedAt: row.startedAt?.toISOString() ?? null,
        serviceId: row.serviceId,
        openedAt: row.openedAt.toISOString(),
        closedAt: row.closedAt?.toISOString() ?? null,
        releasedBy: row.releasedBy,
      }));
    },
  );

  app.post(
    "/ports/reserve",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["ports:operate"] },
    },
    async (request, reply) => {
      const body = reservationCreateSchema.parse(request.body);
      const user = actor(request);
      const { scan, reservations } = await scanAndPersist({ scope: "all" });

      // 予約対象のスコープが取得できていない場合は、空の結果を
      // 「空いている」と誤判定しないよう fail-closed にする。
      if (scopeFailed(scan, body.scope)) {
        return problem(
          reply,
          503,
          "Service Unavailable",
          scanFailureDetail(scan, body.scope),
        );
      }

      if (isEndpointInUse(scan.rows, body.protocol, body.port)) {
        return problem(
          reply,
          409,
          "Conflict",
          `${body.protocol.toUpperCase()} ${body.port} は現在使用中です`,
        );
      }

      if (findReservationForEndpoint(reservations, body.protocol, body.port)) {
        return problem(
          reply,
          409,
          "Conflict",
          `${body.protocol.toUpperCase()} ${body.port} は既に予約されています`,
        );
      }

      const createdAt = new Date();
      const id = randomUUID();
      try {
        await db.insert(portReservations).values({
          id,
          scope: body.scope,
          port: body.port,
          protocol: body.protocol,
          serviceId: body.serviceId,
          note: body.note ?? null,
          createdAt,
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return problem(
            reply,
            409,
            "Conflict",
            `${body.protocol.toUpperCase()} ${body.port} は既に予約されています`,
          );
        }
        throw error;
      }

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "port.reserve",
        target: endpointLabel(body.scope, body.protocol, body.port),
        after: {
          reservationId: id,
          serviceId: body.serviceId,
          note: body.note ?? null,
        },
        ip: request.ip,
      });

      return reply.code(201).send(
        reservationResponse(
          toReservationView(
            {
              id,
              scope: body.scope,
              port: body.port,
              protocol: body.protocol,
              serviceId: body.serviceId,
              note: body.note ?? null,
              createdAt,
            },
            scan.rows,
          ),
        ),
      );
    },
  );

  app.delete(
    "/ports/reserve/:id",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["ports:operate"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const [reservation] = await db
        .select()
        .from(portReservations)
        .where(eq(portReservations.id, id))
        .limit(1);

      if (!reservation) {
        return problem(reply, 404, "Not Found", "予約が見つかりません");
      }

      await db
        .delete(portReservations)
        .where(eq(portReservations.id, reservation.id));

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "port.reserve.delete",
        target: endpointLabel(
          reservation.scope,
          reservation.protocol,
          reservation.port,
        ),
        before: {
          reservationId: reservation.id,
          serviceId: reservation.serviceId,
          note: reservation.note,
        },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );

  app.get(
    "/ports/:port/kill-token",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["ports:operate"] },
    },
    async (request, reply) => {
      const { port } = portParamsSchema.parse(request.params);
      const query = killTokenQuerySchema.parse(request.query);
      const { scan } = await scanAndPersist({ scope: query.scope });

      if (scopeFailed(scan, query.scope)) {
        return problem(
          reply,
          503,
          "Service Unavailable",
          scanFailureDetail(scan, query.scope),
        );
      }

      const candidates = killCandidatesFromScan(scan.rows).filter(
        (candidate) =>
          candidate.scope === query.scope &&
          candidate.port === port &&
          (query.pid === undefined || candidate.pid === query.pid) &&
          (query.pidScope === undefined ||
            (candidate.pidScope ?? null) === query.pidScope),
      );

      if (candidates.length === 0) {
        return problem(
          reply,
          409,
          "Conflict",
          "指定したポートを掴んでいるプロセスが見つかりません",
        );
      }

      const pids = new Set(candidates.map((row) => row.pid));
      if (pids.size > 1 && query.pid === undefined) {
        return problem(
          reply,
          409,
          "Conflict",
          "同じポートに複数の PID があります。pid を指定してください",
        );
      }

      const target = candidates[0];
      if (!target) {
        return problem(
          reply,
          409,
          "Conflict",
          "指定したポートを掴んでいるプロセスが見つかりません",
        );
      }

      if (target.pid <= 4 || target.pid === process.pid) {
        return problem(
          reply,
          409,
          "Conflict",
          "システムプロセスまたは API 自身は停止できません",
        );
      }

      const signed = signKillToken({
        scope: target.scope,
        pidScope: target.pidScope ?? null,
        port: target.port,
        pid: target.pid,
        startedAt:
          target.scope === "windows" ? (target.startedAt ?? null) : null,
      });

      return {
        token: signed.token,
        expiresAt: signed.expiresAt.toISOString(),
        scope: target.scope,
        pidScope: target.pidScope ?? null,
        port: target.port,
        pid: target.pid,
        startedAt:
          target.scope === "windows" ? (target.startedAt ?? null) : null,
        process: target.process,
      };
    },
  );

  app.post(
    "/ports/:port/kill",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["ports:operate"] },
    },
    async (request, reply) => {
      const { port } = portParamsSchema.parse(request.params);
      const body = killRequestSchema.parse(request.body);
      const user = actor(request);
      const token = verifyKillToken(body.confirmToken);

      if (
        !token ||
        token.port !== port ||
        token.scope !== body.scope ||
        (token.pidScope ?? null) !== (body.pidScope ?? null)
      ) {
        return problem(
          reply,
          400,
          "Bad Request",
          "確認トークンが無効または期限切れです",
        );
      }

      if (token.pid <= 4 || token.pid === process.pid) {
        return problem(
          reply,
          409,
          "Conflict",
          "システムプロセスまたは API 自身は停止できません",
        );
      }

      const { scan, reservations } = await scanAndPersist({
        scope: token.scope,
      });
      if (scopeFailed(scan, token.scope)) {
        return problem(
          reply,
          503,
          "Service Unavailable",
          scanFailureDetail(scan, token.scope),
        );
      }
      const matchingCandidates = killCandidatesFromScan(scan.rows).filter(
        (candidate) =>
          candidate.scope === token.scope &&
          candidate.port === port &&
          candidate.pid === token.pid &&
          (candidate.pidScope ?? null) === token.pidScope,
      );
      const target =
        token.scope === "windows"
          ? (matchingCandidates.find(
              (candidate) => (candidate.startedAt ?? null) === token.startedAt,
            ) ?? matchingCandidates[0])
          : matchingCandidates[0];

      if (!target) {
        return problem(
          reply,
          409,
          "Conflict",
          "ポートの状態が変わったため停止を中止しました。再スキャンしてください",
        );
      }

      if (
        token.scope === "windows" &&
        (target.startedAt ?? null) !== token.startedAt
      ) {
        return problem(
          reply,
          409,
          "Conflict",
          "プロセスの開始時刻が変わったため停止を中止しました。再スキャンしてください",
        );
      }

      const reservation = findReservationForRow(reservations, target);
      const serviceId = reservation?.serviceId ?? `port:${token.scope}:${port}`;
      const startedAt = new Date();
      const actionId = randomUUID();

      try {
        await stopProcess({
          scope: token.scope,
          pidScope: token.pidScope,
          pid: token.pid,
          signal: body.signal,
          force: body.force,
        });

        const finishedAt = new Date();
        await db.insert(actions).values({
          id: actionId,
          incidentId: null,
          serviceId,
          type: "kill",
          status: "succeeded",
          requestedBy: user.id,
          approvedBy: null,
          policyId: null,
          startedAt,
          finishedAt,
          error: null,
        });

        await db
          .update(portHistory)
          .set({
            closedAt: finishedAt,
            releasedBy: user.email,
          })
          .where(
            and(
              eq(portHistory.scope, token.scope),
              eq(portHistory.port, port),
              eq(portHistory.pid, token.pid),
              isNull(portHistory.closedAt),
            ),
          );

        await tryWriteAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "port.kill",
          target: endpointLabel(token.scope, target.protocol, port),
          before: {
            pid: target.pid,
            ppid: target.ppid ?? null,
            process: target.process,
            commandLine: target.commandLine,
            pidScope: target.pidScope ?? null,
          },
          after: {
            actionId,
            signal: body.signal,
            force: body.force,
            serviceId,
          },
          ip: request.ip,
        });

        return reply.code(202).send({
          id: actionId,
          incidentId: null,
          serviceId,
          type: "kill",
          status: "succeeded",
          requestedBy: user.id,
          approvedBy: null,
          policyId: null,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          error: null,
        });
      } catch (error) {
        const finishedAt = new Date();
        const message = error instanceof Error ? error.message : String(error);

        await db.insert(actions).values({
          id: actionId,
          incidentId: null,
          serviceId,
          type: "kill",
          status: "failed",
          requestedBy: user.id,
          approvedBy: null,
          policyId: null,
          startedAt,
          finishedAt,
          error: message.slice(0, 2000),
        });

        await tryWriteAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "port.kill.failed",
          target: endpointLabel(token.scope, target.protocol, port),
          before: {
            pid: target.pid,
            process: target.process,
            pidScope: target.pidScope ?? null,
          },
          after: { actionId, signal: body.signal, force: body.force },
          reason: message.slice(0, 500),
          ip: request.ip,
        });

        request.log.error(error);
        return problem(
          reply,
          409,
          "Conflict",
          `プロセスを停止できませんでした: ${message}`,
        );
      }
    },
  );
}
