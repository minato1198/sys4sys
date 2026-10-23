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
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import {
  createService,
  deployService,
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
