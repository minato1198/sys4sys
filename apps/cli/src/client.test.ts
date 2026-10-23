import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { ApiClient, ApiError, normalizeApiUrl } from "./client.js";
import { AuthError, UsageError } from "./errors.js";
import type { AuthUser } from "./types.js";

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
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

test("logs in, keeps the session cookie, and calls the API", async () => {
  let receivedCookie: string | undefined;
  const server = await startServer((request, response) => {
    if (request.url === "/api/auth/login" && request.method === "POST") {
      response.setHeader(
        "Set-Cookie",
        "sys4sys_session=test-token; Path=/; HttpOnly",
      );
      json(response, 200, {
        id: "user-1",
        email: "ai@example.local",
        name: "AI",
        role: "admin",
      });
      return;
    }

    if (request.url === "/api/auth/me") {
      receivedCookie = request.headers.cookie;
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

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      email: "ai@example.local",
      password: "secret-password",
    });

    const user = await client.whoami();
    assert.equal(user.email, "ai@example.local");
    assert.match(receivedCookie ?? "", /sys4sys_session=test-token/);
  } finally {
    await server.close();
  }
});

test("accepts an existing session cookie", async () => {
  let receivedCookie: string | undefined;
  const server = await startServer((request, response) => {
    receivedCookie = request.headers.cookie;
    json(response, 200, {
      id: "user-1",
      email: "ai@example.local",
      name: "AI",
      role: "operator",
    } satisfies AuthUser);
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      sessionCookie: "sys4sys_session=existing-token; Path=/; HttpOnly",
    });

    await client.whoami();
    assert.match(receivedCookie ?? "", /sys4sys_session=existing-token/);
  } finally {
    await server.close();
  }
});

test("normalizes API URLs and rejects unsupported protocols", () => {
  assert.equal(
    normalizeApiUrl("http://127.0.0.1:8787/api/"),
    "http://127.0.0.1:8787",
  );
  assert.throws(() => normalizeApiUrl("ftp://127.0.0.1"), UsageError);
});

test("throws AuthError when no credentials are configured", async () => {
  const client = new ApiClient({ apiUrl: "http://127.0.0.1:9" });

  await assert.rejects(() => client.whoami(), AuthError);
});

test("maps problem+json errors to ApiError", async () => {
  const server = await startServer((request, response) => {
    if (request.url === "/api/auth/login") {
      response.setHeader(
        "Set-Cookie",
        "sys4sys_session=test-token; Path=/; HttpOnly",
      );
      json(response, 200, {
        id: "user-1",
        email: "ai@example.local",
        name: "AI",
        role: "admin",
      });
      return;
    }

    response.statusCode = 422;
    response.setHeader("Content-Type", "application/problem+json");
    response.end(
      JSON.stringify({
        type: "about:blank",
        title: "Validation Error",
        status: 422,
        detail: "リクエストの内容が不正です",
        errors: [{ path: "name", message: "必須です" }],
      }),
    );
  });

  try {
    const client = new ApiClient({
      apiUrl: server.url,
      email: "ai@example.local",
      password: "secret-password",
    });

    await assert.rejects(
      () => client.request("POST", "/api/services", {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 422);
        assert.equal(error.problem?.errors?.[0]?.path, "name");
        return true;
      },
    );
  } finally {
    await server.close();
  }
});
