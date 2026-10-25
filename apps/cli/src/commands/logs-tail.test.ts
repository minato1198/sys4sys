import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ApiClient, ApiError } from "../client.js";
import { memoryOutput } from "../test-output.js";
import type { LogEvent } from "../types.js";
import { tailLogs } from "./logs.js";

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

function sseEvent(event: LogEvent): string {
  return `event: log\ndata: ${JSON.stringify(event)}\n\n`;
}

function logEvent(id: string, message: string): LogEvent {
  return {
    id,
    hostId: "host-1",
    serviceId: "service-1",
    ts: "2026-10-24T00:00:00.000Z",
    level: "info",
    stream: "stdout",
    message,
    fields: null,
    fingerprint: id,
  };
}

test("receives log events, ignores keep-alive, and honours --no-reconnect", async () => {
  let connections = 0;
  const server = await startServer((request, response) => {
    connections += 1;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
    });
    response.write(": connected\n\n");
    response.write(": keep-alive\n\n");
    response.write(sseEvent(logEvent("1", "first")));
    response.write(sseEvent(logEvent("2", "second")));
    response.end();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    const exitCode = await tailLogs(client, {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      noReconnect: true,
      output: capture.output,
    });

    assert.equal(exitCode, 0);
    assert.equal(connections, 1);
    const lines = capture.out.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /first$/);
    assert.match(lines[1] ?? "", /second$/);
  } finally {
    await server.close();
  }
});

test("--json emits NDJSON", async () => {
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseEvent(logEvent("1", "first")));
    response.end();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await tailLogs(client, {
      json: true,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      noReconnect: true,
      output: capture.output,
    });
    const parsed = JSON.parse(capture.out.trim()) as LogEvent;
    assert.equal(parsed.id, "1");
  } finally {
    await server.close();
  }
});

test("reconnects after a dropped stream", async () => {
  let connections = 0;
  const controller = new AbortController();
  const server = await startServer((request, response) => {
    connections += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (connections === 1) {
      response.write(sseEvent(logEvent("1", "first")));
      response.end();
      return;
    }
    response.write(sseEvent(logEvent("2", "second")));
    setTimeout(() => controller.abort(), 20).unref();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    const exitCode = await tailLogs(client, {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      signal: controller.signal,
      output: capture.output,
    });

    assert.equal(exitCode, 0);
    assert.equal(connections, 2);
    assert.match(capture.out, /first/);
    assert.match(capture.out, /second/);
  } finally {
    await server.close();
  }
});

test("does not reconnect on 401", async () => {
  let connections = 0;
  const server = await startServer((request, response) => {
    connections += 1;
    response.statusCode = 401;
    response.setHeader("Content-Type", "application/problem+json");
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "認証が必要です",
      }),
    );
  });

  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await assert.rejects(
      () =>
        tailLogs(client, {
          json: false,
          showEnv: false,
          dryRun: false,
          yes: false,
          wait: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 401);
        return true;
      },
    );
    assert.equal(connections, 1);
  } finally {
    await server.close();
  }
});

test("Ctrl+C aborts the stream and exits 0", async () => {
  const controller = new AbortController();
  const server = await startServer((request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(sseEvent(logEvent("1", "first")));
    setTimeout(() => controller.abort(), 20).unref();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    const exitCode = await tailLogs(client, {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      signal: controller.signal,
      output: capture.output,
    });
    assert.equal(exitCode, 0);
    assert.match(capture.out, /first/);
  } finally {
    await server.close();
  }
});

test("stops reconnecting after the configured maximum attempts", async () => {
  let connections = 0;
  const server = await startServer((request, response) => {
    connections += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end();
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await assert.rejects(
      () =>
        tailLogs(client, {
          json: false,
          showEnv: false,
          dryRun: false,
          yes: false,
          wait: false,
          reconnectDelayMs: 0,
          maxReconnectAttempts: 2,
          output: capture.output,
        }),
      (error: unknown) => {
        assert.match((error as Error).message, /再接続/);
        return true;
      },
    );
    assert.equal(connections, 3);
  } finally {
    await server.close();
  }
});
