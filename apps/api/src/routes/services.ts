import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  serviceCreateSchema,
  serviceListQuerySchema,
  serviceUpdateSchema,
} from "@sys4sys/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { actions, hosts, logSources, services } from "../db/schema.js";
import { refreshLogTailer } from "../logs/tailers.js";
import { isCommandAllowed } from "../services/allowlist.js";
import {
  checkServiceHealth,
  restartService,
  runtimeInfo,
  ServiceError,
  startService,
  stopService,
  type ServiceRow,
} from "../services/manager.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type HostRow = typeof hosts.$inferSelect;
type ActionRow = typeof actions.$inferSelect;

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

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function hostResponse(host: HostRow | undefined) {
  if (!host) return null;
  return {
    id: host.id,
    kind: host.kind,
    name: host.name,
    distro: host.distro,
    defaultUser: host.defaultUser,
    enabled: host.enabled,
  };
}

function serviceResponse(row: ServiceRow, host: HostRow | undefined) {
  const runtime = runtimeInfo(row.id);
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    command: row.command,
    cwd: row.cwd,
    env: row.env ?? null,
    expectedPorts: row.expectedPorts ?? [],
    healthCheck: row.healthCheck ?? null,
    dependsOn: row.dependsOn ?? [],
    autoStart: row.autoStart,
    autoRestartPhase: row.autoRestartPhase,
    status: row.status,
    isActive: row.isActive,
    pid: row.pid,
    pidScope: row.pidScope,
    lastStartedAt: iso(row.lastStartedAt),
    lastExitedAt: iso(row.lastExitedAt),
    lastExitCode: row.lastExitCode,
    lastError: row.lastError,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    host: hostResponse(host),
    health: runtime.health,
    runtime,
  };
}

function actionResponse(row: ActionRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    serviceId: row.serviceId,
    type: row.type,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    policyId: row.policyId,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    error: row.error,
  };
}

