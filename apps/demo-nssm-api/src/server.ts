import { createServer, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";

interface BuildInfo {
  package: string;
  version: string;
  builtAt: string;
  deployActionId: string | null;
}

const port = Number(process.env.PORT ?? 4110);
const host = process.env.HOST ?? "127.0.0.1";
const serviceLabel = process.env.SYS4SYS_SERVICE_NAME ?? "demo-nssm-api";
const startedAt = new Date();
let requestCount = 0;
let errorCount = 0;

function loadBuildInfo(): BuildInfo | null {
  const candidates = [
    new URL("./build-info.json", import.meta.url),
    new URL("../dist/build-info.json", import.meta.url),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as BuildInfo;
    } catch {
      return null;
    }
  }

  return null;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(payload);
}

const buildInfo = loadBuildInfo();

const server = createServer((req, res) => {
  requestCount += 1;
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `${host}:${port}`}`,
  );

  console.log(
    `[demo-nssm-api] ${new Date().toISOString()} ${req.method ?? "GET"} ${url.pathname}${url.search} requests=${requestCount}`,
  );

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "demo-nssm-api",
      serviceName: serviceLabel,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      requests: requestCount,
      errors: errorCount,
      startedAt: startedAt.toISOString(),
      build: buildInfo,
    });
    return;
  }

  if (url.pathname === "/") {
    sendJson(res, 200, {
      service: "demo-nssm-api",
      message: "sys4sys NSSM demo service",
      endpoints: [
        "GET /health",
        "GET /error",
        "GET /slow?ms=5000",
        "GET /crash?exitMs=12000",
      ],
    });
    return;
  }

  if (url.pathname === "/error") {
    errorCount += 1;
    console.error(
      `[demo-nssm-api] intentional error #${errorCount} request=${requestCount}`,
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
    console.log(`[demo-nssm-api] delaying response for ${ms}ms`);
    setTimeout(() => {
      sendJson(res, 200, { status: "ok", delayedMs: ms });
    }, ms);
    return;
  }

  if (url.pathname === "/crash") {
    const rawExitMs =
      url.searchParams.get("exitMs") ?? url.searchParams.get("ms");
    const requestedExitMs =
      rawExitMs === null || rawExitMs === "" ? 12_000 : Number(rawExitMs);
    const exitMs = Math.min(
      Math.max(
        Number.isFinite(requestedExitMs) ? requestedExitMs : 12_000,
        250,
      ),
      120_000,
    );

    console.error(
      `[demo-nssm-api] intentional crash requested exitInMs=${exitMs} request=${requestCount}`,
    );
    sendJson(res, 202, {
      status: "crashing",
      message:
        "HTTP health is closed first, then the process exits with code 1.",
      exitInMs: exitMs,
      exitCode: 1,
    });

    server.close(() => {
      console.error(
        "[demo-nssm-api] HTTP listener closed before intentional exit",
      );
    });
    server.closeIdleConnections?.();
    server.closeAllConnections?.();

    setTimeout(() => {
      console.error(
        `[demo-nssm-api] intentional crash exiting after ${exitMs}ms`,
      );
      process.exit(1);
    }, exitMs);
    return;
  }

  sendJson(res, 404, { error: "not_found", path: url.pathname });
});

server.listen(port, host, () => {
  console.log(`[demo-nssm-api] listening on http://${host}:${port}`);
  console.log(`[demo-nssm-api] service=${serviceLabel} pid=${process.pid}`);
  console.log(`[demo-nssm-api] node=${process.version}`);
  console.log(
    `[demo-nssm-api] build=${buildInfo?.builtAt ?? "unknown"} action=${buildInfo?.deployActionId ?? "none"}`,
  );
});

const heartbeat = setInterval(() => {
  console.log(
    `[demo-nssm-api] heartbeat requests=${requestCount} errors=${errorCount} uptimeSec=${Math.round((Date.now() - startedAt.getTime()) / 1000)}`,
  );
}, 30_000);
heartbeat.unref();

function shutdown(signal: string): void {
  console.log(`[demo-nssm-api] received ${signal}, shutting down`);
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
