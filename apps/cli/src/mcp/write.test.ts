import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AuthMe } from "@sys4sys/shared";
import { ApiError } from "../client.js";
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

async function connect(fake: FakeClient, allowWrite = true) {
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

const allWriteScopes = [
  "services:read",
  "services:operate",
  "deploy:execute",
  "incidents:read",
  "incidents:write",
  "approvals:read",
  "approvals:decide",
];

test("write tools are hidden without --allow-write", async () => {
  const fake = new FakeClient(allWriteScopes);
  const connected = await connect(fake, false);
  try {
    const tools = await connected.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.equal(
      names.some((name) => name.includes("start_service")),
      false,
    );
    assert.equal(
      names.some((name) => name.includes("deploy_service")),
      false,
    );
    assert.equal(
      names.some((name) => name.includes("approve_deploy_request")),
      false,
    );
  } finally {
    await connected.client.close();
  }
});

test("write tools are filtered by scopes even with --allow-write", async () => {
  const fake = new FakeClient([
    "services:read",
    "services:operate",
    "logs:read",
  ]);
  const connected = await connect(fake, true);
  try {
    const tools = await connected.client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes("sys4sys_start_service"));
    assert.ok(names.includes("sys4sys_stop_service"));
    assert.ok(names.includes("sys4sys_restart_service"));
    assert.equal(names.includes("sys4sys_deploy_service"), false);
    assert.equal(names.includes("sys4sys_ack_incident"), false);
    assert.equal(names.includes("sys4sys_approve_deploy_request"), false);
  } finally {
    await connected.client.close();
  }
});

test("destructive write tools require confirm=true and do not call the API otherwise", async () => {
  const fake = new FakeClient(allWriteScopes, () => ({ ok: true }));
  const connected = await connect(fake);
  try {
    const missing = await connected.client.callTool({
      name: "sys4sys_start_service",
      arguments: { serviceId: "svc-1" },
    });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /confirm/);
    assert.equal(fake.requests.length, 0);

    const explicitFalse = await connected.client.callTool({
      name: "sys4sys_start_service",
      arguments: { serviceId: "svc-1", confirm: false },
    });
    assert.equal(explicitFalse.isError, true);
    assert.equal(fake.requests.length, 0);

    const accepted = await connected.client.callTool({
      name: "sys4sys_start_service",
      arguments: { serviceId: "svc-1", confirm: true },
    });
    assert.notEqual(accepted.isError, true);
    assert.deepEqual(fake.requests[0], {
      method: "POST",
      path: "/api/services/svc-1/start",
      body: undefined,
    });
  } finally {
    await connected.client.close();
  }
});

test("stop and restart map to the correct API actions", async () => {
  const fake = new FakeClient(allWriteScopes, (method, path) => ({
    method,
    path,
  }));
  const connected = await connect(fake);
  try {
    for (const [tool, action] of [
      ["sys4sys_stop_service", "stop"],
      ["sys4sys_restart_service", "restart"],
    ] as const) {
      const result = await connected.client.callTool({
        name: tool,
        arguments: { serviceId: "svc 1", confirm: true },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(JSON.parse(textOf(result)), {
        method: "POST",
        path: `/api/services/svc%201/${action}`,
      });
    }
  } finally {
    await connected.client.close();
  }
});

test("deploy creates an approval request without executing the deploy", async () => {
  const fake = new FakeClient(allWriteScopes, (method, path) => {
    if (method === "GET" && path === "/api/services/svc-1") {
      return {
        id: "svc-1",
        deploy: { requireApproval: true, command: ["node", "server.js"] },
      };
    }
    if (method === "POST" && path === "/api/services/svc-1/deploy-requests") {
      return { id: "req-1", status: "pending" };
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_deploy_service",
      arguments: { serviceId: "svc-1", confirm: true, note: "release" },
    });
    assert.notEqual(result.isError, true);
    const parsed = JSON.parse(textOf(result)) as {
      status: string;
      autoApproved: boolean;
      deployRequestId: string;
    };
    assert.equal(parsed.status, "approval_required");
    assert.equal(parsed.autoApproved, false);
    assert.equal(parsed.deployRequestId, "req-1");
    assert.equal(
      fake.requests.some((request) => request.path.endsWith("/deploy")),
      false,
    );
    assert.deepEqual(fake.requests.at(-1)?.body, { note: "release" });
  } finally {
    await connected.client.close();
  }
});

test("deploy executes directly when approval is not required", async () => {
  const fake = new FakeClient(allWriteScopes, (method, path) => {
    if (method === "GET" && path === "/api/services/svc-1") {
      return {
        id: "svc-1",
        deploy: { requireApproval: false, command: ["node", "server.js"] },
      };
    }
    if (method === "POST" && path === "/api/services/svc-1/deploy") {
      return { id: "action-1", type: "deploy", status: "succeeded" };
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  });
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_deploy_service",
      arguments: { serviceId: "svc-1", confirm: true },
    });
    assert.notEqual(result.isError, true);
    assert.equal(fake.requests.at(-1)?.path, "/api/services/svc-1/deploy");
  } finally {
    await connected.client.close();
  }
});

test("self-approval rejection is returned as an MCP error", async () => {
  const fake = new FakeClient(allWriteScopes, () => {
    throw new ApiError(403, "Forbidden", "自己承認は許可されていません", {
      deployRequestId: "req-1",
    });
  });
  const connected = await connect(fake);
  try {
    const result = await connected.client.callTool({
      name: "sys4sys_approve_deploy_request",
      arguments: { deployRequestId: "req-1", confirm: true },
    });
    assert.equal(result.isError, true);
    const text = textOf(result);
    assert.match(text, /403/);
    assert.match(text, /自己承認/);
    assert.match(text, /req-1/);
  } finally {
    await connected.client.close();
  }
});

test("incident ack does not need confirm but resolve does", async () => {
  const fake = new FakeClient(allWriteScopes, (method, path) => ({
    method,
    path,
  }));
  const connected = await connect(fake);
  try {
    const ack = await connected.client.callTool({
      name: "sys4sys_ack_incident",
      arguments: { incidentId: "inc-1", note: "looking" },
    });
    assert.notEqual(ack.isError, true);
    assert.equal(fake.requests.at(-1)?.path, "/api/incidents/inc-1/ack");

    const blocked = await connected.client.callTool({
      name: "sys4sys_resolve_incident",
      arguments: { incidentId: "inc-1" },
    });
    assert.equal(blocked.isError, true);
    assert.equal(
      fake.requests.some((request) => request.path.endsWith("/resolve")),
      false,
    );

    const resolved = await connected.client.callTool({
      name: "sys4sys_resolve_incident",
      arguments: { incidentId: "inc-1", confirm: true },
    });
    assert.notEqual(resolved.isError, true);
    assert.equal(fake.requests.at(-1)?.path, "/api/incidents/inc-1/resolve");
  } finally {
    await connected.client.close();
  }
});
