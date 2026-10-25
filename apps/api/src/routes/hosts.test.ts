import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let adminCookie: string;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

async function login(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@sys4sys.local",
      password: "test-admin-password-123",
    },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeader(response.headers["set-cookie"]);
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-hosts-"));
  process.env.DATABASE_URL = join(tempDir, "hosts.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  adminCookie = await login();
});

afterAll(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("hosts detail API", () => {
  it("returns 404 for an unknown host", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/hosts/host-missing",
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns the seeded Windows host", async () => {
    const hosts = await app.inject({
      method: "GET",
      url: "/api/hosts",
      headers: { cookie: adminCookie },
    });
    expect(hosts.statusCode).toBe(200);
    const host = (hosts.json() as Array<Record<string, any>>).find(
      (item) => item.kind === "windows",
    );
    expect(host).toBeTruthy();

    const detail = await app.inject({
      method: "GET",
      url: `/api/hosts/${host!.id}`,
      headers: { cookie: adminCookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: host!.id,
      kind: "windows",
      enabled: true,
    });
  });

  it("updates host enable and disable flags", async () => {
    const hosts = await app.inject({
      method: "GET",
      url: "/api/hosts",
      headers: { cookie: adminCookie },
    });
    const host = (hosts.json() as Array<Record<string, any>>).find(
      (item) => item.kind === "windows",
    )!;

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${host.id}`,
      headers: { cookie: adminCookie },
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect((disabled.json() as Record<string, any>).enabled).toBe(false);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/hosts/${host.id}`,
      headers: { cookie: adminCookie },
      payload: { enabled: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect((enabled.json() as Record<string, any>).enabled).toBe(true);
  });
});
