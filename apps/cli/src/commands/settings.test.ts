import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import { createBackup, getMailSettings, setMailSettings } from "./settings.js";
import { type CommandOptions } from "./services.js";

function baseOptions(
  memory: MemoryOutput,
  overrides: Partial<CommandOptions> = {},
): CommandOptions {
  return {
    json: false,
    showEnv: false,
    dryRun: false,
    yes: false,
    wait: false,
    output: memory.output,
    ...overrides,
  };
}

async function writeJson(
  dir: string,
  name: string,
  value: unknown,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

test("settings mail get does not request or print a password", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/settings/mail") {
      json(response, {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        username: "alerts",
        from: "alerts@example.com",
        recipients: ["ops@example.com"],
        mode: "immediate",
        passwordSet: true,
      });
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await getMailSettings(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      [],
      baseOptions(memory),
    );
    assert.match(memory.out, /Password:\s*set/);
    assert.ok(!memory.out.toLowerCase().includes("secret"));
  } finally {
    await server.close();
  }
});

test("settings mail set requires --file", async () => {
  const memory = memoryOutput();
  await assert.rejects(
    setMailSettings(
      new ApiClient({ apiUrl: "http://127.0.0.1:1", sessionCookie: "test" }),
      [],
      baseOptions(memory),
    ),
    UsageError,
  );
});

test("settings mail set --dry-run redacts password and makes no API call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-settings-"));
  const server = await startTestServer((request, response) => {
    json(response, { ok: true });
  });
  const file = await writeJson(dir, "mail.json", {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    from: "alerts@example.com",
    recipients: ["ops@example.com"],
    password: "secret",
  });

  const memory = memoryOutput();
  try {
    await setMailSettings(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      [],
      baseOptions(memory, { json: true, dryRun: true, file }),
    );
    assert.equal(server.requests.length, 0);
    const payload = JSON.parse(memory.out);
    assert.equal(payload.mail.password, "***");
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings mail set requires --yes in non-interactive mode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-settings-"));
  const server = await startTestServer((request, response) => {
    json(response, { ok: true });
  });
  const file = await writeJson(dir, "mail.json", {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    from: "alerts@example.com",
    recipients: ["ops@example.com"],
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      setMailSettings(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        [],
        baseOptions(memory, { file }),
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings mail set --yes PUTs mail settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sys4sys-settings-"));
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "PUT" && url.pathname === "/api/settings/mail") {
      json(response, {
        host: "smtp.example.com",
        port: 587,
        secure: false,
        from: "alerts@example.com",
        recipients: ["ops@example.com"],
        mode: "immediate",
        passwordSet: true,
      });
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });
  const file = await writeJson(dir, "mail.json", {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    from: "alerts@example.com",
    recipients: ["ops@example.com"],
    password: "secret",
    clearPassword: false,
  });

  const memory = memoryOutput();
  try {
    await setMailSettings(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      [],
      { ...baseOptions(memory), file, yes: true },
    );
    assert.equal(server.requests[0]?.method, "PUT");
    assert.equal(
      (server.lastBody() as Record<string, unknown>).password,
      "secret",
    );
    assert.match(memory.out, /mail settings updated/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings backup requires --yes in non-interactive mode", async () => {
  const server = await startTestServer((request, response) => {
    json(response, { path: "backup.db", sizeBytes: 12 });
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      createBackup(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        [],
        baseOptions(memory),
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("settings backup --yes prints path and size", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "POST" && url.pathname === "/api/admin/backup") {
      json(response, { path: "backup.db", sizeBytes: 12 });
      return;
    }

    json(
      response,
      { type: "about:blank", title: "Not Found", status: 404, detail: "no" },
      404,
    );
  });

  const memory = memoryOutput();
  try {
    await createBackup(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      [],
      { ...baseOptions(memory), yes: true },
    );
    assert.match(memory.out, /backup.db/);
    assert.match(memory.out, /12 bytes/);
  } finally {
    await server.close();
  }
});
