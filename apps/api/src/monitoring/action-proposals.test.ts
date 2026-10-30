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
type Monitoring = typeof import("./incidents.js");
type Proposals = typeof import("./action-proposals.js");

let tempDir: string;
let db: Db;
let schema: Schema;
let monitoring: Monitoring;
let proposals: Proposals;

const operator = {
  id: "usr-operator",
  email: "operator@example.com",
  role: "operator" as const,
};
const admin = {
  id: "usr-admin",
  email: "admin@example.com",
  role: "admin" as const,
};
const otherOperator = {
  id: "usr-operator-2",
  email: "operator2@example.com",
  role: "operator" as const,
};

function result(
  actions: Array<{
    type: string;
    target?: string;
    detail?: string;
    risk?: "none" | "low" | "medium" | "high";
  }>,
  confidence = 0.9,
): import("@sys4sys/ai").AnalysisResult {
  return {
    severity: "error",
    category: "availability",
    summary: "service is unavailable",
    root_cause_hypothesis: "the process exited",
    evidence: [],
    recommended_actions: actions.map((action) => ({
      ...action,
      risk: action.risk ?? "none",
    })),
    confidence,
    needs_human: true,
  };
}

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
  actionType?: "restart" | "start" | "stop";
  status?: Schema["incidentActionProposals"]["$inferSelect"]["status"];
  risk?: "low" | "medium" | "high";
  analysisRequestedBy?: string | null;
  expiresAt?: Date;
}): Promise<Schema["incidentActionProposals"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.incidentActionProposals)
    .values({
      id,
      incidentId: input.incident.id,
      analysisId: randomUUID(),
      serviceId: input.service.id,
      actionType: input.actionType ?? "restart",
      status: input.status ?? "proposed",
      risk: input.risk ?? "low",
      confidence: 0.9,
      rationale: "restart the service",
      parameters: null,
      snapshot: {
        serviceName: input.service.name,
        serviceStatus: input.service.status,
      },
      dedupeKey: randomUUID(),
      sortOrder: 0,
      analysisRequestedBy: input.analysisRequestedBy ?? null,
      approvalId: null,
      actionId: null,
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
      decidedAt: null,
      executedAt: null,
      error: null,
    })
    .returning();
  return row!;
}

async function seedApproval(input: {
  incident: Schema["incidents"]["$inferSelect"];
  proposal: Schema["incidentActionProposals"]["$inferSelect"];
  requestedBy?: string | null;
  expiresAt?: Date;
}): Promise<Schema["approvals"]["$inferSelect"]> {
  const id = randomUUID();
  const [row] = await db
    .insert(schema.approvals)
    .values({
      id,
      incidentId: input.incident.id,
      proposalId: input.proposal.id,
      source: "ai",
      requestedAction: {
        type: input.proposal.actionType,
        serviceId: input.proposal.serviceId,
        proposalId: input.proposal.id,
        reason: input.proposal.rationale,
        risk: input.proposal.risk,
      },
      requestedBy: input.requestedBy ?? null,
      status: "pending",
      requestedAt: new Date(),
      expiresAt: input.expiresAt ?? input.proposal.expiresAt,
    })
    .returning();
  if (!row) throw new Error("approval seed failed");
  await db
    .update(schema.incidentActionProposals)
    .set({ status: "pending_approval", approvalId: id })
    .where(eq(schema.incidentActionProposals.id, input.proposal.id));
  await db
    .update(schema.incidents)
    .set({ status: "approval" })
    .where(eq(schema.incidents.id, input.incident.id));
  return row;
}

