import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

const scm = vi.hoisted(() => {
  const states = new Map<
    string,
    { state: string; pid: number; calls: string[] }
  >();

  return {
    states,
    ensure(name: string) {
      const current = states.get(name);
      if (current) return current;
      const created = { state: "stopped", pid: 0, calls: [] };
      states.set(name, created);
      return created;
    },
    reset() {
      states.clear();
    },
  };
});

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("../services/service-control.js", () => {
  class ServiceControlError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly exitCode: number | null = null,
    ) {
      super(message);
      this.name = "ServiceControlError";
    }

    get statusCode(): number {
      return 503;
    }
  }

  class FakeWindowsServiceController {
    private ensure(service: { serviceName?: string | null }) {
      const name = service.serviceName?.trim();
      if (!name) {
        throw new ServiceControlError(
          "not_found",
          "Windows service name is missing",
        );
      }
      return scm.ensure(name);
    }

    private result(state: { state: string; pid: number }) {
      return {
        state: state.state as "running" | "stopped",
        pid: state.pid > 0 ? state.pid : null,
        exitCode: state.state === "stopped" ? 0 : null,
        missing: false,
      };
    }

    async inspect(service: { serviceName?: string | null }) {
      const state = this.ensure(service);
      state.calls.push(`inspect:${state.state}`);
      return this.result(state);
    }

    async start(service: { serviceName?: string | null }) {
      const state = this.ensure(service);
      state.calls.push(`start:${state.state}`);
      state.state = "running";
      state.pid = 4321;
      return this.result(state);
    }

    async stop(service: { serviceName?: string | null }) {
      const state = this.ensure(service);
      state.calls.push(`stop:${state.state}`);
      state.state = "stopped";
      state.pid = 0;
      return this.result(state);
    }

    async restart(service: { serviceName?: string | null }) {
      const state = this.ensure(service);
      state.calls.push(`restart:${state.state}`);
      state.state = "running";
      state.pid = 4321;
      return this.result(state);
    }
  }

  return {
    ServiceControlError,
    WindowsServiceController: FakeWindowsServiceController,
    getServiceController: vi.fn((service: { controlMode?: string }) =>
      service.controlMode === "windows-service"
        ? new FakeWindowsServiceController()
        : null,
    ),
  };
});

vi.mock("cross-spawn", () => ({ default: spawnMock }));

let app: App;
let tempDir: string;
let adminCookie: string;
let adminUserId: string;
let windowsHostId: string;
let wslHostId: string | null;
let db: any;
let actions: any;
let manager: any;
let deployExitCode = 0;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

function createFakeChild(): any {
  const child: any = new EventEmitter();
  child.pid = 43210;
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
    if (event === "close") setTimeout(() => listener(deployExitCode, null), 0);
    return child;
  };

  return child;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function serviceById(id: string): Promise<Record<string, any>> {
  const response = await app.inject({
    method: "GET",
    url: `/api/services/${encodeURIComponent(id)}`,
    headers: { cookie: adminCookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, any>;
}

async function waitAction(actionId: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, actionId))
      .all();
    if (row && (row.status === "succeeded" || row.status === "failed")) {
      return row as Record<string, any>;
    }
    await sleep(50);
  }
  throw new Error(`action ${actionId} did not finish`);
}

async function createServicePayload(
  name: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/services",
    headers: { cookie: adminCookie },
    payload: { name, ...payload },
  });
  return {
    status: response.statusCode,
    body: response.json() as Record<string, any>,
  };
}

async function createExternalService(
  name: string,
  serviceName: string,
  controlOwner: "sys4sys" | "script" | null = null,
  deployOverrides: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const result = await createServicePayload(name, {
    hostId: windowsHostId,
    command: ["node", "unused-service.js"],
    controlMode: "windows-service",
    serviceName,
    deploy: controlOwner
      ? {
          command: ["node", "-e", "process.exit(0)"],
          cwd: tempDir,
          serviceControlOwner: controlOwner,
          healthTimeoutSec: 10,
          ...deployOverrides,
        }
      : undefined,
  });
  expect(result.status).toBe(201);
  return result.body;
}

async function startService(id: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/services/${encodeURIComponent(id)}/start`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  expect(response.statusCode).toBe(202);
  return response.json() as Record<string, any>;
}

async function deployService(id: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/services/${encodeURIComponent(id)}/deploy`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  expect(response.statusCode).toBe(202);
  return response.json() as Record<string, any>;
}

function callsSince(serviceName: string, marker: number): string[] {
  return scm.ensure(serviceName).calls.slice(marker);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-external-services-"));
  process.env.DATABASE_URL = join(tempDir, "external-services.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";
  process.env.DEPLOY_REQUIRE_APPROVAL_DEFAULT = "false";
  process.env.SELF_SERVICE_NAME = "SelfService";
  process.env.SERVICE_CONTROL_TIMEOUT_MS = "1000";
  process.env.SERVICE_CONTROL_POLL_MS = "100";

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
  const hostRows = hosts.json() as Array<Record<string, any>>;
  windowsHostId = hostRows.find((host) => host.kind === "windows")!
    .id as string;
  wslHostId = hostRows.find((host) => host.kind === "wsl")?.id ?? null;

  const dbMod = await import("../db/index.js");
  const schema = await import("../db/schema.js");
  db = dbMod.db;
  actions = schema.actions;
  manager = await import("../services/manager.js");
});

