import { createServer, type ServerResponse } from "node:http";

const port = Number(process.env.PORT ?? 4100);
const host = process.env.HOST ?? "127.0.0.1";
const startedAt = new Date();
let requestCount = 0;
let errorCount = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  requestCount += 1;
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `${host}:${port}`}`,
  );
  console.log(
    `${new Date().toISOString()} ${req.method ?? "GET"} ${url.pathname}${url.search} requests=${requestCount}`,
  );

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "demo-api",
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      requests: requestCount,
      errors: errorCount,
      startedAt: startedAt.toISOString(),
    });
    return;
  }

  if (url.pathname === "/") {
    sendJson(res, 200, {
      service: "demo-api",
      message: "sys4sys demo service",
      endpoints: [
        "GET /health",
        "GET /error",
        "GET /slow?ms=5000",
        "GET /crash",
      ],
    });
    return;
  }

  if (url.pathname === "/error") {
    errorCount += 1;
    console.error(
      `[demo-api] intentional error #${errorCount} request=${requestCount}`,
    );
    sendJson(res, 500, {
      error: "intentional_error",
      message: "This endpoint intentionally returns 500.",
    });
    return;
  }

  if (url.pathname === "/slow") {
    const ms = Math.min(
      Math.max(Number(url.searchParams.get("ms") ?? 5000), 1),
      30_000,
    );
    console.log(`[demo-api] delaying response for ${ms}ms`);
    setTimeout(() => {
      sendJson(res, 200, { status: "ok", delayedMs: ms });
    }, ms);
    return;
  }

  if (url.pathname === "/crash") {
    console.error("[demo-api] intentional crash requested");
    sendJson(res, 202, {
      status: "crashing",
      message: "Process will exit with code 1.",
    });
    setTimeout(() => process.exit(1), 250);
    return;
  }

  sendJson(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(port, host, () => {
  console.log(`[demo-api] listening on http://${host}:${port}`);
  console.log(`[demo-api] pid=${process.pid} node=${process.version}`);
});

const heartbeat = setInterval(() => {
  console.log(
    `[demo-api] heartbeat requests=${requestCount} errors=${errorCount} uptimeSec=${Math.round((Date.now() - startedAt.getTime()) / 1000)}`,
  );
}, 30_000);
heartbeat.unref();

function shutdown(signal: string): void {
  console.log(`[demo-api] received ${signal}, shutting down`);
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
