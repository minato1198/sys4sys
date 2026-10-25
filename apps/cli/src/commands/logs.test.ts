import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput } from "../test-output.js";
import type { LogEvent } from "../types.js";
import {
  buildLogQuery,
  buildLogStreamQuery,
  formatLogLine,
  queryLogs,
} from "./logs.js";

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

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function logEvent(message = "hello"): LogEvent {
  return {
    id: "log-1",
    hostId: "host-1",
    serviceId: "service-1",
    ts: "2026-10-24T00:00:00.000Z",
    level: "error",
    stream: "stderr",
    message,
    fields: null,
    fingerprint: "abc",
  };
}

test("maps CLI flags to API query parameters", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  const query = buildLogQuery(
    {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      host: "host-1",
      service: "service-1",
      level: "error",
      grep: "ECONNRESET",
      since: "2h",
      until: "2026-10-24T11:00:00.000Z",
      limit: "20",
      cursor: "2026-10-24T10:00:00.000Z",
    },
    now,
  );

  assert.equal(query.hostId, "host-1");
  assert.equal(query.serviceId, "service-1");
  assert.equal(query.level, "error");
  assert.equal(query.q, "ECONNRESET");
  assert.equal(query.from, "2026-10-24T10:00:00.000Z");
  assert.equal(query.to, "2026-10-24T11:00:00.000Z");
  assert.equal(query.limit, 20);
  assert.equal(query.cursor, "2026-10-24T10:00:00.000Z");
});

test("rejects invalid levels and limits", () => {
  assert.throws(
    () =>
      buildLogQuery({
        json: false,
        showEnv: false,
        dryRun: false,
        yes: false,
        wait: false,
        level: "verbose",
      }),
    UsageError,
  );
  assert.throws(
    () =>
      buildLogQuery({
        json: false,
        showEnv: false,
        dryRun: false,
        yes: false,
        wait: false,
        limit: "501",
      }),
    UsageError,
  );
});

test("builds stream queries without limit and cursor", () => {
  const query = buildLogStreamQuery({
    json: false,
    showEnv: false,
    dryRun: false,
    yes: false,
    wait: false,
    service: "service-1",
    grep: "error",
  });
  assert.equal(query.serviceId, "service-1");
  assert.equal(query.q, "error");
  assert.equal("limit" in query, false);
});

test("formats and truncates log lines", () => {
  const line = formatLogLine(logEvent("x".repeat(250)));
  assert.match(line, /2026-10-24T00:00:00.000Z  error  service-1/);
  assert.ok(line.length < 260);
  assert.match(line, /…$/);

  const full = formatLogLine(logEvent("y".repeat(250)), true);
  assert.match(full, /y{250}$/);
});

test("queries logs, prints lines, and reports the next cursor", async () => {
  let received: URLSearchParams | undefined;
  const server = await startServer((request, response) => {
    received = new URL(request.url ?? "/", "http://localhost").searchParams;
    json(response, 200, {
      items: [logEvent()],
      nextCursor: "2026-10-23T00:00:00.000Z",
    });
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await queryLogs(client, {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      service: "service-1",
      level: "error",
      since: "2h",
      limit: "20",
      output: capture.output,
    });

    assert.equal(received?.get("serviceId"), "service-1");
    assert.equal(received?.get("level"), "error");
    assert.equal(received?.get("limit"), "20");
    assert.ok(received?.get("from"));
    assert.match(capture.out, /error {2}service-1 {2}hello/);
    assert.match(capture.err, /next: --cursor 2026-10-23T00:00:00.000Z/);
  } finally {
    await server.close();
  }
});

test("json output preserves the API shape", async () => {
  const page = {
    items: [logEvent()],
    nextCursor: null,
  };
  const server = await startServer((request, response) => {
    json(response, 200, page);
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await queryLogs(client, {
      json: true,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      output: capture.output,
    });
    assert.deepEqual(JSON.parse(capture.out), page);
  } finally {
    await server.close();
  }
});

test("prints an empty-result message", async () => {
  const server = await startServer((request, response) => {
    json(response, 200, { items: [], nextCursor: null });
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await queryLogs(client, {
      json: false,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      output: capture.output,
    });
    assert.match(capture.out, /ログはありません/);
  } finally {
    await server.close();
  }
});
