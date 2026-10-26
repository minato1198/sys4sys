import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthMe } from "@sys4sys/shared";
import { ApiError } from "../client.js";
import { runMcpCommand } from "../commands/mcp.js";
import { createMcpServer } from "./server.js";
import type { McpClient } from "./types.js";

type Responder = (
  method: string,
  path: string,
  body?: unknown,
) => unknown | Promise<unknown>;

class FakeClient implements McpClient {
  readonly requests: Array<{ method: string; path: string; body?: unknown }> =
    [];

  constructor(
    private readonly scopes: string[],
    private readonly responder: Responder = () => ({}),
  ) {}

  async whoami(): Promise<AuthMe> {
    return {
      id: "user-1",
      email: "operator@example.local",
      name: "Operator",
      role: "operator",
      authMethod: "token",
      scopes: this.scopes as AuthMe["scopes"],
      token: { id: "token-1", name: "test", prefix: "s4s_test" },
    };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.requests.push({ method, path, body });
    return (await this.responder(method, path, body)) as T;
  }
}

async function connect(fake: FakeClient, allowWrite = false) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const created = await createMcpServer({ client: fake, allowWrite });
  await created.server.connect(serverTransport);
  const client = new Client({ name: "sys4sys-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, ...created };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = (
    result as {
      content?: Array<{ type: string; text?: string }>;
    }
  ).content;
  const first = content?.[0];
  assert.equal(first?.type, "text");
  return first?.text ?? "";
}

test("MCP read server exposes read tools and hides write tools by default", async () => {
  const fake = new FakeClient([
    "services:read",
    "logs:read",
    "incidents:read",
    "approvals:read",
    "services:operate",
    "deploy:execute",
    "incidents:write",
    "approvals:decide",
  ]);
  const connected = await connect(fake);
  try {
    const tools = await connected.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.deepEqual(new Set(names), new Set(connected.toolNames));
    assert.ok(names.includes("sys4sys_whoami"));
    assert.ok(names.includes("sys4sys_list_services"));
    assert.ok(names.includes("sys4sys_get_service"));
    assert.ok(names.includes("sys4sys_query_logs"));
    assert.ok(names.includes("sys4sys_list_incidents"));
    assert.ok(names.includes("sys4sys_get_incident"));
    assert.ok(names.includes("sys4sys_list_approvals"));
    assert.ok(names.includes("sys4sys_schema"));
    assert.equal(
      names.some((name) => name.includes("start_service")),
      false,
    );

    const logTool = tools.tools.find(
      (tool) => tool.name === "sys4sys_query_logs",
    );
    assert.equal(logTool?.inputSchema.type, "object");
    assert.equal(
      (
        logTool?.inputSchema.properties?.limit as
          { maximum?: number } | undefined
      )?.maximum,
      200,
    );
  } finally {
    await connected.client.close();
  }
});

test("MCP tools are filtered by token scopes", async () => {
  const fake = new FakeClient(["logs:read"]);
  const connected = await connect(fake, true);
  try {
    const tools = await connected.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.deepEqual(
      new Set(names),
      new Set(["sys4sys_whoami", "sys4sys_query_logs", "sys4sys_schema"]),
    );
  } finally {
    await connected.client.close();
  }
});

test("sys4sys_query_logs builds the API query", async () => {
  const fake = new FakeClient(["logs:read"], (method, path) => {
    assert.equal(method, "GET");
    assert.match(path, /^\/api\/logs\?/);
    assert.match(path, /serviceId=svc-1/);
    assert.match(path, /level=error/);
    assert.match(path, /q=timeout/);
    assert.match(path, /limit=200/);
    return { items: [], nextCursor: null };
  });
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_query_logs",
      arguments: {
        serviceId: "svc-1",
        level: "error",
        q: "timeout",
        limit: 200,
      },
    });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(textOf(result)), {
      items: [],
      nextCursor: null,
    });
  } finally {
    await connected.client.close();
  }
});

test("MCP service detail never reveals env values", async () => {
  const fake = new FakeClient(["services:read"], () => ({
    id: "svc-1",
    name: "api",
    env: { API_TOKEN: "top-secret-value" },
    envKeys: ["API_TOKEN"],
    deploy: {
      command: ["node", "server.js"],
      env: { DB_PASSWORD: "hunter2" },
      envKeys: ["DB_PASSWORD"],
    },
  }));
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_get_service",
      arguments: { serviceId: "svc-1" },
    });
    const text = textOf(result);
    assert.doesNotMatch(text, /top-secret-value/);
    assert.doesNotMatch(text, /hunter2/);
    assert.match(text, /API_TOKEN/);
    assert.match(text, /DB_PASSWORD/);
    const parsed = JSON.parse(text) as {
      env?: unknown;
      deploy: { env?: unknown };
    };
    assert.equal(parsed.env, undefined);
    assert.equal(parsed.deploy.env, undefined);
  } finally {
    await connected.client.close();
  }
});

test("API 401/403 becomes an MCP tool error without a stack trace", async () => {
  const fake = new FakeClient(["logs:read"], () => {
    throw new ApiError(403, "Forbidden", "denied", {
      requiredScope: "logs:read",
    });
  });
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_query_logs",
      arguments: { limit: 10 },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /403/);
    assert.match(text, /logs:read/);
    assert.doesNotMatch(text, /at .*server\.ts/);
    assert.doesNotMatch(text, /stack/i);
  } finally {
    await connected.client.close();
  }
});

test("mcp serve writes startup failures to stderr only", async () => {
  let stderr = "";
  const code = await runMcpCommand({
    env: {},
    stderr: (text) => {
      stderr += text;
    },
  });
  assert.equal(code, 3);
  assert.match(stderr, /SYS4SYS_TOKEN/);
});
