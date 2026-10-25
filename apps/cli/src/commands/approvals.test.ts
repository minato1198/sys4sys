import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import { approveApproval, listApprovals, rejectApproval } from "./approvals.js";
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

function approvalItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "apr-1",
    incidentId: "inc-1",
    requestedAction: { type: "restart", serviceId: "svc-1", reason: "down" },
    status: "pending",
    requestedAt: "2026-10-01T00:00:00.000Z",
    requestedBy: null,
    decidedBy: null,
    decidedAt: null,
    note: null,
    incident: {
      id: "inc-1",
      title: "service down",
      severity: "error",
      status: "open",
    },
    service: { id: "svc-1", name: "demo", status: "stopped" },
    ...overrides,
  };
}

test("approvals list maps status filter to API", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/approvals") {
      json(response, { items: [approvalItem()], total: 1 });
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
    await listApprovals(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, { status: "approved", limit: "20", json: true }),
    );
    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("status"), "approved");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(JSON.parse(memory.out).total, 1);
  } finally {
    await server.close();
  }
});

test("approvals approve shows target and requires --yes when non-interactive", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/approvals") {
      json(response, { items: [approvalItem()], total: 1 });
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
      approveApproval(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["apr-1"],
        baseOptions(memory),
      ),
      UsageError,
    );
    assert.match(memory.out, /ID:.*apr-1/);
    assert.match(memory.out, /system/);
    assert.equal(
      server.requests.some((request) => request.method === "POST"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("approvals approve --yes sends note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/approvals/apr-1/approve"
    ) {
      json(response, {
        approval: approvalItem({ status: "approved" }),
        action: { id: "act-1", status: "running" },
        incident: { id: "inc-1", status: "acked" },
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
    await approveApproval(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["apr-1"],
      { ...baseOptions(memory), yes: true, note: "ok" },
    );
    assert.deepEqual(server.lastBody(), { note: "ok" });
    assert.match(memory.out, /approval approved/);
    assert.match(memory.out, /act-1/);
  } finally {
    await server.close();
  }
});

test("approvals reject --yes posts a note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/approvals/apr-1/reject"
    ) {
      json(response, {
        approval: approvalItem({ status: "rejected" }),
        action: null,
        incident: { id: "inc-1", status: "open" },
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
    await rejectApproval(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["apr-1"],
      { ...baseOptions(memory, { json: true }), yes: true, note: "no" },
    );
    assert.deepEqual(server.lastBody(), { note: "no" });
    assert.equal(JSON.parse(memory.out).approval.status, "rejected");
  } finally {
    await server.close();
  }
});
