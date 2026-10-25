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
import { main } from "../index.js";
import { memoryOutput } from "../test-output.js";

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

const authMe = {
  id: "user-1",
  email: "ai@example.local",
  name: "AI",
  role: "admin",
  authMethod: "token",
  scopes: ["services:read", "tokens:manage"],
  token: {
    id: "token-1",
    name: "ci",
    prefix: "s4s_abcd",
  },
};

test("auth login ignores SYS4SYS_TOKEN and stores a session cookie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-auth-"));
  const previous = {
    config: process.env.SYS4SYS_CONFIG_DIR,
    token: process.env.SYS4SYS_TOKEN,
    password: process.env.SYS4SYS_PASSWORD,
  };
  process.env.SYS4SYS_CONFIG_DIR = directory;
  process.env.SYS4SYS_TOKEN = "env-token";
  process.env.SYS4SYS_PASSWORD = "secret-password";

  let loginAuthorization: string | undefined;
  const server = await startServer((request, response) => {
    if (request.url === "/api/auth/login" && request.method === "POST") {
      loginAuthorization = request.headers.authorization;
      response.setHeader(
        "Set-Cookie",
        "sys4sys_session=session-token; Path=/; HttpOnly",
      );
      json(response, 200, {
        id: "user-1",
        email: "ai@example.local",
        name: "AI",
        role: "admin",
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });

  const capture = memoryOutput();
  try {
    const exitCode = await main(
      ["auth", "login", "--api", server.url, "--email", "ai@example.local"],
      capture.output,
    );
    assert.equal(exitCode, 0);
    assert.equal(loginAuthorization, undefined);
    assert.match(capture.err, /ログインしました/);

    const store = new FileCredentialStore(join(directory, "credentials.json"));
    const saved = await store.load();
    assert.equal(saved?.apiUrl, server.url);
    assert.equal(saved?.sessionCookie, "session-token");
    assert.equal(saved?.token, undefined);
  } finally {
    process.env.SYS4SYS_CONFIG_DIR = previous.config;
    process.env.SYS4SYS_TOKEN = previous.token;
    process.env.SYS4SYS_PASSWORD = previous.password;
    if (previous.config === undefined) delete process.env.SYS4SYS_CONFIG_DIR;
    if (previous.token === undefined) delete process.env.SYS4SYS_TOKEN;
    if (previous.password === undefined) delete process.env.SYS4SYS_PASSWORD;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await server.close();
  }
});

test("auth logout revokes the stored token, not SYS4SYS_TOKEN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-auth-"));
  const previous = {
    config: process.env.SYS4SYS_CONFIG_DIR,
    token: process.env.SYS4SYS_TOKEN,
  };
  process.env.SYS4SYS_CONFIG_DIR = directory;
  process.env.SYS4SYS_TOKEN = "env-token";

  const store = new FileCredentialStore(join(directory, "credentials.json"));
  let authorization: string | undefined;
  let deletedPath: string | undefined;
  const server = await startServer((request, response) => {
    authorization = request.headers.authorization;
    deletedPath = request.url;
    response.statusCode = 204;
    response.end();
  });
  await store.save({
    apiUrl: server.url,
    token: "stored-token",
    tokenId: "stored-id",
  });

  const capture = memoryOutput();
  try {
    const exitCode = await main(
      ["auth", "logout", "--revoke-token"],
      capture.output,
    );
    assert.equal(exitCode, 0);
    assert.equal(authorization, "Bearer stored-token");
    assert.equal(deletedPath, "/api/tokens/stored-id");
    assert.equal(await store.load(), null);
    assert.match(capture.err, /環境変数のトークン/);
  } finally {
    process.env.SYS4SYS_CONFIG_DIR = previous.config;
    process.env.SYS4SYS_TOKEN = previous.token;
    if (previous.config === undefined) delete process.env.SYS4SYS_CONFIG_DIR;
    if (previous.token === undefined) delete process.env.SYS4SYS_TOKEN;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await server.close();
  }
});

test("whoami works with only SYS4SYS_TOKEN", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-auth-"));
  const previous = {
    config: process.env.SYS4SYS_CONFIG_DIR,
    token: process.env.SYS4SYS_TOKEN,
  };
  process.env.SYS4SYS_CONFIG_DIR = directory;
  process.env.SYS4SYS_TOKEN = "env-token";

  let authorization: string | undefined;
  const server = await startServer((request, response) => {
    authorization = request.headers.authorization;
    json(response, 200, authMe);
  });

  const capture = memoryOutput();
  try {
    const exitCode = await main(
      ["whoami", "--api", server.url, "--json"],
      capture.output,
    );
    assert.equal(exitCode, 0);
    assert.equal(authorization, "Bearer env-token");
    const output = JSON.parse(capture.out);
    assert.equal(output.authMethod, "token");
    assert.equal(output.token.prefix, "s4s_abcd");
  } finally {
    process.env.SYS4SYS_CONFIG_DIR = previous.config;
    process.env.SYS4SYS_TOKEN = previous.token;
    if (previous.config === undefined) delete process.env.SYS4SYS_CONFIG_DIR;
    if (previous.token === undefined) delete process.env.SYS4SYS_TOKEN;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await server.close();
  }
});

test("auth status reports the credential source and token prefix", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sys4sys-auth-"));
  const previous = process.env.SYS4SYS_CONFIG_DIR;
  process.env.SYS4SYS_CONFIG_DIR = directory;

  const store = new FileCredentialStore(join(directory, "credentials.json"));
  let authorization: string | undefined;
  const server = await startServer((request, response) => {
    authorization = request.headers.authorization;
    json(response, 200, authMe);
  });
  await store.save({
    apiUrl: server.url,
    token: "stored-token",
    tokenId: "token-1",
    tokenPrefix: "s4s_abcd",
    tokenExpiresAt: "2027-01-22T00:00:00.000Z",
  });

  const capture = memoryOutput();
  try {
    const exitCode = await main(["auth", "status", "--json"], capture.output);
    assert.equal(exitCode, 0);
    assert.equal(authorization, "Bearer stored-token");
    const output = JSON.parse(capture.out);
    assert.equal(output.source, "stored-token");
    assert.equal(output.tokenPrefix, "s4s_abcd");
    assert.equal(output.tokenExpiresAt, "2027-01-22T00:00:00.000Z");
    assert.equal(output.user.email, "ai@example.local");
  } finally {
    process.env.SYS4SYS_CONFIG_DIR = previous;
    if (previous === undefined) delete process.env.SYS4SYS_CONFIG_DIR;
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
    await server.close();
  }
});
