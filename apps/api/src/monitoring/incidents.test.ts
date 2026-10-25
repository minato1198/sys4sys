import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

let tempDir: string;
let db: any;
let incidents: any;
let approvals: any;
let auditLogs: any;
let decideApproval: (
  id: string,
  decision: "approved" | "rejected",
  actor: { id: string; email: string },
  note?: string,
) => Promise<any>;

const actor = { id: "usr-decider", email: "decider@example.com" };

async function seedApproval(requestedBy: string | null): Promise<string> {
  const incidentId = randomUUID();
  const approvalId = randomUUID();

  await db.insert(incidents).values({
    id: incidentId,
    serviceId: "svc-missing",
    fingerprint: `fp-${incidentId}`,
    title: "approval test",
    severity: "error",
    status: "open",
    startedAt: new Date(),
    resolvedAt: null,
    detectedBy: "rule",
    restartAttempts: 0,
    summary: null,
  });

  await db.insert(approvals).values({
    id: approvalId,
    incidentId,
    requestedAction: {
      type: "restart",
      serviceId: "svc-missing",
      reason: "manual approval test",
    },
    requestedBy,
    status: "pending",
    requestedAt: new Date(),
  });

  return approvalId;
}

async function auditCount(action: string, target: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .all();
  return rows.filter((row: any) => row.target === target).length;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-approvals-"));
  process.env.DATABASE_URL = join(tempDir, "approvals.db");
  process.env.LOG_LEVEL = "silent";
  process.env.MONITOR_ENABLED = "false";

  const { migrateDb } = await import("../db/migrate.js");
  migrateDb();

  const dbMod = await import("../db/index.js");
  const schema = await import("../db/schema.js");
  const monitoring = await import("./incidents.js");

  db = dbMod.db;
  incidents = schema.incidents;
  approvals = schema.approvals;
  auditLogs = schema.auditLogs;
  decideApproval = monitoring.decideApproval;
});

afterAll(async () => {
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("approval decisions", () => {
  it("rejects a pending system approval and records audit", async () => {
    const approvalId = await seedApproval(null);
    const result = await decideApproval(approvalId, "rejected", actor, "no");
    expect(result.approval.status).toBe("rejected");
    expect(result.approval.decidedBy).toBe(actor.email);
    expect(
      await auditCount("approval.rejected", `approval:${approvalId}`),
    ).toBe(1);
  });

  it("returns 409 for a double decision", async () => {
    const approvalId = await seedApproval(null);
    await decideApproval(approvalId, "rejected", actor, "first");
    await expect(
      decideApproval(approvalId, "approved", actor, "second"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      decideApproval(approvalId, "rejected", actor, "third"),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("returns 403 when requestedBy matches the deciding user", async () => {
    const approvalId = await seedApproval(actor.id);
    await expect(
      decideApproval(approvalId, "approved", actor, "self"),
    ).rejects.toMatchObject({ statusCode: 403 });
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .all();
    expect(approval.status).toBe("pending");
  });

  it("allows a null requestedBy to be rejected by an operator", async () => {
    const approvalId = await seedApproval(null);
    const result = await decideApproval(approvalId, "rejected", actor);
    expect(result.approval.status).toBe("rejected");
  });
});