async function waitForAction(
  actionId: string,
  timeoutMs = 8_000,
): Promise<Schema["actions"]["$inferSelect"]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.id, actionId));
    if (row && (row.status === "succeeded" || row.status === "failed")) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("action did not finish");
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-ai-actions-"));
  process.env.DATABASE_URL = join(tempDir, "ai-actions.db");
  process.env.LOG_LEVEL = "silent";
  process.env.MONITOR_ENABLED = "false";
  process.env.AI_ACTION_EXECUTION_ENABLED = "true";
  process.env.AI_ACTION_ALLOWED_TYPES = "restart,start";
  process.env.AI_ACTION_AUTO_REQUEST_APPROVAL = "true";
  process.env.AI_ACTION_MIN_CONFIDENCE = "0.5";
  process.env.AI_ACTION_TTL_MIN = "30";
  process.env.AI_ACTION_STOP_ENABLED = "false";
  process.env.AI_ACTION_HIGH_RISK_REQUIRE_ADMIN = "true";
  process.env.AUTO_RESTART_VERIFY_TIMEOUT_SEC = "5";

  const { migrateDb } = await import("../db/migrate.js");
  migrateDb();

  db = (await import("../db/index.js")).db;
  schema = await import("../db/schema.js");
  monitoring = await import("./incidents.js");
  proposals = await import("./action-proposals.js");

  managerMocks.restartService.mockImplementation(async (serviceId: string) => {
    await db
      .update(schema.services)
      .set({ status: "running", pid: 2345, updatedAt: new Date() })
      .where(eq(schema.services.id, serviceId));
  });
  managerMocks.startService.mockImplementation(async (serviceId: string) => {
    await db
      .update(schema.services)
      .set({ status: "running", pid: 3456, updatedAt: new Date() })
      .where(eq(schema.services.id, serviceId));
  });
  managerMocks.stopService.mockImplementation(async (serviceId: string) => {
    await db
      .update(schema.services)
      .set({ status: "stopped", pid: null, updatedAt: new Date() })
      .where(eq(schema.services.id, serviceId));
  });
  managerMocks.checkServiceHealth.mockResolvedValue({
    status: "healthy",
    detail: "healthy",
  });
});