async function findService(id: string): Promise<ServiceRow | undefined> {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.isActive, true)))
    .limit(1);
  return row;
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.includes("SQLITE_CONSTRAINT");
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/services", { preHandler: requireAuth }, async (request) => {
    const query = serviceListQuerySchema.parse(request.query);
    const rows = await db
      .select()
      .from(services)
      .where(
        and(
          eq(services.isActive, true),
          query.hostId ? eq(services.hostId, query.hostId) : undefined,
          query.status ? eq(services.status, query.status) : undefined,
        ),
      )
      .orderBy(services.name);
    const hostRows = await db.select().from(hosts);
    const hostMap = new Map(hostRows.map((row) => [row.id, row]));
    return rows.map((row) => serviceResponse(row, hostMap.get(row.hostId)));
  });

  app.get(
    "/services/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const service = await findService(id);
      if (!service) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }
      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, service.hostId))
        .limit(1);
      const recent = await db
        .select()
        .from(actions)
        .where(eq(actions.serviceId, id))
        .orderBy(desc(actions.startedAt))
        .limit(20);
      return {
        ...serviceResponse(service, host),
        recentActions: recent.map(actionResponse),
      };
    },
  );

  app.post(
    "/services",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const body = serviceCreateSchema.parse(request.body);
      const user = actor(request);

      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, body.hostId))
        .limit(1);
      if (!host) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "ホストが見つかりません",
        );
      }

      const allowed = isCommandAllowed(body.command);
      if (!allowed.ok) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          allowed.reason ?? "コマンドが許可されていません",
        );
      }

      const now = new Date();
      const id = randomUUID();
      try {
        await db.insert(services).values({
          id,
          hostId: body.hostId,
          name: body.name,
          command: body.command,
          cwd: body.cwd ?? null,
          env: body.env ?? null,
          expectedPorts: body.expectedPorts ?? null,
          healthCheck: body.healthCheck ?? null,
          dependsOn: body.dependsOn ?? null,
          autoStart: body.autoStart,
          autoRestartPhase: body.autoRestartPhase,
          status: "stopped",
          createdAt: now,
          updatedAt: now,
          isActive: true,
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return problem(
            reply,
            409,
            "Conflict",
            "同じホストに同名のサービスが既にあります",
          );
        }
        throw error;
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.create",
        target: `service:${id}`,
        after: {
          hostId: body.hostId,
          name: body.name,
          command: body.command,
          expectedPorts: body.expectedPorts ?? null,
        },
        ip: request.ip,
      });

      const [created] = await db
        .select()
        .from(services)
        .where(eq(services.id, id))
        .limit(1);
      return reply.code(201).send(
        serviceResponse(
          created ?? {
            id,
            hostId: body.hostId,
            name: body.name,
            command: body.command,
            cwd: body.cwd ?? null,
            env: body.env ?? null,
            expectedPorts: body.expectedPorts ?? null,
            healthCheck: body.healthCheck ?? null,
            dependsOn: body.dependsOn ?? null,
            autoStart: body.autoStart,
            autoRestartPhase: body.autoRestartPhase,
            status: "stopped",
            pid: null,
            pidScope: null,
            lastStartedAt: null,
            lastExitedAt: null,
            lastExitCode: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
            isActive: true,
          },
          host,
        ),
      );
    },
  );

  app.patch(
    "/services/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = serviceUpdateSchema.parse(request.body);
      const user = actor(request);
      const existing = await findService(id);
      if (!existing) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      if (body.command !== undefined) {
        const allowed = isCommandAllowed(body.command);
        if (!allowed.ok) {
          return problem(
            reply,
            422,
            "Unprocessable Entity",
            allowed.reason ?? "コマンドが許可されていません",
          );
        }
      }

      const runtime = runtimeInfo(id);
      if (
        runtime.running &&
        (body.command !== undefined ||
          body.cwd !== undefined ||
          body.env !== undefined)
      ) {
        return problem(
          reply,
          409,
          "Conflict",
          "実行中は command / cwd / env を変更できません。停止してから更新してください",
        );
      }

      const updates: Partial<typeof services.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.name !== undefined) updates.name = body.name;
      if (body.command !== undefined) updates.command = body.command;
      if (body.cwd !== undefined) updates.cwd = body.cwd;
      if (body.env !== undefined) updates.env = body.env;
      if (body.expectedPorts !== undefined) {
        updates.expectedPorts = body.expectedPorts;
      }
      if (body.healthCheck !== undefined)
        updates.healthCheck = body.healthCheck;
      if (body.dependsOn !== undefined) updates.dependsOn = body.dependsOn;
      if (body.autoStart !== undefined) updates.autoStart = body.autoStart;
      if (body.autoRestartPhase !== undefined) {
        updates.autoRestartPhase = body.autoRestartPhase;
      }

      try {
        await db.update(services).set(updates).where(eq(services.id, id));
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return problem(
            reply,
            409,
            "Conflict",
            "同じホストに同名のサービスが既にあります",
          );
        }
        throw error;
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.update",
        target: `service:${id}`,
        before: {
          name: existing.name,
          command: existing.command,
          cwd: existing.cwd,
          expectedPorts: existing.expectedPorts,
          autoStart: existing.autoStart,
          autoRestartPhase: existing.autoRestartPhase,
        },
        after: {
          name: body.name ?? existing.name,
          command: body.command ?? existing.command,
          cwd: body.cwd !== undefined ? body.cwd : existing.cwd,
          expectedPorts:
            body.expectedPorts !== undefined
              ? body.expectedPorts
              : existing.expectedPorts,
          autoStart: body.autoStart ?? existing.autoStart,
          autoRestartPhase: body.autoRestartPhase ?? existing.autoRestartPhase,
        },
        ip: request.ip,
      });

      const updated = await findService(id);
      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, (updated ?? existing).hostId))
        .limit(1);
      return serviceResponse(updated ?? existing, host);
    },
  );

  app.delete(
    "/services/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const existing = await findService(id);
      if (!existing) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      const runtime = runtimeInfo(id);
      if (
        runtime.running ||
        ["starting", "running", "degraded", "restarting"].includes(
          existing.status,
        )
      ) {
        return problem(
          reply,
          409,
          "Conflict",
          "実行中のサービスは削除できません。先に停止してください",
        );
      }

      await db
        .update(services)
        .set({
          isActive: false,
          status: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(services.id, id));

      const sources = await db
        .select()
        .from(logSources)
        .where(eq(logSources.serviceId, id));
      if (sources.length > 0) {
        await db
          .update(logSources)
          .set({ enabled: false })
          .where(eq(logSources.serviceId, id));
        for (const source of sources) await refreshLogTailer(source.id);
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.delete",
        target: `service:${id}`,
        before: {
          hostId: existing.hostId,
          name: existing.name,
          command: existing.command,
        },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );

  async function performAction(
    request: FastifyRequest,
    reply: FastifyReply,
    type: "start" | "stop" | "restart",
    run: () => Promise<ServiceRow>,
  ) {
    const { id } = idParamsSchema.parse(request.params);
    const user = actor(request);
    const existing = await findService(id);
    if (!existing) {
      return problem(reply, 404, "Not Found", "サービスが見つかりません");
    }

    const startedAt = new Date();
    const actionId = randomUUID();
    await db.insert(actions).values({
      id: actionId,
      incidentId: null,
      serviceId: id,
      type,
      status: "running",
      requestedBy: user.id,
      approvedBy: null,
      policyId: null,
      startedAt,
      finishedAt: null,
      error: null,
    });

    try {
      const service = await run();
      const finishedAt = new Date();
      await db
        .update(actions)
        .set({ status: "succeeded", finishedAt })
        .where(eq(actions.id, actionId));

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: `service.${type}`,
        target: `service:${id}`,
        after: {
          actionId,
          name: service.name,
          status: service.status,
          pid: service.pid,
        },
        ip: request.ip,
      });

      const [action] = await db
        .select()
        .from(actions)
        .where(eq(actions.id, actionId))
        .limit(1);
      return reply.code(202).send(
        action
          ? actionResponse(action)
          : {
              id: actionId,
              incidentId: null,
              serviceId: id,
              type,
              status: "succeeded",
              requestedBy: user.id,
              approvedBy: null,
              policyId: null,
              startedAt: startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              error: null,
            },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date();
      await db
        .update(actions)
        .set({
          status: "failed",
          finishedAt,
          error: message.slice(0, 2000),
        })
        .where(eq(actions.id, actionId));

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: `service.${type}.failed`,
        target: `service:${id}`,
        after: { actionId },
        reason: message.slice(0, 500),
        ip: request.ip,
      });

      const status = error instanceof ServiceError ? error.statusCode : 409;
      return problem(reply, status, "Conflict", message);
    }
  }

  app.post(
    "/services/:id/start",
    { preHandler: requireRole("operator", "admin") },
    async (request, reply) =>
      performAction(request, reply, "start", () => {
        const { id } = idParamsSchema.parse(request.params);
        return startService(id);
      }),
  );

  app.post(
    "/services/:id/stop",
    { preHandler: requireRole("operator", "admin") },
    async (request, reply) =>
      performAction(request, reply, "stop", () => {
        const { id } = idParamsSchema.parse(request.params);
        return stopService(id);
      }),
  );

  app.post(
    "/services/:id/restart",
    { preHandler: requireRole("operator", "admin") },
    async (request, reply) =>
      performAction(request, reply, "restart", () => {
        const { id } = idParamsSchema.parse(request.params);
        return restartService(id);
      }),
  );

  app.get(
    "/services/:id/health",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      try {
        return await checkServiceHealth(id);
      } catch (error) {
        if (error instanceof ServiceError) {
          return problem(reply, error.statusCode, "Not Found", error.message);
        }
        throw error;
      }
    },
  );
}
