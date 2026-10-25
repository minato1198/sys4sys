import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ method: string; url: string; body?: unknown }>;
  lastBody(): unknown | undefined;
}

export async function startTestServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += String(chunk);
    });
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body: raw.length > 0 ? safeJson(raw) : undefined,
      });
      handler(request, response);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    lastBody() {
      return requests[requests.length - 1]?.body;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function json(
  response: ServerResponse,
  body: unknown,
  statusCode = 200,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

export function text(
  response: ServerResponse,
  body: string,
  contentType = "text/plain",
  statusCode = 200,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", contentType);
  response.end(body);
}

export function problem(
  response: ServerResponse,
  status: number,
  title: string,
  detail: string,
  extra?: Record<string, unknown>,
): void {
  json(
    response,
    {
      type: "about:blank",
      title,
      status,
      detail,
      ...(extra ?? {}),
    },
    status,
  );
}

export function queryOf(url: string): URL {
  return new URL(url, "http://127.0.0.1");
}
