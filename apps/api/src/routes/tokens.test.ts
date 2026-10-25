import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let adminCookie: string;
let adminUserId: string;

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

async function createToken(
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ id: string; token: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/tokens",
    headers: { cookie },
    payload: body,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; token: string };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-routes-"));
  process.env.DATABASE_URL = join(tempDir, "routes.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  const session = await login();
  adminCookie = session.cookie;
  adminUserId = session.id;
});

afterAll(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("bearer auth and token API", () => {
  it("authenticates with a token and reports auth method and scopes", async () => {
    const created = await createToken(adminCookie, {
      name: "read-only",
      scopes: ["services:read"],
    });

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      id: adminUserId,
      authMethod: "token",
      scopes: ["services:read"],
      token: {
        id: created.id,
        name: "read-only",
        prefix: created.token.slice(0, 8),
      },
    });
    expect(JSON.stringify(me.json())).not.toContain(created.token);
  });

  it("allows reads with the required scope and rejects writes with 403", async () => {
    const created = await createToken(adminCookie, {
      name: "read-only",
      scopes: ["services:read"],
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/services",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(list.statusCode).toBe(200);

    const create = await app.inject({
      method: "POST",
      url: "/api/services",
      headers: { authorization: `Bearer ${created.token}` },
      payload: { hostId: "missing", name: "x", command: ["node"] },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json()).toMatchObject({
      requiredScope: "services:write",
    });
  });

  it("does not fall back to a valid cookie when the bearer is invalid", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/services",
      headers: {
        cookie: adminCookie,
        authorization: "Bearer s4s_invalid",
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
  });

  it("denies token access to routes without scope metadata", async () => {
    const created = await createToken(adminCookie, {
      name: "read-only",
      scopes: ["services:read"],
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires tokens:manage for a token to create another token", async () => {
    const readOnly = await createToken(adminCookie, {
      name: "read-only",
      scopes: ["services:read"],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${readOnly.token}` },
      payload: { name: "nested", scopes: ["services:read"] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ requiredScope: "tokens:manage" });
  });

  it("prevents a token from issuing scopes beyond its own", async () => {
    const manager = await createToken(adminCookie, {
      name: "manager",
      scopes: ["tokens:manage"],
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/tokens",
      headers: { authorization: `Bearer ${manager.token}` },
      payload: { name: "escalated", scopes: ["services:write"] },
    });
    expect(response.statusCode).toBe(422);
  });

  it("prevents listing another user's tokens without tokens:manage", async () => {
    const created = await createToken(adminCookie, {
      name: "read-only",
      scopes: ["services:read"],
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/tokens?userId=usr_other",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(response.statusCode).toBe(403);
  });

  it("revokes a token and rejects it immediately", async () => {
    const created = await createToken(adminCookie, {
      name: "short-lived",
      scopes: ["services:read"],
    });

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/tokens/${created.id}`,
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(revoke.statusCode).toBe(204);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it("keeps cookie authentication working for all existing routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: adminUserId,
      authMethod: "session",
    });
  });
});
