import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileCredentialStore } from "../auth/store.js";
import { ApiClient, ApiError } from "../client.js";
import { UsageError } from "../errors.js";
import { memoryOutput } from "../test-output.js";
import {
  createToken,
  listTokens,
  parseExpiresIn,
  parseScopes,
  revokeToken,
} from "./tokens.js";

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

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

const createdToken = {
  id: "token-1",
  name: "ci",
  prefix: "s4s_abcd",
  scopes: ["services:read", "logs:read"],
  createdAt: "2026-10-24T00:00:00.000Z",
  expiresAt: "2027-01-22T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  token: `s4s_${"a".repeat(43)}`,
};

test("parses repeatable and comma-separated scopes without duplicates", () => {
  assert.deepEqual(
    parseScopes(["services:read,logs:read", "services:read", "hosts:read"]),
    ["services:read", "logs:read", "hosts:read"],
  );
  assert.throws(() => parseScopes([]), UsageError);
  assert.throws(() => parseScopes(["unknown:scope"]), UsageError);
});

test("validates token expiry days", () => {
  assert.equal(parseExpiresIn(undefined), 90);
  assert.equal(parseExpiresIn("1"), 1);
  assert.equal(parseExpiresIn("365"), 365);
  for (const value of ["0", "366", "1.5", "abc"]) {
    assert.throws(() => parseExpiresIn(value), UsageError);
  }
});

test("creates a token and saves it while removing the session cookie", async () => {
  let body: unknown;
  let authorization: string | undefined;
  let cookie: string | undefined;
  const server = await startServer(async (request, response) => {
    authorization = request.headers.authorization;
    cookie = request.headers.cookie;
    body = await readBody(request);
    json(response, 201, createdToken);
  });

  const directory = await mkdtemp(join(tmpdir(), "sys4sys-tokens-cli-"));
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  await store.save({
    apiUrl: server.url,
    sessionCookie: "old-session",
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "old-session",
    });
    await createToken(
      client,
      {
        json: true,
        showEnv: false,
        dryRun: false,
        yes: false,
        wait: false,
        name: "ci",
        scope: ["services:read,logs:read"],
        expiresIn: "90",
        save: true,
        output: capture.output,
      },
      {
        store,
        resolved: { source: "stored-cookie", stored: null },
      },
    );

    assert.equal(authorization, undefined);
    assert.equal(cookie, "sys4sys_session=old-session");
    assert.deepEqual(body, {
      name: "ci",
      scopes: ["services:read", "logs:read"],
      expiresInDays: 90,
    });

    const saved = await store.load();
    assert.equal(saved?.token, createdToken.token);
    assert.equal(saved?.tokenId, createdToken.id);
    assert.equal(saved?.tokenPrefix, createdToken.prefix);
    assert.equal(saved?.tokenExpiresAt, createdToken.expiresAt);
    assert.equal(saved?.sessionCookie, undefined);

    const output = JSON.parse(capture.out);
    assert.equal(output.token, createdToken.token);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await server.close();
  }
});

test("list output never contains the raw token", async () => {
  const server = await startServer((request, response) => {
    json(response, 200, [
      {
        id: "token-1",
        name: "ci",
        prefix: "s4s_abcd",
        scopes: ["services:read"],
        createdAt: "2026-10-24T00:00:00.000Z",
        expiresAt: "2027-01-22T00:00:00.000Z",
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
  });

  const capture = memoryOutput();
  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await listTokens(client, {
      json: true,
      showEnv: false,
      dryRun: false,
      yes: false,
      wait: false,
      output: capture.output,
    });
    assert.doesNotMatch(capture.out, /"token"\s*:/);
    assert.match(capture.out, /s4s_abcd/);
  } finally {
    await server.close();
  }
});

test("revoke requires --yes outside an interactive terminal", async () => {
  let requests = 0;
  const server = await startServer((request, response) => {
    requests += 1;
    json(response, 204, {});
  });

  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await assert.rejects(
      () =>
        revokeToken(client, ["token-1"], {
          json: true,
          showEnv: false,
          dryRun: false,
          yes: false,
          wait: false,
        }),
      UsageError,
    );
    assert.equal(requests, 0);
  } finally {
    await server.close();
  }
});

test("surfaces a 403 requiredScope from the API", async () => {
  const server = await startServer((request, response) => {
    response.statusCode = 403;
    response.setHeader("Content-Type", "application/problem+json");
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "この操作には tokens:manage スコープが必要です",
        requiredScope: "tokens:manage",
      }),
    );
  });

  try {
    const client = new ApiClient({ apiUrl: server.url, token: "s4s_token" });
    await assert.rejects(
      () =>
        listTokens(client, {
          json: true,
          showEnv: false,
          dryRun: false,
          yes: false,
          wait: false,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 403);
        assert.equal(error.problem?.requiredScope, "tokens:manage");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
