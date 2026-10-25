import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import {
  ackIncident,
  analyzeIncident,
  getIncident,
  listIncidents,
  resolveIncident,
} from "./incidents.js";
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

test("incidents list maps filters to API query parameters", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/incidents") {
      json(response, {
        items: [
          {
            id: "inc-1",
            serviceId: "svc-1",
            title: "disk full",
            severity: "error",
            status: "open",
            startedAt: "2026-10-01T00:00:00.000Z",
            resolvedAt: null,
            summary: null,
            pendingApprovalId: null,
            service: { id: "svc-1", name: "demo", status: "stopped" },
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
    await listIncidents(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, {
        json: true,
        status: "open",
        severity: "error",
        service: "svc-1",
        limit: "20",
        offset: "10",
      }),
    );

    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("status"), "open");
    assert.equal(url.searchParams.get("severity"), "error");
    assert.equal(url.searchParams.get("serviceId"), "svc-1");
    assert.equal(url.searchParams.get("limit"), "20");
    assert.equal(url.searchParams.get("offset"), "10");
    assert.equal(JSON.parse(memory.out).total, 1);
  } finally {
    await server.close();
  }
});

test("incidents list human output shows a summary total", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/incidents") {
      json(response, {
        items: [
          {
            id: "inc-1",
            serviceId: "svc-1",
            title: "short",
            severity: "warning",
            status: "acked",
            startedAt: null,
            resolvedAt: null,
            summary: null,
            pendingApprovalId: null,
            service: { id: "svc-1", name: "demo", status: "stopped" },
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
    await listIncidents(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory),
    );
    assert.match(memory.out, /short/);
    assert.match(memory.err, /total: 1/);
  } finally {
    await server.close();
  }
});

test("incidents get prints analysis summary by default", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/incidents/inc-1") {
      json(response, {
        id: "inc-1",
        serviceId: "svc-1",
        title: "disk full",
        severity: "error",
        status: "open",
        startedAt: null,
        resolvedAt: null,
        summary: null,
        pendingApprovalId: null,
        service: { id: "svc-1", name: "demo", status: "stopped" },
        events: [
          { id: "e1", ts: "2026-10-01T00:00:00.000Z", type: "detected" },
        ],
        approvals: [],
        actions: [],
        analysis: {
          result: {
            summary: "disk is full",
            rootCauseHypothesis: "log rotation missing",
            evidence: [{ quote: "ENOSPC" }],
            recommendedActions: [{ type: "clean_logs", detail: "rotate" }],
          },
        },
        report: { body: "report line 1\nreport line 2", createdAt: "" },
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
    await getIncident(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["inc-1"],
      baseOptions(memory),
    );
    assert.match(memory.out, /disk is full/);
    assert.match(memory.out, /全文は/);
    assert.ok(!memory.out.includes("log rotation missing"));
  } finally {
    await server.close();
  }
});

test("incidents resolve requires --yes in non-interactive mode", async () => {
  const server = await startTestServer((request, response) => {
    json(response, { ok: true });
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      resolveIncident(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["inc-1"],
        baseOptions(memory),
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("incidents resolve --yes posts a note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/incidents/inc-1/resolve"
    ) {
      json(response, { id: "inc-1", status: "resolved" });
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
    await resolveIncident(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["inc-1"],
      { ...baseOptions(memory, { json: true }), yes: true, note: "done" },
    );
    assert.deepEqual(server.lastBody(), { note: "done" });
    assert.deepEqual(JSON.parse(memory.out), { resolved: true, id: "inc-1" });
  } finally {
    await server.close();
  }
});

test("incidents ack posts a note", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/incidents/inc-1/ack"
    ) {
      json(response, { id: "inc-1", status: "acked" });
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
    await ackIncident(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["inc-1"],
      baseOptions(memory),
    );
    assert.match(memory.out, /incident acked/);
  } finally {
    await server.close();
  }
});

test("incidents analyze queues AI analysis", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "POST" &&
      url.pathname === "/api/incidents/inc-1/analyze"
    ) {
      json(response, { incidentId: "inc-1", queued: true, status: "queued" });
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
    await analyzeIncident(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["inc-1"],
      baseOptions(memory, { json: true }),
    );
    assert.deepEqual(JSON.parse(memory.out), {
      incidentId: "inc-1",
      queued: true,
      status: "queued",
    });
  } finally {
    await server.close();
  }
});
