import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ENV_MASK } from "@sys4sys/shared";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

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
let hostId: string;
let adminUser: { id: string; email: string; name: string; role: string };
let db: any;
let services: any;
let startService: (id: string) => Promise<any>;
let beginDeploy: (service: any, user: any) => Promise<any>;
let runDeploy: (
  service: any,
  deploy: any,
  actionId: string,
  user: any,
  ip: string | null,
) => Promise<void>;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

function tamperCiphertext(payload: string): string {
  const parts = payload.split(":");
  const data = Buffer.from(parts[3]!, "base64");
  data[0] = data[0]! ^ 0xff;
  parts[3] = data.toString("base64");
  return parts.join(":");
}

function lastSpawnEnv(): Record<string, string> {
  const call = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
  expect(call).toBeDefined();
  return (call![2] as Record<string, any>).env as Record<string, string>;
}

async function login(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeader(response.headers["set-cookie"]);
}

async function createService(
  name: string,
  env: Record<string, string>,
  deployEnv: Record<string, string>,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/services",
    headers: { cookie: adminCookie },
    payload: {
      hostId,
      name,
      command: ["node", "server.js"],
      cwd,
      env,
      deploy: {
        command: ["node", "deploy.js"],
        cwd,
        env: deployEnv,
        timeoutSec: 300,
        restartAfter: false,
        healthTimeoutSec: 30,
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Record<string, any>;
}

async function selectService(id: string) {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, id))
    .limit(1);
  return row;
}