afterAll(async () => {
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("AI action proposal safety", () => {
  it("materializes only allowed actions and auto-selects start for a stopped service", async () => {
    const service = await seedService("stopped");
    const incident = await seedIncident(service.id);
    const created = await proposals.materializeActionProposals({
      incident,
      service,
      analysis: {
        id: randomUUID(),
        provider: "openai-compatible",
        model: "test-model",
        promptVersion: "test-prompt",
        confidence: 0.9,
      },
      result: result([
        { type: "restart", target: service.name, risk: "low" },
        { type: "start", target: service.name, risk: "medium" },
        { type: "stop", target: service.name, risk: "high" },
        { type: "deploy", target: service.name, risk: "high" },
        { type: "restart", target: "another-service", risk: "low" },
      ]),
      analysisRequestedBy: null,
    });

    expect(created.map((row) => row.actionType).sort()).toEqual([
      "restart",
      "start",
    ]);
    const rows = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.incidentId, incident.id));
    expect(rows).toHaveLength(2);
    const pending = rows.find((row) => row.status === "pending_approval");
    expect(pending?.actionType).toBe("start");

    const [approval] = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.incidentId, incident.id),
          eq(schema.approvals.status, "pending"),
        ),
      );
    expect(approval?.source).toBe("ai");
    expect(approval?.requestedBy).toBeNull();
    expect(approval?.expiresAt?.getTime()).toBe(pending?.expiresAt.getTime());
    const ttlMinutes =
      ((approval?.expiresAt?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(ttlMinutes).toBeGreaterThan(29);
    expect(ttlMinutes).toBeLessThan(31);

    const autoActions = await db
      .select()
      .from(schema.actions)
      .where(eq(schema.actions.incidentId, incident.id));
    expect(autoActions).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(schema.incidents)
          .where(eq(schema.incidents.id, incident.id))
      )[0]?.status,
    ).toBe("approval");
  });

  it("does not materialize from fallback analyses", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id);
    const created = await proposals.materializeActionProposals({
      incident,
      service,
      analysis: {
        id: randomUUID(),
        provider: "template",
        model: "rules-v1",
        promptVersion: "fallback-v1",
        confidence: 0.0,
      },
      result: result([{ type: "restart", target: service.name, risk: "low" }]),
      analysisRequestedBy: null,
    });
    expect(created).toHaveLength(0);
  });

  it("creates an explicit approval and refuses self-approval", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id);
    const proposal = await seedProposal({ incident, service });
    const result = await proposals.requestProposalApproval(
      proposal.id,
      operator,
      "please approve",
    );
    expect(result.approval.source).toBe("ai");
    expect(result.approval.requestedBy).toBe(operator.id);
    expect(result.proposal.status).toBe("pending_approval");

    await expect(
      monitoring.decideApproval(result.approval.id, "approved", operator),
    ).rejects.toMatchObject({ statusCode: 403 });

    const rejected = await monitoring.decideApproval(
      result.approval.id,
      "rejected",
      otherOperator,
      "not now",
    );
    expect(rejected.approval.status).toBe("rejected");
    expect(rejected.proposal?.status).toBe("rejected");
    expect(rejected.incident.status).toBe("open");
  });

  it("requires admin approval for high risk proposals", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "approval");
    const proposal = await seedProposal({
      incident,
      service,
      risk: "high",
    });
    const approval = await seedApproval({ incident, proposal });
    const other = await seedProposal({
      incident,
      service,
      actionType: "start",
      risk: "low",
    });

    await expect(
      monitoring.decideApproval(approval.id, "approved", operator),
    ).rejects.toMatchObject({ statusCode: 403 });

    const decided = await monitoring.decideApproval(
      approval.id,
      "approved",
      admin,
    );
    expect(decided.action?.source).toBe("ai_approved");
    expect(decided.action?.requestedBy).toBe("system:ai");
    expect(decided.action?.proposalId).toBe(proposal.id);
    expect(decided.action?.approvalId).toBe(approval.id);

    const finished = await waitForAction(decided.action!.id);
    expect(finished.status).toBe("succeeded");
    expect(managerMocks.restartService).toHaveBeenCalledTimes(1);

    const [storedProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, proposal.id));
    expect(storedProposal!.status).toBe("succeeded");
    const [otherProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, other.id));
    expect(otherProposal!.status).toBe("superseded");
    const [storedIncident] = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, incident.id));
    expect(storedIncident!.status).toBe("resolved");

    await expect(
      monitoring.decideApproval(approval.id, "approved", admin),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(managerMocks.restartService).toHaveBeenCalledTimes(1);
  });

  it("executes an approved start through the deterministic service path", async () => {
    const service = await seedService("stopped");
    const incident = await seedIncident(service.id, "approval");
    const proposal = await seedProposal({
      incident,
      service,
      actionType: "start",
    });
    const approval = await seedApproval({ incident, proposal });
    const callsBefore = managerMocks.startService.mock.calls.length;

    const decided = await monitoring.decideApproval(
      approval.id,
      "approved",
      admin,
    );
    const finished = await waitForAction(decided.action!.id);
    expect(finished.status).toBe("succeeded");
    expect(managerMocks.startService).toHaveBeenCalledTimes(callsBefore + 1);
    expect(managerMocks.restartService).not.toHaveBeenCalledWith(service.id);

    const [storedProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, proposal.id));
    expect(storedProposal!.status).toBe("succeeded");
    const [storedIncident] = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, incident.id));
    expect(storedIncident!.status).toBe("resolved");
  });

  it("does not retry a failed AI action", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "approval");
    const proposal = await seedProposal({ incident, service });
    const approval = await seedApproval({ incident, proposal });
    const callsBefore = managerMocks.restartService.mock.calls.length;
    managerMocks.restartService.mockRejectedValueOnce(new Error("boom"));

    const decided = await monitoring.decideApproval(
      approval.id,
      "approved",
      admin,
    );
    const finished = await waitForAction(decided.action!.id);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("boom");
    expect(managerMocks.restartService).toHaveBeenCalledTimes(callsBefore + 1);

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
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(managerMocks.restartService).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("expires an approval and proposal when the TTL has elapsed", async () => {
    const service = await seedService("running");
    const incident = await seedIncident(service.id, "approval");
    const proposal = await seedProposal({ incident, service });
    const approval = await seedApproval({
      incident,
      proposal,
      expiresAt: new Date(Date.now() - 60_000),
    });

    await expect(
      monitoring.decideApproval(approval.id, "approved", admin),
    ).rejects.toMatchObject({ statusCode: 409 });

    const [storedApproval] = await db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, approval.id));
    expect(storedApproval!.status).toBe("expired");
    const [storedProposal] = await db
      .select()
      .from(schema.incidentActionProposals)
      .where(eq(schema.incidentActionProposals.id, proposal.id));
    expect(storedProposal!.status).toBe("expired");
    const [storedIncident] = await db
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.id, incident.id));
    expect(storedIncident!.status).toBe("open");
  });
});
