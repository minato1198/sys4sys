import type { FastifyInstance } from "fastify";
import { auditLogQuerySchema } from "@sys4sys/shared";
import { and, desc, eq, gte, like, lte, or } from "drizzle-orm";
import { requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { auditLogs } from "../db/schema.js";

function auditResponse(row: typeof auditLogs.$inferSelect) {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorLabel: row.actorLabel,
    action: row.action,
    target: row.target,
    before: row.before,
    after: row.after,
    reason: row.reason,
    ip: row.ip,
    ts: row.ts.toISOString(),
  };
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/audit-logs",
    { preHandler: requireRole("admin"), config: { scopes: ["audit:read"] } },
    async (request) => {
      const query = auditLogQuerySchema.parse(request.query);
      const actor = query.actor?.trim();
      const where = and(
        actor
          ? or(
              like(auditLogs.actorLabel, `%${actor}%`),
              eq(auditLogs.actorUserId, actor),
            )
          : undefined,
        query.action
          ? like(auditLogs.action, `%${query.action.trim()}%`)
          : undefined,
        query.target
          ? like(auditLogs.target, `%${query.target.trim()}%`)
          : undefined,
        query.from ? gte(auditLogs.ts, new Date(query.from)) : undefined,
        query.to ? lte(auditLogs.ts, new Date(query.to)) : undefined,
      );
      const [rows, all] = await Promise.all([
        db
          .select()
          .from(auditLogs)
          .where(where)
          .orderBy(desc(auditLogs.ts))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ id: auditLogs.id }).from(auditLogs).where(where),
      ]);
      return {
        items: rows.map(auditResponse),
        total: all.length,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );
}