afterAll(async () => {
  await app?.close();
  await (db as any)?.$client?.close?.();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  deployExitCode = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(createFakeChild);
});

describe("external windows services", () => {
  it("rejects invalid control-mode combinations", async () => {
    const spawnWithServiceName = await createServicePayload(
      "spawn-name-conflict",
      {
        hostId: windowsHostId,
        command: ["node", "server.js"],
        controlMode: "spawn",
        serviceName: "NotAllowed",
      },
    );
    expect(spawnWithServiceName.status).toBe(422);

    const missingServiceName = await createServicePayload(
      "missing-service-name",
      {
        hostId: windowsHostId,
        command: ["node", "unused-service.js"],
        controlMode: "windows-service",
      },
    );
    expect(missingServiceName.status).toBe(422);

    const missingOwner = await createServicePayload("missing-owner", {
      hostId: windowsHostId,
      command: ["node", "unused-service.js"],
      controlMode: "windows-service",
      serviceName: "MissingOwnerService",
      deploy: {
        command: ["node", "-e", "process.exit(0)"],
        cwd: tempDir,
      },
    });
    expect(missingOwner.status).toBe(422);

    if (wslHostId) {
      const wslHost = await createServicePayload("wsl-external", {
        hostId: wslHostId,
        command: ["node", "unused-service.js"],
        controlMode: "windows-service",
        serviceName: "WslExternalService",
      });
      expect(wslHost.status).toBe(422);
      expect(wslHost.body.detail).toContain("Windows");
    }
  });

  it("normalizes restartAfter from service control owner", async () => {
    const sys4sys = await createExternalService(
      "normalize-sys4sys",
      "NormalizeSys4SysService",
      "sys4sys",
      { restartAfter: false },
    );
    expect(sys4sys.deploy.restartAfter).toBe(true);
    expect(sys4sys.deploy.serviceControlOwner).toBe("sys4sys");

    const script = await createExternalService(
      "normalize-script",
      "NormalizeScriptService",
      "script",
      { restartAfter: true },
    );
    expect(script.deploy.restartAfter).toBe(false);
    expect(script.deploy.serviceControlOwner).toBe("script");
  });

  it("enforces case-insensitive unique service names per host", async () => {
    const first = await createExternalService(
      "case-first",
      "CaseDuplicateService",
    );
    expect(first.serviceName).toBe("CaseDuplicateService");

    const duplicate = await createServicePayload("case-duplicate", {
      hostId: windowsHostId,
      command: ["node", "unused-service.js"],
      controlMode: "windows-service",
      serviceName: "caseduplicateservice",
    });
    expect(duplicate.status).toBe(409);
  });

  it("uses the SCM controller for manual lifecycle and blocks runtime control-mode changes", async () => {
    const service = await createExternalService(
      "manual-lifecycle",
      "ManualLifecycleService",
    );

    await startService(service.id);
    expect(scm.ensure("ManualLifecycleService").calls).toEqual([
      "inspect:stopped",
      "start:stopped",
    ]);
    expect((await serviceById(service.id)).status).toBe("running");

    const stop = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/stop`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(stop.statusCode).toBe(202);
    expect(scm.ensure("ManualLifecycleService").calls).toEqual([
      "inspect:stopped",
      "start:stopped",
      "stop:running",
    ]);
    expect((await serviceById(service.id)).status).toBe("stopped");

    const update = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(service.id)}`,
      headers: { cookie: adminCookie },
      payload: { controlMode: "spawn" },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      controlMode: "spawn",
      serviceName: null,
    });
  });

  it("blocks control-mode changes while the service is running", async () => {
    const service = await createExternalService(
      "runtime-guard",
      "RuntimeGuardService",
    );
    await startService(service.id);

    const update = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(service.id)}`,
      headers: { cookie: adminCookie },
      payload: { controlMode: "spawn" },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json().detail).toContain("controlMode");
  });

  it("runs deploy with sys4sys as the sole stop/start owner", async () => {
    const service = await createExternalService(
      "deploy-owner-sys4sys",
      "DeployOwnerSys4SysService",
      "sys4sys",
    );
    await startService(service.id);
    const marker = scm.ensure("DeployOwnerSys4SysService").calls.length;

    const action = await deployService(service.id);
    const finished = await waitAction(action.id);
    const calls = callsSince("DeployOwnerSys4SysService", marker);

    expect(finished.status).toBe("succeeded");
    expect(calls.filter((call) => call.startsWith("stop:running")).length).toBe(
      1,
    );
    expect(
      calls.filter((call) => call.startsWith("start:stopped")).length,
    ).toBe(1);
    expect(scm.ensure("DeployOwnerSys4SysService").state).toBe("running");
    expect((await serviceById(service.id)).status).toBe("running");
  });

  it("does not call controller start or stop when deploy owner is script", async () => {
    const service = await createExternalService(
      "deploy-owner-script",
      "DeployOwnerScriptService",
      "script",
    );
    const fake = scm.ensure("DeployOwnerScriptService");
    fake.state = "running";
    fake.pid = 4321;

    const action = await deployService(service.id);
    const finished = await waitAction(action.id);
    const calls = scm.ensure("DeployOwnerScriptService").calls;

    expect(finished.status).toBe("succeeded");
    expect(calls.some((call) => call.startsWith("start:"))).toBe(false);
    expect(calls.some((call) => call.startsWith("stop:"))).toBe(false);
    expect(scm.ensure("DeployOwnerScriptService").state).toBe("running");
  });

  it("restores an external service after sys4sys-owned deploy command fails", async () => {
    deployExitCode = 1;
    const service = await createExternalService(
      "deploy-recovery",
      "DeployRecoveryService",
      "sys4sys",
    );
    await startService(service.id);
    const marker = scm.ensure("DeployRecoveryService").calls.length;

    const action = await deployService(service.id);
    const finished = await waitAction(action.id);
    const calls = callsSince("DeployRecoveryService", marker);

    expect(finished.status).toBe("failed");
    expect(calls.some((call) => call.startsWith("stop:running"))).toBe(true);
    expect(
      calls.filter((call) => call.startsWith("start:stopped")).length,
    ).toBe(1);
    expect(scm.ensure("DeployRecoveryService").state).toBe("running");
  });

  it("blocks manual lifecycle actions while a deploy action is running", async () => {
    const service = await createExternalService(
      "deploy-lock-action",
      "DeployLockActionService",
    );
    await db.insert(actions).values({
      id: randomUUID(),
      incidentId: null,
      serviceId: service.id,
      type: "deploy",
      status: "running",
      requestedBy: adminUserId,
      approvedBy: null,
      policyId: null,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
    });

    const start = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/start`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(start.statusCode).toBe(409);
    expect(start.json().detail).toContain("デプロイ中");

    await db.delete(actions).where(eq(actions.serviceId, service.id)).run();
  });

  it("allows only one pending or running deploy action in the database", async () => {
    const service = await createExternalService(
      "deploy-lock-db",
      "DeployLockDbService",
    );
    const base = {
      incidentId: null,
      serviceId: service.id,
      type: "deploy",
      requestedBy: adminUserId,
      approvedBy: null,
      policyId: null,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
    };

    await db.insert(actions).values({
      ...base,
      id: randomUUID(),
      status: "running",
    });

    let caught: any;
    try {
      await db.insert(actions).values({
        ...base,
        id: randomUUID(),
        status: "pending",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.code).toContain("SQLITE_CONSTRAINT");

    await db.delete(actions).where(eq(actions.serviceId, service.id)).run();
  });

  it("refuses sys4sys self stop, restart, deploy, and deploy request", async () => {
    const self = await createExternalService(
      "self-service",
      "SelfService",
      "sys4sys",
    );

    for (const action of ["stop", "restart", "deploy"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/services/${encodeURIComponent(self.id)}/${action}`,
        headers: { cookie: adminCookie },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().detail).toContain("sys4sys 自身");
    }

    const deployRequest = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(self.id)}/deploy-requests`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(deployRequest.statusCode).toBe(409);
    expect(deployRequest.json().detail).toContain("sys4sys 自身");
  });

  it("reconciles an already running external service as adopted", async () => {
    const service = await createExternalService(
      "reconcile-adoption",
      "ReconcileAdoptionService",
    );
    const fake = scm.ensure("ReconcileAdoptionService");
    fake.state = "running";
    fake.pid = 4321;

    await manager.reconcileServices();

    const row = await serviceById(service.id);
    const runtime = manager.runtimeInfo(service.id, row);
    expect(row.status).toBe("running");
    expect(runtime.running).toBe(true);
    expect(runtime.adopted).toBe(true);
    expect(runtime.serviceState).toBe("running");

    const stop = await app.inject({
      method: "POST",
      url: `/api/services/${encodeURIComponent(service.id)}/stop`,
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(stop.statusCode).toBe(202);
    expect(scm.ensure("ReconcileAdoptionService").state).toBe("stopped");
  });

  it("emits an unexpected exit signal when a running external service is stopped outside sys4sys", async () => {
    const service = await createExternalService(
      "unexpected-external-exit",
      "UnexpectedExitService",
    );
    await startService(service.id);

    const { serviceEvents } = await import("../services/events.js");
    const exitEvent = new Promise<Record<string, any>>((resolve) => {
      serviceEvents.once("exited", resolve);
    });

    const fake = scm.ensure("UnexpectedExitService");
    fake.state = "stopped";
    fake.pid = 0;

    const health = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(service.id)}/health`,
      headers: { cookie: adminCookie },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("stopped");

    await expect(exitEvent).resolves.toMatchObject({
      serviceId: service.id,
      code: null,
      signal: null,
    });

    const row = await serviceById(service.id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("unexpectedly stopped");
  });
});
