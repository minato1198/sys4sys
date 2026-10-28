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
import type { DetailedScanResult } from "@sys4sys/agent";
import type { PortRow } from "@sys4sys/shared";

const { scanAndPersistMock } = vi.hoisted(() => ({
  scanAndPersistMock: vi.fn(),
}));

vi.mock("../ports/scanner.js", () => ({
  scanAndPersist: scanAndPersistMock,
}));

type App = Awaited<ReturnType<typeof import("../app.js").buildApp>>;

let app: App;
let tempDir: string;
let adminCookie: string;

function cookieHeader(setCookie: string | string[] | undefined): string {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first?.split(";")[0] ?? "";
}

function scan(overrides: Partial<DetailedScanResult> = {}): DetailedScanResult {
  return {
    scannedAt: "2026-10-28T00:00:00.000Z",
    rows: [],
    skipped: [],
    scanErrors: [],
    distros: [],
    timings: {},
    warnings: [],
    ...overrides,
  };
}

function windowsRow(port: number): PortRow {
  return {
    scope: "windows",
    pidScope: null,
    protocol: "tcp",
    address: "127.0.0.1",
    port,
    pid: 123,
    process: "node",
    commandLine: "node server.js",
  };
}

function persisted(value: DetailedScanResult) {
  return {
    scan: value,
    reservations: [],
    reservationViews: [],
  };
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-ports-route-"));
  process.env.DATABASE_URL = join(tempDir, "ports.db");
  process.env.ADMIN_EMAIL = "admin@sys4sys.local";
  process.env.ADMIN_PASSWORD = "test-admin-password-123";
  process.env.MONITOR_ENABLED = "false";
  process.env.LOG_LEVEL = "silent";

  const { buildApp } = await import("../app.js");
  app = await buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: {
      email: "admin@sys4sys.local",
      password: "test-admin-password-123",
    },
  });
  expect(response.statusCode).toBe(200);
  adminCookie = cookieHeader(response.headers["set-cookie"]);
});

afterAll(async () => {
  await app?.close();
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(() => {
  scanAndPersistMock.mockReset();
});

describe("ports API partial scans", () => {
  it("returns 200 with warnings when only WSL failed", async () => {
    scanAndPersistMock.mockResolvedValue(
      persisted(
        scan({
          rows: [windowsRow(3000)],
          timings: { windows: { rows: 1, elapsedMs: 5 } },
          scanErrors: [{ scope: "wsl", message: "wsl.exe not found" }],
        }),
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/ports?scope=all",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: unknown[];
      scanErrors: unknown[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.scanErrors).toEqual([
      expect.objectContaining({ scope: "wsl" }),
    ]);
  });

  it("returns 503 when all requested scopes failed", async () => {
    scanAndPersistMock.mockResolvedValue(
      persisted(
        scan({
          scanErrors: [
            { scope: "windows", message: "powershell failed" },
            { scope: "wsl", message: "wsl.exe not found" },
          ],
        }),
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/ports?scope=all",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      title: "Service Unavailable",
      detail: expect.stringContaining("powershell failed"),
    });
  });

  it("returns 503 when a Windows-only scan fails", async () => {
    scanAndPersistMock.mockResolvedValue(
      persisted(
        scan({
          scanErrors: [{ scope: "windows", message: "powershell failed" }],
        }),
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/ports?scope=windows",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      detail: expect.stringContaining("powershell failed"),
    });
  });

  it("returns 200 for a WSL scan with zero running distros", async () => {
    scanAndPersistMock.mockResolvedValue(
      persisted(
        scan({
          skipped: [{ distro: "Ubuntu", error: "not running (Stopped)" }],
        }),
      ),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/ports?scope=wsl",
      headers: { cookie: adminCookie },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { skipped: unknown[] }).skipped).toHaveLength(1);
  });
});
