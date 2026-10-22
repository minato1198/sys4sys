import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  logQuerySchema,
  logSourceCreateSchema,
  logSourceUpdateSchema,
  logStreamQuerySchema,
} from "@sys4sys/shared";
import { and, desc, eq, gte, like, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { hosts, logEvents, logSources, services } from "../db/schema.js";
import { subscribeLogs } from "../logs/bus.js";
import type { LogEventView } from "../logs/ingest.js";
import { refreshLogTailer } from "../logs/tailers.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type HostRow = typeof hosts.$inferSelect;
type LogSourceRow = typeof logSources.$inferSelect;

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

function logSourceResponse(
  row: LogSourceRow,
  host: HostRow | undefined,
  serviceName: string | null,
) {
  return {
    id: row.id,
    hostId: row.hostId,
    serviceId: row.serviceId,
    type: row.type,
    config: row.config,
    enabled: row.enabled,
    hostName: host?.name ?? null,
    hostKind: host?.kind ?? null,
    serviceName,
  };
}

function matchesStream(query: z.infer<typeof logStreamQuerySchema>) {
  const from = query.from ? new Date(query.from).getTime() : null;
  const to = query.to ? new Date(query.to).getTime() : null;
  const needle = query.q?.toLowerCase();
  return (event: LogEventView): boolean => {
    if (query.hostId && event.hostId !== query.hostId) return false;
    if (query.serviceId && event.serviceId !== query.serviceId) return false;
    if (query.level && event.level !== query.level) return false;
    if (needle && !event.message.toLowerCase().includes(needle)) return false;
    const ts = new Date(event.ts).getTime();
    if (from !== null && ts < from) return false;
    if (to !== null && ts > to) return false;
    return true;
  };
}

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get("/logs", { preHandler: requireAuth }, async (request) => {
    const query = logQuerySchema.parse(request.query);
    const conditions = [
      query.hostId ? eq(logEvents.hostId, query.hostId) : undefined,
      query.serviceId ? eq(logEvents.serviceId, query.serviceId) : undefined,
      query.level ? eq(logEvents.level, query.level) : undefined,
      query.q ? like(logEvents.message, `%${query.q}%`) : undefined,
      query.from ? gte(logEvents.ts, new Date(query.from)) : undefined,
      query.to ? lte(logEvents.ts, new Date(query.to)) : undefined,
      query.cursor ? lt(logEvents.ts, new Date(query.cursor)) : undefined,
    ];

    const rows = await db
      .select()
      .from(logEvents)
      .where(and(...conditions))
      .orderBy(desc(logEvents.ts))
      .limit(query.limit);

    const items = rows.map((row) => ({
      id: row.id,
      hostId: row.hostId,
      serviceId: row.serviceId,
      ts: row.ts.toISOString(),
      level: row.level,
      stream: row.stream,
      message: row.message,
      fields: row.fields ?? null,
      fingerprint: row.fingerprint,
    }));

    return {
      items,
      nextCursor:
        items.length === query.limit
          ? (items[items.length - 1]?.ts ?? null)
          : null,
    };
  });

  app.get(
    "/logs/stream",
    { preHandler: requireAuth },
    async (request, reply) => {
      const query = logStreamQuerySchema.parse(request.query);
      const matches = matchesStream(query);

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      reply.raw.write(": connected\n\n");

      const unsubscribe = subscribeLogs((event) => {
        if (!matches(event)) return;
        try {
          reply.raw.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          // 接続が切れた場合は close ハンドラで掃除する
        }
      });

      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": keep-alive\n\n");
        } catch {
          // ignore
        }
      }, 15_000);
      heartbeat.unref();

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          reply.raw.end();
        } catch {
          // already closed
        }
      };
      request.raw.once("close", cleanup);
      request.raw.once("error", cleanup);
      return reply;
    },
  );

  app.get("/logs/sources", { preHandler: requireAuth }, async () => {
    const rows = await db.select().from(logSources);
    const hostRows = await db.select().from(hosts);
    const serviceRows = await db.select().from(services);
    const hostMap = new Map(hostRows.map((row) => [row.id, row]));
    const serviceMap = new Map(serviceRows.map((row) => [row.id, row.name]));
    return rows.map((row) =>
      logSourceResponse(
        row,
        hostMap.get(row.hostId),
        row.serviceId ? (serviceMap.get(row.serviceId) ?? null) : null,
      ),
    );
  });

  app.post(
    "/logs/sources",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const body = logSourceCreateSchema.parse(request.body);
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
      if (body.type === "file" && host.kind !== "windows") {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "file ソースは Windows ホストにのみ登録できます。WSL は wsl_file を使ってください",
        );
      }
      if (body.type === "wsl_file" && host.kind !== "wsl") {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "wsl_file ソースは WSL ホストにのみ登録できます",
        );
      }
      if (body.type === "eventlog") {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "eventlog ソースはまだ実装されていません",
        );
      }

      if (body.serviceId) {
        const [service] = await db
          .select()
          .from(services)
          .where(
            and(eq(services.id, body.serviceId), eq(services.isActive, true)),
          )
          .limit(1);
        if (!service) {
          return problem(
            reply,
            422,
            "Unprocessable Entity",
            "サービスが見つかりません",
          );
        }
      }

      const id = randomUUID();
      await db.insert(logSources).values({
        id,
        hostId: body.hostId,
        serviceId: body.serviceId ?? null,
        type: body.type,
        config: body.config,
        enabled: body.enabled,
      });
      await refreshLogTailer(id);

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "log.source.create",
        target: `log-source:${id}`,
        after: {
          hostId: body.hostId,
          serviceId: body.serviceId ?? null,
          type: body.type,
          config: body.config,
          enabled: body.enabled,
        },
        ip: request.ip,
      });

      const [created] = await db
        .select()
        .from(logSources)
        .where(eq(logSources.id, id))
        .limit(1);
      return reply.code(201).send(
        logSourceResponse(
          created ?? {
            id,
            hostId: body.hostId,
            serviceId: body.serviceId ?? null,
            type: body.type,
            config: body.config,
            enabled: body.enabled,
          },
          host,
          null,
        ),
      );
    },
  );

  app.patch(
    "/logs/sources/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = logSourceUpdateSchema.parse(request.body);
      const user = actor(request);

      const [existing] = await db
        .select()
        .from(logSources)
        .where(eq(logSources.id, id))
        .limit(1);
      if (!existing) {
        return problem(reply, 404, "Not Found", "ログソースが見つかりません");
      }

      if (body.serviceId) {
        const [service] = await db
          .select()
          .from(services)
          .where(
            and(eq(services.id, body.serviceId), eq(services.isActive, true)),
          )
          .limit(1);
        if (!service) {
          return problem(
            reply,
            422,
            "Unprocessable Entity",
            "サービスが見つかりません",
          );
        }
      }

      const updates: Partial<typeof logSources.$inferInsert> = {};
      if (body.serviceId !== undefined) updates.serviceId = body.serviceId;
      if (body.config !== undefined) updates.config = body.config;
      if (body.enabled !== undefined) updates.enabled = body.enabled;
      if (Object.keys(updates).length > 0) {
        await db.update(logSources).set(updates).where(eq(logSources.id, id));
      }
      await refreshLogTailer(id);

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "log.source.update",
        target: `log-source:${id}`,
        before: {
          serviceId: existing.serviceId,
          config: existing.config,
          enabled: existing.enabled,
        },
        after: {
          serviceId:
            body.serviceId !== undefined ? body.serviceId : existing.serviceId,
          config: body.config ?? existing.config,
          enabled: body.enabled ?? existing.enabled,
        },
        ip: request.ip,
      });

      const [updated] = await db
        .select()
        .from(logSources)
        .where(eq(logSources.id, id))
        .limit(1);
      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, existing.hostId))
        .limit(1);
      return logSourceResponse(updated ?? existing, host, null);
    },
  );

  app.delete(
    "/logs/sources/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const [existing] = await db
        .select()
        .from(logSources)
        .where(eq(logSources.id, id))
        .limit(1);
      if (!existing) {
        return problem(reply, 404, "Not Found", "ログソースが見つかりません");
      }

      await db.delete(logSources).where(eq(logSources.id, id));
      await refreshLogTailer(id);

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "log.source.delete",
        target: `log-source:${id}`,
        before: {
          hostId: existing.hostId,
          serviceId: existing.serviceId,
          type: existing.type,
          config: existing.config,
        },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );
}
