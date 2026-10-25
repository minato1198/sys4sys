import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, problem, queryOf, startTestServer } from "../test-server.js";
import { killPort } from "./ports.js";
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

function tokenResponse() {
  return {
    token: "tok-1",
    expiresAt: "2026-10-01T00:05:00.000Z",
    scope: "windows",
    pidScope: null,
    port: 3000,
    pid: 123,
    process: "node.exe",
  };
}

test("ports kill fetches a token and requires --yes before POSTing", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/ports/3000/kill-token"
    ) {
      json(response, tokenResponse());
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
    await assert.rejects(
      killPort(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["3000"],
        { ...baseOptions(memory), portScope: "windows", scope: ["windows"] },
      ),
      UsageError,
    );
    assert.match(memory.out, /pid=123/);
    assert.equal(
      server.requests.some((request) => request.method === "POST"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("ports kill --yes reuses the token and posts a kill action", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/ports/3000/kill-token"
    ) {
      json(response, tokenResponse());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ports/3000/kill") {
      json(response, {
        id: "act-1",
        type: "kill",
        status: "succeeded",
        error: null,
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
    await killPort(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["3000"],
      {
        ...baseOptions(memory, { json: true }),
        yes: true,
        portScope: "windows",
        scope: ["windows"],
      },
    );
    assert.deepEqual(
      server.requests.map((request) => request.method),
      ["GET", "POST"],
    );
    assert.deepEqual(server.lastBody(), {
      scope: "windows",
      pidScope: null,
      confirmToken: "tok-1",
      signal: "TERM",
      force: false,
    });
  } finally {
    await server.close();
  }
});

test("ports kill expired token prompts reissue", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/ports/3000/kill-token"
    ) {
      json(response, tokenResponse());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/ports/3000/kill") {
      problem(response, 400, "Bad Request", "確認トークンが無効です");
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
    await assert.rejects(
      killPort(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["3000"],
        {
          ...baseOptions(memory, { json: true }),
          yes: true,
          portScope: "windows",
          scope: ["windows"],
        },
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 4 &&
        /再実行/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test("ports kill validates --signal before fetching a token", async () => {
  const server = await startTestServer((request, response) => {
    json(response, tokenResponse());
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      killPort(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["3000"],
        {
          ...baseOptions(memory),
          yes: true,
          portScope: "windows",
          scope: ["windows"],
          killSignal: "HUP",
        },
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
