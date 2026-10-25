import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiClient, ApiError } from "../client.js";
import { AuthError, UsageError } from "../errors.js";
import { memoryOutput } from "../test-output.js";
import {
  createService,
  deployService,
  getService,
  parseLimit,
  runServiceLifecycle,
  type CommandOptions,
} from "./services.js";

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function json(response: ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function serviceResponse() {
  return {
    id: "service-1",
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

function options(file: string): CommandOptions {
  return {
    json: true,
    showEnv: false,
    dryRun: true,
    yes: false,
    wait: false,
    file,
    output: memoryOutput().output,
  };
}

test("services create dry-run validates and redacts env", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/hosts") {
      json(response, [
        {
          id: "host-1",
          kind: "windows",
          name: "windows",
          distro: null,
          defaultUser: null,
          enabled: true,
          state: "running",
        },
      ]);
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const dir = await mkdtemp(join(tmpdir(), "sys4sys-cli-"));
  const file = join(dir, "service.json");
  await writeFile(
    file,
    JSON.stringify({
      hostId: "host-1",
      name: "demo-api",
      command: ["node.exe", "dist/server.js"],
      cwd: "C:\\work\\demo-api",
      env: { PORT: "4100" },
      deploy: {
        command: ["pwsh.exe", "-File", "deploy.ps1"],
        env: { DEPLOY_TOKEN: "secret" },
      },
    }),
  );

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await createService(client, options(file));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("services deploy --dry-run shows the configured command", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1") {
      json(response, serviceResponse());
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await deployService(client, ["service-1"], options("unused.json"));
  } finally {
    await server.close();
  }
});

test("services deploy returns a failure exit code when the action fails", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/deploy" &&
      request.method === "POST"
    ) {
      json(response, {
        id: "action-1",
        incidentId: null,
        serviceId: "service-1",
        type: "deploy",
        status: "failed",
        requestedBy: "user-1",
        approvedBy: null,
        policyId: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        error: "deploy failed",
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await deployService(client, ["service-1"], {
      ...options("unused.json"),
      dryRun: false,
      yes: true,
      json: false,
    });

    assert.equal(exitCode, 5);
  } finally {
    await server.close();
  }
});

function actionResponse(status = "succeeded"): Record<string, unknown> {
  return {
    id: "action-1",
    incidentId: null,
    serviceId: "service-1",
    type: "start",
    status,
    requestedBy: "user-1",
    approvedBy: null,
    policyId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: status === "running" ? null : "2026-01-01T00:00:05.000Z",
    error: status === "failed" ? "failed to start" : null,
  };
}

test("services start returns the action without --yes", async () => {
  let posted = "";
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/start" &&
      request.method === "POST"
    ) {
      posted = request.url;
      json(response, actionResponse());
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle("start", client, ["service-1"], {
      ...options("unused.json"),
      dryRun: false,
    });
    assert.equal(exitCode, 0);
    assert.equal(posted, "/api/services/service-1/start");
  } finally {
    await server.close();
  }
});

test("services stop refuses a non-interactive run without --yes", async () => {
  let posted = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/stop" &&
      request.method === "POST"
    ) {
      posted += 1;
      json(response, actionResponse());
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await assert.rejects(
      () =>
        runServiceLifecycle("stop", client, ["service-1"], {
          ...options("unused.json"),
          dryRun: false,
          json: true,
        }),
      UsageError,
    );
    assert.equal(posted, 0);
  } finally {
    await server.close();
  }
});