async function getServiceResponse(id: string) {
  const response = await app.inject({
    method: "GET",
    url: `/api/services/${encodeURIComponent(id)}`,
    headers: { cookie: adminCookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as Record<string, any>;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-enc-"));
  cwd = tempDir;
  process.env.DATABASE_URL = join(tempDir, "encrypted-services.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const appModule = await import("../app.js");
  app = await appModule.buildApp();
  adminCookie = await login("admin@sys4sys.local", "test-admin-password-123");
  const me = await app.inject({
    method: "GET",
    url: "/api/auth/me",
    headers: { cookie: adminCookie },
  });
  expect(me.statusCode).toBe(200);
  adminUser = me.json() as any;

  const hosts = await app.inject({
    method: "GET",
    url: "/api/hosts",
    headers: { cookie: adminCookie },
  });
  expect(hosts.statusCode).toBe(200);
  hostId = (hosts.json() as { id: string; enabled: boolean }[]).find(
    (host) => host.enabled,
  )!.id;

  db = (await import("../db/index.js")).db;
  services = (await import("../db/schema.js")).services;
  startService = (await import("../services/manager.js")).startService;
  const deployModule = await import("../services/deploy.js");
  beginDeploy = deployModule.beginDeploy;
  runDeploy = deployModule.runDeploy;
});

afterAll(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("service env encrypted runtime", () => {
  it("stores encrypted env values and does not expose ciphertext through API responses", async () => {
    const created = await createService(
      "encrypted-store-service",
      { DATABASE_URL: "plain-runtime-secret" },
      { DEPLOY_TOKEN: "plain-deploy-secret" },
    );
    const id = String(created.id);

    expect(JSON.stringify(created)).not.toContain("plain-runtime-secret");
    expect(JSON.stringify(created)).not.toContain("plain-deploy-secret");
    expect(JSON.stringify(created)).not.toContain("v1:");
    expect(created.env).toEqual({ DATABASE_URL: ENV_MASK });
    expect(created.deploy.env).toEqual({ DEPLOY_TOKEN: ENV_MASK });

    const row = await selectService(id);
    expect(row.env.DATABASE_URL.startsWith("v1:")).toBe(true);
    expect(row.deploy.env.DEPLOY_TOKEN.startsWith("v1:")).toBe(true);

    const detail = await getServiceResponse(id);
    expect(JSON.stringify(detail)).not.toContain("plain-runtime-secret");
    expect(JSON.stringify(detail)).not.toContain("plain-deploy-secret");
    expect(JSON.stringify(detail)).not.toContain("v1:");
    expect(detail.env).toEqual({ DATABASE_URL: ENV_MASK });
    expect(detail.deploy.env).toEqual({ DEPLOY_TOKEN: ENV_MASK });
  });

  it("fails service start with a safe decryption error instead of exposing ciphertext", async () => {
    spawnMock.mockClear();

    const created = await createService(
      "start-decryption-failure-service",
      { DATABASE_URL: "start-secret" },
      { DEPLOY_TOKEN: "deploy-secret" },
    );
    const id = String(created.id);
    const row = await selectService(id);
    const tampered = tamperCiphertext(row.env.DATABASE_URL);
    await db
      .update(services)
      .set({ env: { DATABASE_URL: tampered } })
      .where(eq(services.id, id));

    await expect(startService(id)).rejects.toThrow(
      "秘密値の復号に失敗しました",
    );

    const failed = await selectService(id);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("秘密値の復号に失敗しました");
    expect(failed.lastError).not.toContain("start-secret");
    expect(failed.lastError).not.toContain("v1:");
    expect(spawnMock.mock.calls.length).toBe(0);
  });

  it("fails deploy with a safe decryption error instead of exposing ciphertext", async () => {
    spawnMock.mockClear();

    const created = await createService(
      "deploy-decryption-failure-service",
      { DATABASE_URL: "service-secret" },
      { DEPLOY_TOKEN: "deploy-secret" },
    );
    const id = String(created.id);
    const row = await selectService(id);
    const tampered = tamperCiphertext(row.deploy.env.DEPLOY_TOKEN);
    await db
      .update(services)
      .set({
        deploy: {
          ...row.deploy,
          env: { DEPLOY_TOKEN: tampered },
        },
      })
      .where(eq(services.id, id));

    const tamperedRow = await selectService(id);
    const action = await beginDeploy(tamperedRow, adminUser);
    await runDeploy(
      tamperedRow,
      tamperedRow.deploy,
      action.id,
      adminUser,
      null,
    );

    const failed = await selectService(id);
    expect(failed.lastDeployStatus).toBe("failed");
    expect(failed.lastDeployError).toContain("秘密値の復号に失敗しました");
    expect(failed.lastDeployError).not.toContain("deploy-secret");
    expect(failed.lastDeployError).not.toContain("v1:");
    expect(spawnMock.mock.calls.length).toBe(0);

    const detail = await getServiceResponse(id);
    expect(JSON.stringify(detail)).not.toContain("service-secret");
    expect(JSON.stringify(detail)).not.toContain("deploy-secret");
    expect(JSON.stringify(detail)).not.toContain("v1:");
    expect(detail.lastDeployError).toContain("秘密値の復号に失敗しました");
  });

  it("passes decrypted service env values to spawn", async () => {
    spawnMock.mockClear();

    const created = await createService(
      "start-decryption-success-service",
      { SERVICE_SECRET: "runtime-service-secret" },
      { DEPLOY_TOKEN: "unused-deploy-secret" },
    );
    const id = String(created.id);

    const started = await startService(id);
    expect(started.status).toBe("running");
    expect(started.lastError).toBeNull();
    expect(started.pid).toBe(43210);

    const spawnEnv = lastSpawnEnv();
    expect(spawnEnv.SERVICE_SECRET).toBe("runtime-service-secret");
    expect(JSON.stringify(Object.values(spawnEnv))).not.toContain("v1:");

    const detail = await getServiceResponse(id);
    expect(JSON.stringify(detail)).not.toContain("runtime-service-secret");
    expect(JSON.stringify(detail)).not.toContain("v1:");
    expect(detail.env).toEqual({ SERVICE_SECRET: ENV_MASK });
  });

  it("passes decrypted deploy env values to spawn", async () => {
    spawnMock.mockClear();

    const created = await createService(
      "deploy-decryption-success-service",
      { SERVICE_ENV: "runtime-service-env" },
      { DEPLOY_SECRET: "runtime-deploy-secret" },
    );
    const id = String(created.id);
    const row = await selectService(id);
    const action = await beginDeploy(row, adminUser);
    await runDeploy(row, row.deploy, action.id, adminUser, null);

    expect(spawnMock.mock.calls.length).toBe(1);
    const spawnEnv = lastSpawnEnv();
    expect(spawnEnv.SERVICE_ENV).toBe("runtime-service-env");
    expect(spawnEnv.DEPLOY_SECRET).toBe("runtime-deploy-secret");
    expect(JSON.stringify(Object.values(spawnEnv))).not.toContain("v1:");

    const succeeded = await selectService(id);
    expect(succeeded.lastDeployStatus).toBe("succeeded");
    expect(JSON.stringify(succeeded)).not.toContain("runtime-service-env");
    expect(JSON.stringify(succeeded)).not.toContain("runtime-deploy-secret");

    const detail = await getServiceResponse(id);
    expect(JSON.stringify(detail)).not.toContain("runtime-service-env");
    expect(JSON.stringify(detail)).not.toContain("runtime-deploy-secret");
    expect(JSON.stringify(detail)).not.toContain("v1:");
  });
});
