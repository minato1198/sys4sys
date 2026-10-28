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

/**
 * 外部操作の結果を監査ログの保存失敗で覆さないための best-effort 書き込み。
 * entry の内容（秘密値を含み得る）はログに出さない。
 */
export async function tryWriteAudit(entry: AuditEntry): Promise<void> {
  try {
    await writeAudit(entry);
  } catch (error) {
    console.warn(
      `[audit] audit.write_failed action=${entry.action}: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
  }
}
