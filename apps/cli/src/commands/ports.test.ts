import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import { listPorts, portHistory, releasePort, reservePort } from "./ports.js";
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

function portListResponse() {
  return {
    scannedAt: "2026-10-01T00:00:00.000Z",
    items: [
      {
        id: "windows:tcp:0.0.0.0:3000",
        scope: "windows",
        protocol: "tcp",
        address: "0.0.0.0",
        port: 3000,
        pid: 123,
        process: "node.exe",
        commandLine: "node server.js",
        serviceId: "svc-1",
        status: "in_use",
        conflict: false,
      },
      {
        id: "wsl:tcp:0.0.0.0:3000",
        scope: "wsl",
        protocol: "tcp",
        address: "0.0.0.0",
        port: 3000,
        pid: 456,
        process: "node",
        commandLine: null,
        serviceId: null,
        status: "conflict",
        conflict: true,
      },
    ],
    reservations: [
      {
        id: "res-1",
        scope: "windows",
        protocol: "tcp",
        port: 3100,
        serviceId: "svc-2",
        note: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        status: "reserved",
        inUse: false,
      },
    ],
    conflicts: [],
  };
}

test("ports list maps filters to API query parameters", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/ports") {
      json(response, portListResponse());
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
    await listPorts(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, {
        json: true,
        portScope: "wsl",
        scope: ["wsl"],
        protocol: "tcp",
        port: "3000",
        service: "svc-1",
        grep: "node",
      }),
    );

    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("scope"), "wsl");
    assert.equal(url.searchParams.get("protocol"), "tcp");
    assert.equal(url.searchParams.get("port"), "3000");
    assert.equal(url.searchParams.get("serviceId"), "svc-1");
    assert.equal(url.searchParams.get("q"), "node");
    assert.equal(JSON.parse(memory.out).items.length, 2);
  } finally {
    await server.close();
  }
});

test("ports list human output marks conflicts", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/ports") {
      json(response, portListResponse());
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
    await listPorts(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory),
    );
    assert.match(memory.out, /!\s*wsl/);
    assert.match(memory.out, /Reservations:/);
  } finally {
    await server.close();
  }
});

test("ports list rejects multiple --scope flags", async () => {
  const server = await startTestServer((request, response) => {
    json(response, portListResponse());
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      listPorts(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        baseOptions(memory, { scope: ["windows", "wsl"] }),
      ),
      UsageError,
    );
  } finally {
    await server.close();
  }
});

test("ports history requires scope and port and prints empty history", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/ports/history") {
      json(response, []);
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
    await portHistory(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, {
        portScope: "windows",
        scope: ["windows"],
        port: "3000",
        limit: "10",
      }),
    );
    const url = queryOf(server.requests[0]?.url ?? "");
    assert.equal(url.searchParams.get("scope"), "windows");
    assert.equal(url.searchParams.get("port"), "3000");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.match(memory.out, /history: none/);
  } finally {
    await server.close();
  }
});

test("ports history rejects invalid datetime filters", async () => {
  const memory = memoryOutput();
  await assert.rejects(
    portHistory(
      new ApiClient({ apiUrl: "http://127.0.0.1:1", sessionCookie: "test" }),
      baseOptions(memory, {
        portScope: "windows",
        scope: ["windows"],
        port: "3000",
        since: "yesterday",
      }),
    ),
    UsageError,
  );
});

test("ports reserve posts a valid reservation", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "POST" && url.pathname === "/api/ports/reserve") {
      json(
        response,
        {
          id: "res-1",
          scope: "windows",
          protocol: "tcp",
          port: 3100,
          serviceId: "svc-1",
          note: "demo",
          createdAt: "2026-10-01T00:00:00.000Z",
          status: "reserved",
          inUse: false,
        },
        201,
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
    await reservePort(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory, {
        portScope: "windows",
        scope: ["windows"],
        port: "3100",
        protocol: "tcp",
        service: "svc-1",
        note: "demo",
      }),
    );
    assert.deepEqual(server.lastBody(), {
      scope: "windows",
      port: 3100,
      protocol: "tcp",
      serviceId: "svc-1",
      note: "demo",
    });
    assert.match(memory.out, /reservation created/);
  } finally {
    await server.close();
  }
});

test("ports release requires --yes in non-interactive mode", async () => {
  const server = await startTestServer((request, response) => {
    response.statusCode = 204;
    response.end();
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      releasePort(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["res-1"],
        baseOptions(memory),
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("ports release --yes DELETEs the reservation", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (
      request.method === "DELETE" &&
      url.pathname === "/api/ports/reserve/res-1"
    ) {
      response.statusCode = 204;
      response.end();
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
    await releasePort(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["res-1"],
      { ...baseOptions(memory, { json: true }), yes: true },
    );
    assert.equal(server.requests[0]?.method, "DELETE");
    assert.deepEqual(JSON.parse(memory.out), { released: true, id: "res-1" });
  } finally {
    await server.close();
  }
});
