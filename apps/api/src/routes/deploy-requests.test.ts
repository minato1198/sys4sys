import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

function createFakeChild(): any {
  const child: any = new EventEmitter();
  child.pid = 43211;
  child.exitCode = null;
  child.signalCode = null;

  const createStream = (): any => {
    const stream: any = new EventEmitter();
    stream.resume = () => stream;
    stream.pause = () => stream;
    stream.setEncoding = () => stream;
    setTimeout(() => stream.emit("end"), 0);
    return stream;
  };

  child.stdout = createStream();
  child.stderr = createStream();
  child.kill = vi.fn(() => true);
  child.once = (event: string, listener: (...args: any[]) => void) => {
    child.on(event, listener);
    if (event === "spawn") setTimeout(() => listener(), 0);
    if (event === "close") setTimeout(() => listener(0, null), 0);
    return child;
  };

  return child;
}

spawnMock.mockImplementation(createFakeChild);
vi.mock("cross-spawn", () => ({ default: spawnMock }));

let app: App;
let tempDir: string;
let cwd: string;
let adminCookie: string;
let adminUserId: string;
let hostId: string;
let db: any;
let deployRequests: any;
let auditLogs: any;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

async function createService(name: string, requireApproval: boolean) {
  const response = await app.inject({
    method: "POST",
    url: "/api/services",
    headers: { cookie: adminCookie },
    payload: {
      hostId,
      name,
      command: ["node", "server.js"],
      cwd,
      env: { SERVICE_TOKEN: "service-secret" },
      deploy: {
        command: ["node", "deploy.js"],
        cwd,
        env: { DEPLOY_TOKEN: "deploy-secret" },
        timeoutSec: 300,
        restartAfter: false,
        healthTimeoutSec: 30,
        requireApproval,
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Record<string, any>;
}

async function createDeployRequest(serviceId: string, note = "request") {
  const response = await app.inject({
    method: "POST",
    url: `/api/services/${encodeURIComponent(serviceId)}/deploy-requests`,
    headers: { cookie: adminCookie },
    payload: { note },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Record<string, any>;
}

async function insertExpiredDeployRequest(serviceId: string): Promise<string> {
  const id = randomUUID();
  await db.insert(deployRequests).values({
    id,
    serviceId,
    requestedBy: adminUserId,
    requestedAt: new Date(Date.now() - 86_400_000),
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    note: "expired",
    actionId: null,
    snapshot: {
      command: ["node", "deploy.js"],
      cwd,
      timeoutSec: 300,
      restartAfter: false,
      healthTimeoutSec: 30,
      envHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deployEnvHash:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    expiresAt: new Date(Date.now() - 1000),
  });
  return id;
}

async function auditCount(action: string): Promise<number> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .all();
  return rows.length;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-deploy-requests-"));
  cwd = tempDir;
  process.env.DATABASE_URL = join(tempDir, "deploy-requests.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";
  process.env.DEPLOY_REQUIRE_APPROVAL_DEFAULT = "false";
  process.env.DEPLOY_REQUEST_TTL_MINUTES = "1440";
  process.env.DEPLOY_ALLOW_SELF_APPROVAL = "false";

  const { buildApp } = await import("../app.js");
  app = await buildApp();

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@sys4sys.local",
      password: "test-admin-password-123",
    },
  });
  expect(login.statusCode).toBe(200);
  adminCookie = cookieHeader(login.headers["set-cookie"]);
  adminUserId = (login.json() as Record<string, any>).id as string;

  const hosts = await app.inject({
    method: "GET",
    url: "/api/hosts",
    headers: { cookie: adminCookie },
  });
  expect(hosts.statusCode).toBe(200);
  hostId = (hosts.json() as Array<Record<string, any>>)[0]!.id as string;

  const dbMod = await import("../db/index.js");
  const schema = await import("../db/schema.js");
  db = dbMod.db;
  deployRequests = schema.deployRequests;
  auditLogs = schema.auditLogs;
});

afterAll(async () => {
  await app?.close();
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("deploy approval requests", () => {
  it("blocks immediate deploy when requireApproval is true", async () => {
    const service = await createService("approval-blocked", true);
    const response = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/deploy`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      title: "Conflict",
      detail: "approval_required",
      deployRequestId: null,
    });
  });

  it("creates, rejects self-approval, approves as another user, and records audits", async () => {
    const service = await createService("approval-self", true);
    const created = await createDeployRequest(service.id);
    expect(created.status).toBe("pending");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/deploy-requests`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().deployRequestId).toBe(created.id);

    const immediateWithPending = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/deploy`,
      headers: { cookie: adminCookie },
    });
    expect(immediateWithPending.statusCode).toBe(409);
    expect(immediateWithPending.json().deployRequestId).toBe(created.id);

    const selfApprove = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(created.id)}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(selfApprove.statusCode).toBe(403);

    await db
      .update(deployRequests)
      .set({ requestedBy: "usr-other-approver" })
      .where(eq(deployRequests.id, created.id));

    const approve = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(created.id)}/approve`,
      headers: { cookie: adminCookie },
      payload: { note: "ok" },
    });
    expect(approve.statusCode).toBe(202);
    const approved = approve.json() as Record<string, any>;
    expect(["approved", "executed", "failed"]).toContain(
      approved.request.status,
    );
    expect(approved.request.actionId).not.toBeNull();
    expect(approved.action.id).toBe(approved.request.actionId);

    const secondApprove = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(created.id)}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(secondApprove.statusCode).toBe(409);

    const secondReject = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(created.id)}/reject`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(secondReject.statusCode).toBe(409);

    expect(await auditCount("deploy.request.requested")).toBeGreaterThan(0);
    expect(await auditCount("deploy.request.approve")).toBeGreaterThan(0);

    const service2 = await createService("approval-reject", true);
    const request2 = await createDeployRequest(service2.id, "reject me");
    const reject = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(request2.id)}/reject`,
      headers: { cookie: adminCookie },
      payload: { note: "blocked" },
    });
    expect(reject.statusCode).toBe(200);
    expect((reject.json() as Record<string, any>).status).toBe("rejected");
    expect(await auditCount("deploy.request.reject")).toBeGreaterThan(0);
  });

  it("expires pending requests", async () => {
    const service = await createService("approval-expired", true);
    const expiredId = await insertExpiredDeployRequest(service.id);

    const pending = await app.inject({
      method: "GET",
      url: "/api/deploy-requests?status=pending&limit=200",
      headers: { cookie: adminCookie },
    });
    expect(pending.statusCode).toBe(200);
    expect(
      (pending.json() as Record<string, any>).items.some(
        (item: Record<string, any>) => item.id === expiredId,
      ),
    ).toBe(false);

    const expired = await app.inject({
      method: "GET",
      url: "/api/deploy-requests?status=expired&limit=200",
      headers: { cookie: adminCookie },
    });
    expect(expired.statusCode).toBe(200);
    expect(
      (expired.json() as Record<string, any>).items.some(
        (item: Record<string, any>) => item.id === expiredId,
      ),
    ).toBe(true);

    const approve = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(expiredId)}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(409);
  });

  it("rejects approval when the deploy snapshot changed", async () => {
    const service = await createService("approval-snapshot", true);
    const request = await createDeployRequest(service.id, "snapshot");
    await db
      .update(deployRequests)
      .set({ requestedBy: "usr-other-approver" })
      .where(eq(deployRequests.id, request.id));

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(service.id)}`,
      headers: { cookie: adminCookie },
      payload: {
        deploy: {
          command: ["node", "deploy2.js"],
          cwd,
          env: { DEPLOY_TOKEN: "deploy-secret" },
          timeoutSec: 300,
          restartAfter: false,
          healthTimeoutSec: 30,
          requireApproval: true,
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    const approve = await app.inject({
      method: "POST",
      url: `/api/deploy-requests/${encodeURIComponent(request.id)}/approve`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().detail).toMatch(/スナップショット/);

    const [stored] = await db
      .select()
      .from(deployRequests)
      .where(eq(deployRequests.id, request.id))
      .all();
    expect(stored.status).toBe("pending");
  });

  it("preserves requireApproval when services update omits it", async () => {
    const service = await createService("approval-preserve", true);
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(service.id)}`,
      headers: { cookie: adminCookie },
      payload: {
        deploy: {
          command: ["node", "deploy-preserved.js"],
          cwd,
          timeoutSec: 300,
          restartAfter: false,
          healthTimeoutSec: 30,
        },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as Record<string, any>).deploy.requireApproval).toBe(
      true,
    );
  });

  it("keeps requireApproval=false immediate deploy compatible", async () => {
    const service = await createService("approval-immediate", false);
    const response = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/deploy`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(202);
    expect((response.json() as Record<string, any>).type).toBe("deploy");
  });
});
