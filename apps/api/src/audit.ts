import { randomUUID } from "node:crypto";
import { db } from "./db/index.js";
import { auditLogs } from "./db/schema.js";

export interface AuditEntry {
  actorUserId?: string | null;
  actorLabel: string;
  action: string;
  target: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  ip?: string | null;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    id: randomUUID(),
    actorUserId: entry.actorUserId ?? null,
    actorLabel: entry.actorLabel,
    action: entry.action,
    target: entry.target,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    ip: entry.ip ?? null,
    ts: new Date(),
  });
}
