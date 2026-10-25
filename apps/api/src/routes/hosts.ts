import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { hostCreateSchema, hostUpdateSchema } from "@sys4sys/shared";
import type { WslDistro } from "@sys4sys/agent";
import { listDistroStates } from "@sys4sys/agent";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { hosts } from "../db/schema.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type HostRow = typeof hosts.$inferSelect;

function normalizeState(
  distro: WslDistro | undefined,
): "running" | "stopped" | "unknown" {
  if (!distro) return "unknown";
  if (distro.state === "Running") return "running";
  if (distro.state === "Stopped") return "stopped";
  return "unknown";
}

function hostResponse(row: HostRow, distro: WslDistro | undefined) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    distro: row.distro,
    defaultUser: row.defaultUser,
    enabled: row.enabled,
    state: row.kind === "windows" ? "running" : normalizeState(distro),
    distroState: distro?.state ?? null,
  };
}

async function detectDistros(): Promise<WslDistro[]> {
  return listDistroStates();
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

export async function hostRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/hosts",
    { preHandler: requireAuth, config: { scopes: ["hosts:read"] } },
    async () => {
      const rows = await db
        .select()
        .from(hosts)
        .orderBy(hosts.kind, hosts.name);
      let distros: WslDistro[] = [];
      try {
        distros = await detectDistros();
      } catch {
        distros = [];
      }
      const byName = new Map(distros.map((distro) => [distro.name, distro]));
      return rows.map((row) =>
        hostResponse(row, row.distro ? byName.get(row.distro) : undefined),
      );
    },
  );

  app.get(
    "/hosts/:id",
    { preHandler: requireAuth, config: { scopes: ["hosts:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const [row] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, id))
        .limit(1);
      if (!row) {
        return problem(reply, 404, "Not Found", "ホストが見つかりません");
      }

      let distro: WslDistro | undefined;
      if (row.kind === "wsl" && row.distro) {
        try {
          distro = (await detectDistros()).find(
            (candidate) => candidate.name === row.distro,
          );
        } catch {
          distro = undefined;
        }
      }

      return hostResponse(row, distro);
    },
  );

  app.post(
    "/hosts/wsl/detect",
    { preHandler: requireRole("admin"), config: { scopes: ["hosts:write"] } },
    async (_request, reply) => {
      try {
        const [distros, registered] = await Promise.all([
          detectDistros(),
          db.select().from(hosts).where(eq(hosts.kind, "wsl")),
        ]);
        const names = new Set(registered.map((row) => row.distro));
        return distros.map((distro) => ({
          ...distro,
          registered: names.has(distro.name),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return problem(
          reply,
          502,
          "Bad Gateway",
          `WSL ディストロを検出できませんでした: ${message}`,
        );
      }
    },
  );

  app.post(
    "/hosts",
    { preHandler: requireRole("admin"), config: { scopes: ["hosts:write"] } },
    async (request, reply) => {
      const body = hostCreateSchema.parse(request.body);
      const user = request.authUser;
      if (!user) return reply.code(401).send();

      if (body.kind === "windows") {
        const existing = await db
          .select()
          .from(hosts)
          .where(eq(hosts.kind, "windows"))
          .limit(1);
        if (existing.length > 0) {
          return problem(
            reply,
            409,
            "Conflict",
            "Windows ホストは既に登録されています",
          );
        }
      } else {
        const existing = await db
          .select()
          .from(hosts)
          .where(
            and(eq(hosts.kind, "wsl"), eq(hosts.distro, body.distro ?? "")),
          )
          .limit(1);
        if (existing.length > 0) {
          return problem(
            reply,
            409,
            "Conflict",
            `${body.distro} は既に登録されています`,
          );
        }

        try {
          const distros = await detectDistros();
          if (!distros.some((distro) => distro.name === body.distro)) {
            return problem(
              reply,
              422,
              "Unprocessable Entity",
              `${body.distro} は検出できません。先に WSL を検出してください`,
            );
          }
        } catch {
          // WSL が利用できない環境では登録自体は許可する（後で有効化できる）
        }
      }

      const id = randomUUID();
      await db.insert(hosts).values({
        id,
        kind: body.kind,
        name: body.name,
        distro: body.kind === "wsl" ? (body.distro ?? null) : null,
        defaultUser: body.defaultUser ?? null,
        enabled: body.enabled,
      });

      let distro: WslDistro | undefined;
      if (body.kind === "wsl" && body.distro) {
        try {
          distro = (await detectDistros()).find(
            (candidate) => candidate.name === body.distro,
          );
        } catch {
          distro = undefined;
        }
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "host.create",
        target: `host:${id}`,
        after: {
          kind: body.kind,
          name: body.name,
          distro: body.distro ?? null,
          defaultUser: body.defaultUser ?? null,
          enabled: body.enabled,
        },
        ip: request.ip,
      });

      return reply.code(201).send(
        hostResponse(
          {
            id,
            kind: body.kind,
            name: body.name,
            distro: body.kind === "wsl" ? (body.distro ?? null) : null,
            defaultUser: body.defaultUser ?? null,
            enabled: body.enabled,
          },
          distro,
        ),
      );
    },
  );

  app.patch(
    "/hosts/:id",
    { preHandler: requireRole("admin"), config: { scopes: ["hosts:write"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = hostUpdateSchema.parse(request.body);
      const user = request.authUser;
      if (!user) return reply.code(401).send();

      const [existing] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, id))
        .limit(1);
      if (!existing) {
        return problem(reply, 404, "Not Found", "ホストが見つかりません");
      }

      const updates: {
        name?: string;
        defaultUser?: string | null;
        enabled?: boolean;
      } = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.defaultUser !== undefined) {
        updates.defaultUser = body.defaultUser;
      }
      if (body.enabled !== undefined) updates.enabled = body.enabled;

      if (Object.keys(updates).length > 0) {
        await db.update(hosts).set(updates).where(eq(hosts.id, id));
      }

      const [updated] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, id))
        .limit(1);

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "host.update",
        target: `host:${id}`,
        before: {
          name: existing.name,
          defaultUser: existing.defaultUser,
          enabled: existing.enabled,
        },
        after: {
          name: updated?.name ?? existing.name,
          defaultUser: updated ? updated.defaultUser : existing.defaultUser,
          enabled: updated?.enabled ?? existing.enabled,
        },
        ip: request.ip,
      });

      let distro: WslDistro | undefined;
      if (updated?.kind === "wsl" && updated.distro) {
        try {
          distro = (await detectDistros()).find(
            (candidate) => candidate.name === updated.distro,
          );
        } catch {
          distro = undefined;
        }
      }

      return hostResponse(updated ?? existing, distro);
    },
  );
}
