import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let adminCookie: string;
let adminUserId: string;
let db: any;
let incidents: any;
let approvals: any;

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

async function seedApproval(
  requestedBy: string | null,
): Promise<{ incidentId: string; approvalId: string }> {
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

  return { incidentId, approvalId };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-approvals-"));
  process.env.DATABASE_URL = join(tempDir, "approvals.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  const session = await login();
  adminCookie = session.cookie;
  adminUserId = session.id;

  const dbMod = await import("../db/index.js");
  const schema = await import("../db/schema.js");
  db = dbMod.db;
  incidents = schema.incidents;
  approvals = schema.approvals;
});

afterAll(async () => {
  await app?.close();
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("approvals requestedBy and decisions", () => {
  it("lists pending approvals with requestedBy", async () => {
    await seedApproval(null);
    await seedApproval(adminUserId);

    const response = await app.inject({
      method: "GET",
      url: "/api/approvals?status=pending",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: Array<{ requestedBy: string | null }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.items.some((item) => item.requestedBy === null)).toBe(true);
    expect(body.items.some((item) => item.requestedBy === adminUserId)).toBe(
      true,
    );
  });

  it("rejects once and returns 409 for a second decision", async () => {
    const { approvalId } = await seedApproval(null);

    const reject = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/reject`,
      headers: { cookie: adminCookie },
      payload: { note: "first reject" },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as any).approval.status).toBe("rejected");

    const audit = await app.inject({
      method: "GET",
      url: `/api/audit-logs?action=approval.reject&target=approval:${approvalId}`,
      headers: { cookie: adminCookie },
    });
    expect(audit.statusCode).toBe(200);
    expect(
      (audit.json() as any).items.some(
        (item: any) => item.action === "approval.rejected",
      ),
    ).toBe(true);

    const approve = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(409);

    const rejectAgain = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/reject`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(rejectAgain.statusCode).toBe(409);
  });

  it("returns 403 when requestedBy matches the deciding user", async () => {
    const { approvalId } = await seedApproval(adminUserId);

    const response = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      title: "Forbidden",
      detail: "自己承認は許可されていません",
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/approvals?status=pending&limit=100`,
      headers: { cookie: adminCookie },
    });
    expect(
      (list.json() as any).items.some((item: any) => item.id === approvalId),
    ).toBe(true);
  });

  it("allows requestedBy null to be treated as a system approval", async () => {
    const { approvalId } = await seedApproval(null);

    const approve = await app.inject({
      method: "POST",
      url: `/api/approvals/${approvalId}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(404);
    expect(approve.json()).toMatchObject({ title: "Not Found" });
  });
});

describe("incident route role access", () => {
  it("allows admin to ack, analyze, and resolve incidents", async () => {
    const { incidentId } = await seedApproval(null);

    const ack = await app.inject({
      method: "POST",
      url: `/api/incidents/${incidentId}/ack`,
      headers: { cookie: adminCookie },
      payload: { note: "admin ack" },
    });
    expect(ack.statusCode).toBe(200);
    expect((ack.json() as any).status).toBe("acked");

    const analyze = await app.inject({
      method: "POST",
      url: `/api/incidents/${incidentId}/analyze`,
      headers: { cookie: adminCookie },
    });
    expect(analyze.statusCode).toBe(202);
    expect((analyze.json() as any).status).toBe("queued");

    const resolve = await app.inject({
      method: "POST",
      url: `/api/incidents/${incidentId}/resolve`,
      headers: { cookie: adminCookie },
      payload: { note: "admin resolve" },
    });
    expect(resolve.statusCode).toBe(200);
    expect((resolve.json() as any).status).toBe("resolved");
  });
});
