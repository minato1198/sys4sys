import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";

const managerMocks = vi.hoisted(() => ({
  restartService: vi.fn(),
  startService: vi.fn(),
  stopService: vi.fn(),
  checkServiceHealth: vi.fn(),
}));

vi.mock("../services/manager.js", () => managerMocks);

type Db = typeof import("../db/index.js").db;
type Schema = typeof import("../db/schema.js");

let tempDir: string;
let db: Db;
let schema: Schema;
let reconcile: (typeof import("./action-reconciliation.js"))["reconcileInterruptedActions"];

async function seedService(
  status: Schema["services"]["$inferSelect"]["status"] = "running",
): Promise<Schema["services"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.services)
    .values({
      id,
      hostId: randomUUID(),
      name: `svc-${id.slice(0, 8)}`,
      command: ["node"],
      healthCheck: { type: "http", url: "http://127.0.0.1:1/health" },
      status,
      pid: status === "running" ? 1234 : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  return row!;
}

async function seedIncident(
  serviceId: string,
  status: Schema["incidents"]["$inferSelect"]["status"] = "open",
): Promise<Schema["incidents"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.incidents)
    .values({
      id,
      serviceId,
      fingerprint: `fp-${id}`,
      title: "service unavailable",
      severity: "error",
      status,
      startedAt: new Date(),
      detectedBy: "rule",
      restartAttempts: 0,
      summary: null,
    })
    .returning();
  return row!;
}

async function seedProposal(input: {
  incident: Schema["incidents"]["$inferSelect"];
  service: Schema["services"]["$inferSelect"];
  status: "approved" | "executing";
  actionId?: string | null;
}): Promise<Schema["incidentActionProposals"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.incidentActionProposals)
    .values({
      id,
      incidentId: input.incident.id,
      analysisId: randomUUID(),
      serviceId: input.service.id,
      actionType: "restart",
      status: input.status,
      risk: "medium",
      confidence: 0.9,
      rationale: "restart the service",
      parameters: null,
      snapshot: {
        serviceName: input.service.name,
        serviceStatus: input.service.status,
      },
      dedupeKey: randomUUID(),
      sortOrder: 0,
      analysisRequestedBy: null,
      approvalId: null,
      actionId: input.actionId ?? null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      decidedAt: new Date(),
      executedAt: input.status === "executing" ? new Date() : null,
      error: null,
    })
    .returning();
  return row!;
}

async function seedAction(input: {
  incident: Schema["incidents"]["$inferSelect"];
  service: Schema["services"]["$inferSelect"];
  status: "pending" | "running";
  type: "restart" | "start" | "deploy";
  proposalId?: string | null;
  source?: "manual" | "ai_approved";
}): Promise<Schema["actions"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.actions)
    .values({
      id,
      incidentId: input.incident.id,
      serviceId: input.service.id,
      type: input.type,
      status: input.status,
      requestedBy:
        input.source === "ai_approved" ? "system:ai" : "operator@example.com",
      approvedBy: null,
      proposalId: input.proposalId ?? null,
      approvalId: null,
      source: input.source ?? "manual",
      startedAt: new Date(),
    })
    .returning();
  return row!;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-action-reconcile-"));
  process.env.DATABASE_URL = join(tempDir, "reconcile.db");
  process.env.LOG_LEVEL = "silent";
  process.env.MONITOR_ENABLED = "false";
  process.env.AI_ACTION_EXECUTION_ENABLED = "true";
  process.env.APPROVAL_EXPIRY_SWEEP_INTERVAL_MS = "0";

  const { migrateDb } = await import("../db/migrate.js");
  migrateDb();

  db = (await import("../db/index.js")).db;
  schema = await import("../db/schema.js");
  reconcile = (await import("./action-reconciliation.js"))
    .reconcileInterruptedActions;
});

afterAll(async () => {
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("stale incident action reconciliation", () => {
  it("fails pending AI proposal actions after a restart", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "approval");
    const action = await seedAction({
      incident,
      service,
      status: "pending",
      type: "restart",
      source: "ai_approved",
    });
    const proposal = await seedProposal({
      incident,
      service,
      status: "approved",
      actionId: action.id,
    });
    await db
      .update(schema.actions)
      .set({ proposalId: proposal.id })
      .where(eq(schema.actions.id, action.id));

    await reconcile();

    const [storedAction] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, action.id));
    expect(storedAction!.status).toBe("failed");
    expect(storedAction!.error).toContain("API が再起動");

    const [storedProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, proposal.id));
    expect(storedProposal!.status).toBe("failed");

    const [storedIncident] = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, incident.id));
    expect(storedIncident!.status).toBe("open");

    const events = await db
      .select({ type: schema.incidentEvents.type })
      .from(schema.incidentEvents)
      .where(
        and(
          eq(schema.incidentEvents.incidentId, incident.id),
          eq(schema.incidentEvents.type, "ai_action_stale"),
        ),
      );
    expect(events).toHaveLength(1);

    const audits = await db
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, "ai.action.stale"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("fails approved proposals without a matching action", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "approval");
    const proposal = await seedProposal({
      incident,
      service,
      status: "approved",
      actionId: null,
    });

    await reconcile();

    const [storedProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, proposal.id));
    expect(storedProposal!.status).toBe("failed");
    expect(storedProposal!.error).toContain("API が再起動");
  });

  it("fails stale legacy non-deploy actions and leaves deploy actions alone", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "open");
    const legacy = await seedAction({
      incident,
      service,
      status: "running",
      type: "restart",
    });
    const deploy = await seedAction({
      incident,
      service,
      status: "pending",
      type: "deploy",
    });

    await reconcile();

    const [storedLegacy] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, legacy.id));
    expect(storedLegacy!.status).toBe("failed");

    const [storedDeploy] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, deploy.id));
    expect(storedDeploy!.status).toBe("pending");
  });
});
