import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV_MASK } from "@sys4sys/shared";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let adminCookie: string;
let operatorCookie: string;
let viewerCookie: string;
let secretsToken: string;
let readOnlyToken: string;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
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

async function createUser(
  email: string,
  name: string,
  password: string,
  role: "operator" | "viewer",
): Promise<void> {
  const response = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: { cookie: adminCookie },
    payload: { email, name, password, role },
  });
  expect(response.statusCode).toBe(201);
}

async function createToken(
  cookie: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: { cookie },
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { token: string }).token;
}

async function listHostIds(): Promise<string[]> {
  const response = await app.inject({
    method: "GET",
    url: "/api/hosts",
    headers: { cookie: adminCookie },
  });
  expect(response.statusCode).toBe(200);
  const hosts = response.json() as { id: string; enabled: boolean }[];
  return hosts.filter((host) => host.enabled).map((host) => host.id);
}

async function createService(
  name: string,
  env: Record<string, string>,
  deployEnv?: Record<string, string>,
) {
  const hostIds = await listHostIds();
  expect(hostIds.length).toBeGreaterThan(0);

  const response = await app.inject({
    method: "POST",
    url: "/api/services",
    headers: { cookie: adminCookie },
    payload: {
      hostId: hostIds[0],
      name,
      command: ["node", "server.js"],
      env,
      deploy: {
        command: ["node", "deploy.js"],
        ...(deployEnv ? { env: deployEnv } : {}),
      },
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as Record<string, any>;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-services-"));
  process.env.DATABASE_URL = join(tempDir, "services.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  adminCookie = await login("admin@sys4sys.local", "test-admin-password-123");
  await createUser(
    "operator-secrets@sys4sys.local",
    "Secrets Operator",
    "operator-test-password-123",
    "operator",
  );
  await createUser(
    "viewer-secrets@sys4sys.local",
    "Secrets Viewer",
    "viewer-test-password-123",
    "viewer",
  );
  operatorCookie = await login(
    "operator-secrets@sys4sys.local",
    "operator-test-password-123",
  );
  viewerCookie = await login(
    "viewer-secrets@sys4sys.local",
    "viewer-test-password-123",
  );
  secretsToken = await createToken(adminCookie, {
    name: "secrets",
    scopes: ["services:secrets"],
  });
  readOnlyToken = await createToken(adminCookie, {
    name: "read-only",
    scopes: ["services:read"],
  });
});

afterAll(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("service env masking", () => {
  it("does not expose env values in list or detail responses", async () => {
    const created = await createService(
      "env-mask-service",
      { DATABASE_URL: "plain-env-value" },
      { DEPLOY_TOKEN: "deploy-secret-value" },
    );
    const id = String(created.id);

    expect(JSON.stringify(created)).not.toContain("plain-env-value");
    expect(JSON.stringify(created)).not.toContain("deploy-secret-value");
    expect(JSON.stringify(created)).not.toContain("v1:");
    expect(created.env).toEqual({ DATABASE_URL: ENV_MASK });
    expect(created.envKeys).toEqual(["DATABASE_URL"]);
    expect(created.deploy.env).toEqual({ DEPLOY_TOKEN: ENV_MASK });
    expect(created.deploy.envKeys).toEqual(["DEPLOY_TOKEN"]);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/services",
      headers: { cookie: adminCookie },
    });
    expect(listResponse.statusCode).toBe(200);
    const list = listResponse.json() as Record<string, any>[];
    const listed = list.find((service) => service.id === id);
    if (!listed) {
      throw new Error("created service was not found in the list response");
    }
    expect(listed.env).toBeUndefined();
    expect(listed.envKeys).toEqual(["DATABASE_URL"]);
    expect(listed.deploy.env).toBeUndefined();
    expect(listed.deploy.envKeys).toEqual(["DEPLOY_TOKEN"]);
    expect(JSON.stringify(listed)).not.toContain("plain-env-value");
    expect(JSON.stringify(listed)).not.toContain("deploy-secret-value");
    expect(JSON.stringify(listed)).not.toContain("v1:");

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(detailResponse.statusCode).toBe(200);
    const detail = detailResponse.json() as Record<string, any>;
    expect(detail.env).toEqual({ DATABASE_URL: ENV_MASK });
    expect(detail.deploy.env).toEqual({ DEPLOY_TOKEN: ENV_MASK });
    expect(JSON.stringify(detail)).not.toContain("plain-env-value");
    expect(JSON.stringify(detail)).not.toContain("deploy-secret-value");
    expect(JSON.stringify(detail)).not.toContain("v1:");
  });

  it("reveals env values only through the audited admin secrets endpoint", async () => {
    const created = await createService(
      "env-secrets-service",
      { DATABASE_URL: "plain-secret" },
      { DEPLOY_TOKEN: "deploy-secret" },
    );
    const id = String(created.id);

    const forbidden = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}/secrets`,
      headers: { authorization: `Bearer ${readOnlyToken}` },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json()).toMatchObject({
      requiredScope: "services:secrets",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}/secrets`,
      headers: { authorization: `Bearer ${secretsToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      env: { DATABASE_URL: "plain-secret" },
      deployEnv: { DEPLOY_TOKEN: "deploy-secret" },
    });
    expect(JSON.stringify(response.json())).not.toContain("v1:");

    const auditResponse = await app.inject({
      method: "GET",
      url: `/api/audit-logs?action=service.secrets.reveal&target=${encodeURIComponent(`service:${id}`)}`,
      headers: { cookie: adminCookie },
    });
    expect(auditResponse.statusCode).toBe(200);
    const audit = auditResponse.json() as { items: Record<string, any>[] };
    expect(audit.items.some((entry) => entry.target === `service:${id}`)).toBe(
      true,
    );
    expect(JSON.stringify(audit.items)).not.toContain("plain-secret");
    expect(JSON.stringify(audit.items)).not.toContain("deploy-secret");
    expect(JSON.stringify(audit.items)).not.toContain("v1:");
  });

  it("rejects non-admin roles for the secrets endpoint", async () => {
    const created = await createService("env-role-secrets-service", {
      DATABASE_URL: "role-plain-secret",
    });
    const id = String(created.id);

    const operatorResponse = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}/secrets`,
      headers: { cookie: operatorCookie },
    });
    expect(operatorResponse.statusCode).toBe(403);

    const viewerResponse = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}/secrets`,
      headers: { cookie: viewerCookie },
    });
    expect(viewerResponse.statusCode).toBe(403);
  });

  it("rejects writes that contain masked env values", async () => {
    const hostIds = await listHostIds();
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { cookie: adminCookie },
      payload: {
        hostId: hostIds[0],
        name: "masked-write-service",
        command: ["node", "server.js"],
        env: { DATABASE_URL: ENV_MASK },
      },
    });
    expect(createResponse.statusCode).toBe(422);
    expect(createResponse.json()).toMatchObject({
      detail: expect.stringContaining(ENV_MASK),
    });

    const created = await createService("masked-update-service", {
      DATABASE_URL: "keep-me",
    });
    const id = String(created.id);
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(id)}`,
      headers: { cookie: adminCookie },
      payload: {
        deploy: {
          command: ["node", "deploy.js"],
          env: { DEPLOY_TOKEN: ENV_MASK },
        },
      },
    });
    expect(updateResponse.statusCode).toBe(422);
    expect(updateResponse.json()).toMatchObject({
      detail: expect.stringContaining(ENV_MASK),
    });
  });

  it("preserves existing deploy.env when a deploy update omits env", async () => {
    const created = await createService(
      "deploy-env-preserve-service",
      { DATABASE_URL: "plain-env-value" },
      { DEPLOY_TOKEN: "deploy-secret-value" },
    );
    const id = String(created.id);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/services/${encodeURIComponent(id)}`,
      headers: { cookie: adminCookie },
      payload: {
        deploy: {
          command: ["node", "deploy-v2.js"],
          timeoutSec: 300,
          restartAfter: false,
          healthTimeoutSec: 30,
        },
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    const updated = updateResponse.json() as Record<string, any>;
    expect(updated.deploy.command).toEqual(["node", "deploy-v2.js"]);
    expect(updated.deploy.env).toEqual({ DEPLOY_TOKEN: ENV_MASK });

    const secretsResponse = await app.inject({
      method: "GET",
      url: `/api/services/${encodeURIComponent(id)}/secrets`,
      headers: { cookie: adminCookie },
    });
    expect(secretsResponse.statusCode).toBe(200);
    expect(secretsResponse.json()).toMatchObject({
      deployEnv: { DEPLOY_TOKEN: "deploy-secret-value" },
    });
    expect(JSON.stringify(secretsResponse.json())).not.toContain("v1:");
  });
});
