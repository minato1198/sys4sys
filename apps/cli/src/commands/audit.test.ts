import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import { listAudit } from "./audit.js";
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

test("audit list maps actor/action/target/time filters", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/audit-logs") {
      json(response, {
        items: [
          {
            id: "aud-1",
            actorUserId: "usr-1",
            actorLabel: "admin@example.com",
            action: "service.deploy",
            target: "service:svc-1",
            before: { deployRequestId: "req-1" },
            after: { actionId: "act-1" },
            reason: null,
            ip: "127.0.0.1",
            ts: "2026-10-01T00:00:00.000Z",
          },
        ],
        total: 1,
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
    await listAudit(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, {
        json: true,
        actor: "admin",
        action: "deploy",
        target: "svc-1",
        since: "2026-10-01T00:00:00Z",
        until: "2026-10-02T00:00:00Z",
        limit: "10",
        offset: "2",
      }),
    );

    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("actor"), "admin");
    assert.equal(url.searchParams.get("action"), "deploy");
    assert.equal(url.searchParams.get("target"), "svc-1");
    assert.equal(url.searchParams.get("from"), "2026-10-01T00:00:00Z");
    assert.equal(url.searchParams.get("to"), "2026-10-02T00:00:00Z");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("offset"), "2");
    assert.equal(JSON.parse(memory.out).items[0].action, "service.deploy");
  } finally {
    await server.close();
  }
});

test("audit list rejects invalid ISO time filters", async () => {
  const memory = memoryOutput();
  await assert.rejects(
    listAudit(
      new ApiClient({ apiUrl: "http://127.0.0.1:1", sessionCookie: "test" }),
      baseOptions(memory, { since: "not-iso" }),
    ),
    UsageError,
  );
});
