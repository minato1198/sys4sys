import assert from "node:assert/strict";
import test from "node:test";
import { ApiClient } from "../client.js";
import { ApiError } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput, type MemoryOutput } from "../test-output.js";
import { json, queryOf, startTestServer } from "../test-server.js";
import { createHost, detectHosts, getHost, updateHost } from "./hosts.js";
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

function hostResponse() {
  return {
    id: "host-1",
    kind: "windows",
    name: "windows",
    distro: null,
    defaultUser: null,
    enabled: true,
    state: "running",
    distroState: null,
  };
}

test("hosts get requests host detail", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "GET" && url.pathname === "/api/hosts/host-1") {
      json(response, hostResponse());
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
    await getHost(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["host-1"],
      baseOptions(memory),
    );
    assert.match(memory.out, /host-1/);
  } finally {
    await server.close();
  }
});

test("hosts create rejects WSL hosts without --distro before calling API", async () => {
  const server = await startTestServer((request, response) => {
    json(response, hostResponse());
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      createHost(new ApiClient({ apiUrl: server.url, sessionCookie: "test" }), {
        ...baseOptions(memory),
        kind: "wsl",
        name: "Ubuntu",
      }),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("hosts create --dry-run validates without POST", async () => {
  const server = await startTestServer((request, response) => {
    json(response, hostResponse());
  });

  const memory = memoryOutput();
  try {
    await createHost(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      {
        ...baseOptions(memory, { json: true, dryRun: true }),
        kind: "windows",
        name: "local",
      },
    );
    assert.equal(server.requests.length, 0);
    assert.deepEqual(JSON.parse(memory.out), {
      dryRun: true,
      host: {
        kind: "windows",
        name: "local",
        enabled: true,
      },
    });
  } finally {
    await server.close();
  }
});

test("hosts create surfaces Windows duplicate conflicts", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "POST" && url.pathname === "/api/hosts") {
      json(
        response,
        {
          type: "about:blank",
          title: "Conflict",
          status: 409,
          detail: "Windows ホストは 1 つだけ登録できます",
        },
        409,
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
    await assert.rejects(
      createHost(new ApiClient({ apiUrl: server.url, sessionCookie: "test" }), {
        ...baseOptions(memory),
        kind: "windows",
        name: "duplicate",
      }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.detail.includes("Windows"),
    );
  } finally {
    await server.close();
  }
});

test("hosts detect lists WSL distros", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "POST" && url.pathname === "/api/hosts/wsl/detect") {
      json(response, [
        {
          name: "Ubuntu-22.04",
          state: "Running",
          version: 2,
          isDefault: true,
          registered: false,
        },
      ]);
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
    await detectHosts(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      baseOptions(memory),
    );
    assert.match(memory.out, /Ubuntu-22\.04/);
  } finally {
    await server.close();
  }
});

test("hosts update --disable requires --yes in non-interactive mode", async () => {
  const server = await startTestServer((request, response) => {
    json(response, { ...hostResponse(), enabled: false });
  });

  const memory = memoryOutput();
  try {
    await assert.rejects(
      updateHost(
        new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
        ["host-1"],
        { ...baseOptions(memory), disable: true },
      ),
      UsageError,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test("hosts update --disable --yes sends enabled false", async () => {
  const server = await startTestServer((request, response) => {
    const url = queryOf(request.url ?? "/");
    if (request.method === "PATCH" && url.pathname === "/api/hosts/host-1") {
      json(response, { ...hostResponse(), enabled: false });
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
    await updateHost(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["host-1"],
      { ...baseOptions(memory, { json: true }), yes: true, disable: true },
    );
    assert.deepEqual(server.lastBody(), { enabled: false });
    assert.equal(JSON.parse(memory.out).enabled, false);
  } finally {
    await server.close();
  }
});

test("hosts update --dry-run does not PATCH", async () => {
  const server = await startTestServer((request, response) => {
    json(response, hostResponse());
  });

  const memory = memoryOutput();
  try {
    await updateHost(
      new ApiClient({ apiUrl: server.url, sessionCookie: "test" }),
      ["host-1"],
      {
        ...baseOptions(memory, { json: true, dryRun: true }),
        name: "renamed",
        enable: true,
      },
    );
    assert.equal(server.requests.length, 0);
    assert.deepEqual(JSON.parse(memory.out).patch, {
      name: "renamed",
      enabled: true,
    });
  } finally {
    await server.close();
  }
});
