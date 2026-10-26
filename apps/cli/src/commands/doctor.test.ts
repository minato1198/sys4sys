import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuthMe } from "@sys4sys/shared";
import { FileCredentialStore } from "../auth/store.js";
import { memoryOutput } from "../test-output.js";
import { collectDoctorChecks, runDoctor } from "./doctor.js";

const now = new Date("2026-10-26T00:00:00.000Z");

function me(scopes: string[] = ["services:read", "logs:read"]): AuthMe {
  return {
    id: "user-1",
    email: "operator@example.local",
    name: "Operator",
    role: "operator",
    authMethod: "token",
    scopes: scopes as AuthMe["scopes"],
    token: { id: "token-1", name: "ci", prefix: "s4s_ab12" },
  };
}

function healthFetch(status = 200, date = now): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ status: "ok" }), {
      status,
      headers: {
        "content-type": "application/json",
        date: date.toUTCString(),
      },
    })) as typeof fetch;
}

async function withStore(
  expiresAt: string | undefined,
  run: (store: FileCredentialStore) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-doctor-"));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  try {
    await store.save({
      apiUrl: "http://127.0.0.1:8787",
      token: "s4s_abcdefghijklmnopqrstuvwxyz0123456789",
      tokenPrefix: "s4s_ab12",
      tokenExpiresAt: expiresAt,
    });
    await run(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("doctor reports healthy auth, API, and config", async () => {
  await withStore("2026-11-30T00:00:00.000Z", async (store) => {
    const report = await collectDoctorChecks({
      store,
      env: {},
      now: () => now,
      nodeVersion: "22.14.0",
      platform: "win32",
      fetchImpl: healthFetch(),
      whoami: async () => me(),
      wslCheck: async () => true,
    });
    const byName = new Map(report.checks.map((check) => [check.name, check]));
    assert.equal(byName.get("node")?.status, "ok");
    assert.equal(byName.get("api")?.status, "ok");
    assert.equal(byName.get("auth")?.status, "ok");
    assert.equal(byName.get("scopes")?.status, "ok");
    assert.equal(byName.get("token-expires")?.status, "ok");
    assert.equal(byName.get("duplicate-credentials")?.status, "ok");
    assert.equal(byName.get("clock-skew")?.status, "ok");
    assert.equal(byName.get("config-dir")?.status, "ok");
    assert.equal(byName.get("wsl")?.status, "ok");
    assert.doesNotMatch(JSON.stringify(report), /s4s_abcdefghijklmnop/);
  });
});

test("doctor warns for a token expiring within seven days and errors after expiry", async () => {
  await withStore("2026-10-29T00:00:00.000Z", async (store) => {
    const warning = await collectDoctorChecks({
      store,
      env: {},
      now: () => now,
      platform: "linux",
      fetchImpl: healthFetch(),
      whoami: async () => me(),
    });
    assert.equal(
      warning.checks.find((check) => check.name === "token-expires")?.status,
      "warn",
    );
  });

  await withStore("2026-10-25T00:00:00.000Z", async (store) => {
    const expired = await collectDoctorChecks({
      store,
      env: {},
      now: () => now,
      platform: "linux",
      fetchImpl: healthFetch(),
      whoami: async () => me(),
    });
    assert.equal(
      expired.checks.find((check) => check.name === "token-expires")?.status,
      "error",
    );
  });
});

test("doctor does not crash when the API is unreachable", async () => {
  const output = memoryOutput();
  const code = await runDoctor({
    store: new FileCredentialStore(join(tmpdir(), "missing-doctor-check.json")),
    env: {
      SYS4SYS_TOKEN: "s4s_abcdefghijklmnopqrstuvwxyz0123456789",
    },
    now: () => now,
    platform: "win32",
    fetchImpl: (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch,
    whoami: async () => me(),
    wslCheck: async () => false,
    output: output.output,
  });
  assert.equal(code, 0);
  assert.match(output.out, /ERROR api/);
  assert.match(output.out, /skip\s+wsl/i);
  assert.doesNotMatch(output.out, /s4s_abcdefghijklmnop/);
});

test("doctor --strict fails on warnings and --json is machine-readable", async () => {
  await withStore("2026-10-28T00:00:00.000Z", async (store) => {
    const output = memoryOutput();
    const code = await runDoctor({
      store,
      env: {},
      json: true,
      strict: true,
      now: () => now,
      platform: "win32",
      fetchImpl: healthFetch(),
      whoami: async () => me(),
      wslCheck: async () => true,
      output: output.output,
    });
    assert.equal(code, 1);
    const parsed = JSON.parse(output.out) as {
      checks: { name: string; status: string }[];
    };
    assert.ok(parsed.checks.some((check) => check.name === "token-expires"));
  });
});
