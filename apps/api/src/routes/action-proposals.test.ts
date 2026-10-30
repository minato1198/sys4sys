import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let cookie: string;
let userId: string;
let db: any;
let schema: any;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

async function login(): Promise<{ cookie: string; id: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@sys4sys.local",
      password: "test-admin-password-123",
    },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { id: string };
  return {
    cookie: cookieHeader(response.headers["set-cookie"]),
    id: body.id,
  };
}

async function seedProposal(
  actionType: "restart" | "stop" = "restart",
): Promise<{
  incidentId: string;
  serviceId: string;
  proposalId: string;
}> {
  const serviceId = randomUUID();
  const incidentId = randomUUID();
  const proposalId = randomUUID();
  const serviceName = `svc-${serviceId.slice(0, 8)}`;
  await db.insert(schema.services).values({
    id: serviceId,
    hostId: randomUUID(),
    name: serviceName,
    command: ["node"],
    status: "running",
    pid: 1234,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.incidents).values({
    id: incidentId,
    serviceId,
    fingerprint: `fp-${incidentId}`,
    title: "proposal route test",
    severity: "error",
    status: "open",
    startedAt: new Date(),
    detectedBy: "rule",
    restartAttempts: 0,
    summary: null,
  });
  await db.insert(schema.incidentActionProposals).values({
    id: proposalId,
    incidentId,
    analysisId: randomUUID(),
    serviceId,
    actionType,
    status: "proposed",
    risk: actionType === "stop" ? "high" : "low",
    confidence: 0.9,
    rationale: "restart the service",
    snapshot: { serviceName, serviceStatus: "running" },
    dedupeKey: randomUUID(),
    sortOrder: 0,
    analysisRequestedBy: null,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });
  return { incidentId, serviceId, proposalId };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-proposal-routes-"));
  process.env.DATABASE_URL = join(tempDir, "proposal-routes.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";
  process.env.AI_ACTION_EXECUTION_ENABLED = "true";
  process.env.AI_ACTION_ALLOWED_TYPES = "restart,start";
  process.env.AI_ACTION_STOP_ENABLED = "false";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  const session = await login();
  cookie = session.cookie;
  userId = session.id;

  const dbMod = await import("../db/index.js");
  schema = await import("../db/schema.js");
  db = dbMod.db;
});

afterAll(async () => {
  await app?.close();
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("action proposal routes", () => {
  it("lists proposals and creates an approval request", async () => {
    const { incidentId, proposalId } = await seedProposal();

    const list = await app.inject({
      method: "GET",
      url: `/api/action-proposals?incidentId=${incidentId}`,
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as any).items).toHaveLength(1);

    const request = await app.inject({
      method: "POST",
      url: `/api/action-proposals/${proposalId}/request-approval`,
      headers: { cookie },
      payload: { note: "requested from test" },
    });
    expect(request.statusCode).toBe(201);
    const body = request.json() as any;
    expect(body.proposal.status).toBe("pending_approval");
    expect(body.approval.source).toBe("ai");
    expect(body.approval.requestedBy).toBe(userId);

    const detail = await app.inject({
      method: "GET",
      url: `/api/incidents/${incidentId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as any;
    expect(detailBody.proposals[0].id).toBe(proposalId);
    expect(detailBody.approvals[0].proposalId).toBe(proposalId);
    expect(detailBody.approvals[0].expiresAt).toBeTruthy();

    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/approvals/${body.approval.id}/approve`,
      headers: { cookie },
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(403);
  });

  it("rejects a disabled stop proposal before creating an approval", async () => {
    const { proposalId } = await seedProposal("stop");
    const request = await app.inject({
      method: "POST",
      url: `/api/action-proposals/${proposalId}/request-approval`,
      headers: { cookie },
      payload: {},
    });
    expect(request.statusCode).toBe(422);
  });
});
