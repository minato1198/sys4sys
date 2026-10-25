import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, problem, queryOf, startTestServer } from "../test-server.js";
import {
  approveDeployRequest,
  getDeployRequest,
  listDeployRequests,
  rejectDeployRequest,
} from "./deploy-requests.js";
import { deployService, type CommandOptions } from "./services.js";

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

function serviceResponse() {
  return {
    id: "svc-1",
    hostId: "host-1",
    name: "demo-api",
    command: ["node.exe", "dist/server.js"],
    cwd: "C:\\work\\demo-api",
    env: { PORT: "4100" },
    expectedPorts: [4100],
    healthCheck: null,
    deploy: {
      command: ["pwsh.exe", "-File", "deploy.ps1"],
      cwd: "C:\\work\\demo-api",
      env: { DEPLOY_TOKEN: "secret" },
      timeoutSec: 600,
      restartAfter: true,
      healthTimeoutSec: 120,
      requireApproval: true,
    },
    dependsOn: [],
    autoStart: false,
    autoRestartPhase: "observe",
    status: "stopped",
    isActive: true,
    pid: null,
    pidScope: null,
    lastStartedAt: null,
    lastExitedAt: null,
    lastExitCode: null,
    lastError: null,
    lastDeployAt: null,
    lastDeployStatus: null,
    lastDeployError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    host: {
      id: "host-1",
      kind: "windows",
      name: "windows",
      distro: null,
      defaultUser: null,
      enabled: true,
      state: "running",
    },
    health: { status: "unknown" },
    runtime: {},
    recentActions: [],
  };
}

function deployRequestResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    serviceId: "svc-1",
    requestedBy: "usr-1",
    requestedAt: "2026-10-01T00:00:00.000Z",
    status: "pending",
    decidedBy: null,
    decidedAt: null,
    note: null,
    actionId: null,
    snapshot: {
      command: ["pwsh.exe", "-File", "deploy.ps1"],
      cwd: "C:\\work\\demo-api",
      timeoutSec: 600,
      restartAfter: true,
      healthTimeoutSec: 120,
      envHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      deployEnvHash:
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
    expiresAt: "2026-10-02T00:00:00.000Z",
    service: { id: "svc-1", name: "demo-api" },
    ...overrides,
  };
}

test("services deploy --request creates a deploy request", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/services/svc-1") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/services/svc-1/deploy-requests"
    ) {
      json(response, deployRequestResponse(), 201);
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
    await deployService(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["svc-1"],
      baseOptions(memory, { request: true, note: "release" }),
    );
    assert.equal(server.requests[1]?.method, "POST");
    assert.deepEqual(server.lastBody(), { note: "release" });
    assert.match(memory.out, /deploy request created: req-1/);
  } finally {
    await server.close();
  }
});

test("services deploy surfaces approval_required with guidance", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/services/svc-1") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/services/svc-1/deploy"
    ) {
      problem(response, 409, "Conflict", "approval_required", {
        deployRequestId: "req-1",
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
    await assert.rejects(
      deployService(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["svc-1"],
        { ...baseOptions(memory), yes: true },
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.exitCode === 4 &&
        /sys4sys services deploy svc-1 --request/.test(error.message),
    );
  } finally {
    await server.close();
  }
});

test("deploy-requests list maps status filter", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/deploy-requests") {
      json(response, { items: [deployRequestResponse()], total: 1 });
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
    await listDeployRequests(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, { json: true, status: "approved", limit: "20" }),
    );
    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("status"), "approved");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(JSON.parse(memory.out).total, 1);
  } finally {
    await server.close();
  }
});

test("deploy-requests approve shows target and requires --yes when non-interactive", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/deploy-requests/req-1"
    ) {
      json(response, deployRequestResponse());
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
      approveDeployRequest(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["req-1"],
        baseOptions(memory),
      ),
      UsageError,
    );
    assert.match(memory.out, /demo-api/);
    assert.equal(
      server.requests.some((request) => request.method === "POST"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("deploy-requests approve --yes sends note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/deploy-requests/req-1/approve"
    ) {
      json(response, {
        request: deployRequestResponse({ status: "approved" }),
        action: { id: "act-1", status: "running" },
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
    await approveDeployRequest(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["req-1"],
      { ...baseOptions(memory), yes: true, note: "release" },
    );
    assert.deepEqual(server.lastBody(), { note: "release" });
    assert.match(memory.out, /deploy request approved/);
  } finally {
    await server.close();
  }
});

test("deploy-requests reject --yes posts a note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/deploy-requests/req-1/reject"
    ) {
      json(response, {
        request: deployRequestResponse({ status: "rejected" }),
        action: null,
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
    await rejectDeployRequest(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["req-1"],
      { ...baseOptions(memory, { json: true }), yes: true, note: "blocked" },
    );
    assert.deepEqual(server.lastBody(), { note: "blocked" });
    assert.equal(JSON.parse(memory.out).request.status, "rejected");
  } finally {
    await server.close();
  }
});

test("deploy-requests get fetches one request", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "GET" &&
      url.pathname === "/api/deploy-requests/req-1"
    ) {
      json(response, deployRequestResponse());
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
    await getDeployRequest(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["req-1"],
      baseOptions(memory),
    );
    assert.match(memory.out, /ID:         req-1/);
  } finally {
    await server.close();
  }
});

test("deploy-requests approve --wait polls until executed", async () => {
  let approvedResponseSent = false;
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/deploy-requests/req-1/approve"
    ) {
      approvedResponseSent = true;
      json(response, {
        request: deployRequestResponse({
          status: "approved",
          actionId: "act-1",
        }),
        action: { id: "act-1", status: "running" },
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/deploy-requests/req-1"
    ) {
      json(
        response,
        deployRequestResponse({
          status: approvedResponseSent ? "executed" : "approved",
          actionId: "act-1",
        }),
      );
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
    const exitCode = await approveDeployRequest(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["req-1"],
      { ...baseOptions(memory), yes: true, wait: true, timeout: "5" },
    );
    assert.equal(exitCode, 0);
    assert.match(memory.out, /deploy request approved/);
    assert.deepEqual(
      server.requests.map((request) => request.method),
      ["POST", "GET"],
    );
  } finally {
    await server.close();
  }
});
