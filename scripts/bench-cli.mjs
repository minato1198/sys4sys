#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = join(root, "apps", "cli", "src", "bin.ts");
const apiEntry = join(root, "apps", "api", "src", "server.ts");
const requireFromApi = createRequire(join(root, "apps", "api", "package.json"));

const HELP = `sys4sys CLI benchmark

Usage:
  node scripts/bench-cli.mjs [--rows <n>] [--runs <n>] [--keep]

Options:
  --rows <n>   Number of log rows to seed (default: 100000)
  --runs <n>   Number of logs query runs (default: 10)
  --keep       Keep the temporary database and print its path
  --help, -h   Show this help

The benchmark starts a local API on a random port with a temporary SQLite
database, seeds log rows, and measures:
  logs query --service bench-service --since 2h --limit 100 --json
`;

function parsePositiveNumber(flag, fallback) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

function sanitize(text) {
  return text
    .replace(/s4s_[A-Za-z0-9_-]{8,}/g, "s4s_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function stopProcess(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
}

function waitForClose(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a local port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(apiUrl, timeoutMs, apiProcess, apiError) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (apiProcess.exitCode !== null) {
      throw new Error(
        `API exited early with code ${apiProcess.exitCode}\n${sanitize(apiError())}`,
      );
    }
    try {
      const response = await fetch(`${apiUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // API is still starting
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  throw new Error(`API did not become healthy\n${sanitize(apiError())}`);
}

function runCli(env, args, input = "") {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliEntry, ...args],
      {
        cwd: root,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function seedLogs(dbPath, rows) {
  const Database = requireFromApi("better-sqlite3");
  const database = new Database(dbPath);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    const insert = database.prepare(
      `INSERT INTO log_events
        (id, host_id, service_id, ts, level, stream, message, fields, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const levels = ["info", "warn", "error"];
    const base = Date.now();
    const seed = database.transaction(() => {
      for (let i = 0; i < rows; i += 1) {
        insert.run(
          `bench-${String(i).padStart(8, "0")}`,
          "bench-host",
          "bench-service",
          base - i * 100,
          levels[i % levels.length],
          "stdout",
          `benchmark log line ${i} service=bench-service`,
          null,
          "bench",
        );
      }
    });
    seed();
  } finally {
    database.close();
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function markdown(result) {
  const rows = result.timings
    .map((ms, index) => `| ${index + 1} | ${ms.toFixed(0)} |`)
    .join("\n");
  return `# sys4sys CLI benchmark

- Date: ${new Date().toISOString()}
- Platform: ${process.platform} ${process.arch}
- Node: ${process.version}
- Seeded rows: ${result.rows}
- Query: \`logs query --service bench-service --since 2h --limit 100 --json\`
- Runs: ${result.runs}
- Cold start included: yes
- Target: <= 2000 ms

| Run | Milliseconds |
| --: | -----------: |
${rows}

**Median: ${result.medianMs.toFixed(0)} ms** (${result.medianMs <= 2_000 ? "pass" : "over target"})
`;
}

async function main() {
  const rows = parsePositiveNumber("--rows", 100_000);
  const runs = parsePositiveNumber("--runs", 10);
  const keep = process.argv.includes("--keep");
  const tempDir = await mkdtemp(join(tmpdir(), "sys4sys bench "));
  const dbPath = join(tempDir, "bench.db");
  const configDir = join(tempDir, "config");
  const port = await getFreePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const adminEmail = "bench@example.local";
  const adminPassword = randomBytes(18).toString("base64url");

  const baseEnv = { ...process.env };
  for (const key of [
    "SYS4SYS_TOKEN",
    "SYS4SYS_TOKEN_FILE",
    "SYS4SYS_SESSION_COOKIE",
    "SYS4SYS_EMAIL",
    "SYS4SYS_PASSWORD",
    "SYS4SYS_MCP_ALLOW_WRITE",
    "ADMIN_PASSWORD",
    "SESSION_SECRET",
    "SECRET_ENCRYPTION_KEY",
    "DATABASE_URL",
  ]) {
    delete baseEnv[key];
  }

  const apiEnv = {
    ...baseEnv,
    NODE_ENV: "test",
    DATABASE_URL: dbPath,
    PORT: String(port),
    HOST: "127.0.0.1",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    MONITOR_ENABLED: "false",
    SERVICE_AUTOSTART_ON_BOOT: "false",
    LOG_LEVEL: "error",
    AI_DAILY_LIMIT: "0",
  };
  const cliEnv = {
    ...baseEnv,
    SYS4SYS_API_URL: apiUrl,
    SYS4SYS_CONFIG_DIR: configDir,
  };

  const apiProcess = spawn(process.execPath, ["--import", "tsx", apiEntry], {
    cwd: root,
    env: apiEnv,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let apiStdout = "";
  let apiStderr = "";
  apiProcess.stdout.on("data", (chunk) => {
    apiStdout += chunk.toString("utf8");
    if (apiStdout.length > 20_000) apiStdout = apiStdout.slice(-20_000);
  });
  apiProcess.stderr.on("data", (chunk) => {
    apiStderr += chunk.toString("utf8");
    if (apiStderr.length > 20_000) apiStderr = apiStderr.slice(-20_000);
  });

  try {
    await waitForHealth(apiUrl, 60_000, apiProcess, () => apiStderr);

    const login = await runCli(
      cliEnv,
      ["auth", "login", "--email", adminEmail, "--password-stdin", "--json"],
      adminPassword,
    );
    if (login.code !== 0) {
      throw new Error(
        `CLI login failed (${login.code})\n${sanitize(login.stdout)}\n${sanitize(login.stderr)}`,
      );
    }

    const seedStarted = performance.now();
    seedLogs(dbPath, rows);
    const seedMs = performance.now() - seedStarted;

    const queryArgs = [
      "logs",
      "query",
      "--service",
      "bench-service",
      "--since",
      "2h",
      "--limit",
      "100",
      "--json",
    ];
    const timings = [];
    for (let i = 0; i < runs; i += 1) {
      const started = performance.now();
      const result = await runCli(cliEnv, queryArgs);
      const elapsed = performance.now() - started;
      if (result.code !== 0) {
        throw new Error(
          `logs query failed (${result.code})\n${sanitize(result.stdout)}\n${sanitize(result.stderr)}`,
        );
      }
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed.items) || parsed.items.length !== 100) {
        throw new Error(
          `expected 100 log rows, got ${Array.isArray(parsed.items) ? parsed.items.length : "no items"}`,
        );
      }
      timings.push(elapsed);
    }

    const result = {
      rows,
      runs,
      timings,
      medianMs: median(timings),
    };
    process.stdout.write(markdown(result));
    process.stderr.write(`seed time: ${seedMs.toFixed(0)} ms\n`);
    if (keep) {
      process.stderr.write(`kept benchmark data: ${tempDir}\n`);
    }
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${sanitize(message)}\n`);
    if (apiStderr.trim()) {
      process.stderr.write(`API stderr:\n${sanitize(apiStderr)}\n`);
    }
    process.exitCode = 1;
  } finally {
    stopProcess(apiProcess);
    await waitForClose(apiProcess);
    if (!keep) {
      await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(
        () => undefined,
      );
    }
  }
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(HELP);
} else {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `${sanitize(error instanceof Error ? error.message : String(error))}\n`,
    );
    process.exitCode = 1;
  }
}