test("services restart --dry-run never mutates", async () => {
  let posted = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (request.method === "POST") posted += 1;
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle(
      "restart",
      client,
      ["service-1"],
      {
        ...options("unused.json"),
        dryRun: true,
        json: true,
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(posted, 0);
  } finally {
    await server.close();
  }
});

test("services stop --wait polls the actions API by action id", async () => {
  let actionPolls = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/stop" &&
      request.method === "POST"
    ) {
      json(response, actionResponse("running"));
      return;
    }
    if (
      request.url?.startsWith("/api/services/service-1/actions?") &&
      request.method === "GET"
    ) {
      actionPolls += 1;
      json(response, {
        items: [actionResponse("succeeded"), actionResponse("running")],
        nextCursor: null,
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle("stop", client, ["service-1"], {
      ...options("unused.json"),
      dryRun: false,
      yes: true,
      wait: true,
      json: true,
      timeout: "1",
    });
    assert.equal(exitCode, 0);
    assert.equal(actionPolls, 1);
  } finally {
    await server.close();
  }
});

test("services restart --wait returns exit 5 when the action fails", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/restart" &&
      request.method === "POST"
    ) {
      json(response, actionResponse("running"));
      return;
    }
    if (
      request.url?.startsWith("/api/services/service-1/actions?") &&
      request.method === "GET"
    ) {
      json(response, {
        items: [actionResponse("failed")],
        nextCursor: null,
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle(
      "restart",
      client,
      ["service-1"],
      {
        ...options("unused.json"),
        dryRun: false,
        yes: true,
        wait: true,
        json: true,
        timeout: "1",
      },
    );
    assert.equal(exitCode, 5);
  } finally {
    await server.close();
  }
});

test("services actions sends limit and cursor and preserves JSON output", async () => {
  let url: string | undefined;
  const server = await startServer((request, response) => {
    url = request.url;
    json(response, {
      items: [actionResponse()],
      nextCursor: "2026-01-01T00:00:00.000Z|action-1",
    });
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle(
      "actions",
      client,
      ["service-1"],
      {
        ...options("unused.json"),
        dryRun: false,
        limit: "10",
        cursor: "2026-01-02T00:00:00.000Z|action-2",
        json: true,
        output: capture.output,
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(
      url,
      "/api/services/service-1/actions?limit=10&cursor=2026-01-02T00%3A00%3A00.000Z%7Caction-2",
    );

    const output = JSON.parse(capture.out) as {
      items: unknown[];
      nextCursor: string;
    };
    assert.equal(output.items.length, 1);
    assert.equal(output.nextCursor, "2026-01-01T00:00:00.000Z|action-1");
  } finally {
    await server.close();
  }
});

test("services delete --dry-run never calls DELETE", async () => {
  let deleted = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (request.method === "DELETE") deleted += 1;
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    const exitCode = await runServiceLifecycle(
      "delete",
      client,
      ["service-1"],
      {
        ...options("unused.json"),
        dryRun: true,
        json: true,
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(deleted, 0);
  } finally {
    await server.close();
  }
});

test("services delete surfaces a 409 conflict", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/problem+json");
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: "Conflict",
        status: 409,
        detail: "実行中のサービスは削除できません",
      }),
    );
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await assert.rejects(
      () =>
        runServiceLifecycle("delete", client, ["service-1"], {
          ...options("unused.json"),
          dryRun: false,
          yes: true,
          json: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 409);
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("validates lifecycle limits", () => {
  assert.equal(parseLimit(undefined, 50, 200), 50);
  assert.equal(parseLimit("10", 50, 200), 10);
  assert.throws(() => parseLimit("0", 50, 200), UsageError);
  assert.throws(() => parseLimit("201", 50, 200), UsageError);
});

test("services deploy validates --timeout before starting a deploy", async () => {
  let deployRequests = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, serviceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/deploy" &&
      request.method === "POST"
    ) {
      deployRequests += 1;
      json(response, { id: "action-1", status: "running" });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });

    await assert.rejects(
      () =>
        deployService(client, ["service-1"], {
          ...options("unused.json"),
          dryRun: false,
          yes: true,
          json: false,
          timeout: "not-a-number",
        }),
      UsageError,
    );
    assert.equal(deployRequests, 0);
  } finally {
    await server.close();
  }
});

function maskedServiceResponse() {
  const base = serviceResponse();
  return {
    ...base,
    env: { DATABASE_URL: "***" },
    envKeys: ["DATABASE_URL"],
    deploy: {
      ...base.deploy,
      env: { DEPLOY_TOKEN: "***" },
      envKeys: ["DEPLOY_TOKEN"],
    },
  };
}

test("services get --show-env calls the secrets endpoint and prints plaintext env", async () => {
  let secretsRequested = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, maskedServiceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/secrets" &&
      request.method === "GET"
    ) {
      secretsRequested += 1;
      json(response, {
        env: { DATABASE_URL: "plain-value" },
        deployEnv: { DEPLOY_TOKEN: "deploy-plain-value" },
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await getService(client, ["service-1"], {
      ...options("unused.json"),
      json: true,
      showEnv: true,
      output: capture.output,
    });

    assert.equal(secretsRequested, 1);
    const body = JSON.parse(capture.out) as {
      env: Record<string, string>;
      deploy: { env: Record<string, string> };
    };
    assert.deepEqual(body.env, { DATABASE_URL: "plain-value" });
    assert.deepEqual(body.deploy.env, { DEPLOY_TOKEN: "deploy-plain-value" });
    assert.match(
      capture.err,
      /警告: --show-env は secrets API 経由で平文 env を表示します/,
    );
  } finally {
    await server.close();
  }
});

test("services get --show-env maps a missing secrets scope to an auth error", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, maskedServiceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/secrets" &&
      request.method === "GET"
    ) {
      response.statusCode = 403;
      response.setHeader("Content-Type", "application/problem+json");
      response.end(
        JSON.stringify({
          type: "about:blank",
          title: "Forbidden",
          status: 403,
          detail: "この操作には services:secrets スコープが必要です",
          requiredScope: "services:secrets",
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await assert.rejects(
      () =>
        getService(client, ["service-1"], {
          ...options("unused.json"),
          json: true,
          showEnv: true,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal(
          error.message,
          "--show-env には admin 権限と services:secrets スコープが必要です",
        );
        return true;
      },
    );
  } finally {
    await server.close();
  }
});

test("services deploy --dry-run --show-env uses the secrets endpoint", async () => {
  let secretsRequested = 0;
  const server = await startServer((request, response) => {
    if (request.url === "/api/services/service-1" && request.method === "GET") {
      json(response, maskedServiceResponse());
      return;
    }
    if (
      request.url === "/api/services/service-1/secrets" &&
      request.method === "GET"
    ) {
      secretsRequested += 1;
      json(response, {
        env: { DATABASE_URL: "plain-value" },
        deployEnv: { DEPLOY_TOKEN: "deploy-plain-value" },
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "test-token",
    });
    await deployService(client, ["service-1"], {
      ...options("unused.json"),
      json: true,
      dryRun: true,
      showEnv: true,
      output: capture.output,
    });

    assert.equal(secretsRequested, 1);
    const body = JSON.parse(capture.out) as {
      deploy: { env: Record<string, string> };
    };
    assert.deepEqual(body.deploy.env, { DEPLOY_TOKEN: "deploy-plain-value" });
  } finally {
    await server.close();
  }
});
