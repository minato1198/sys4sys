import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "../..");
const artifactsRoot = join(here, ".artifacts");

const ALL_SCOPES = [
  "services:read",
  "services:write",
  "services:operate",
  "services:secrets",
  "deploy:execute",
  "logs:read",
  "logs:manage",
  "incidents:read",
  "incidents:write",
  "approvals:read",
  "approvals:decide",
  "hosts:read",
  "hosts:write",
  "ports:read",
  "ports:operate",
  "reports:read",
  "audit:read",
  "settings:read",
  "settings:write",
  "tokens:manage",
];

const OPERATOR_SCOPES = [
  "services:read",
  "services:operate",
  "deploy:execute",
  "logs:read",
  "incidents:read",
  "incidents:write",
  "approvals:read",
  "approvals:decide",
  "hosts:read",
  "ports:read",
  "ports:operate",
  "reports:read",
];

const SECRET_ENV_KEYS = [
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
];

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliHandle {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  closed(): Promise<CliResult>;
  stop(): void;
}

export interface Harness {
  apiUrl: string;
  tempDir: string;
  configDir: string;
  adminEmail: string;
  adminPassword: string;
  adminToken: string;
  adminTokenId: string;
  loginAdmin(): Promise<void>;
  createAdminToken(): Promise<void>;
  createToken(input: {
    name: string;
    scopes: string[];
    userId?: string;
  }): Promise<{ id: string; token: string; prefix: string }>;
  createUser(input: {
    email: string;
    name: string;
    password: string;
    role: "admin" | "operator" | "viewer";
  }): Promise<{ id: string; email: string; role: string }>;
  createOperator(): Promise<{
    id: string;
    email: string;
    password: string;
    token: string;
  }>;
  api<T>(
    method: string,
    path: string,
    body?: unknown,
    token?: string | null,
  ): Promise<T>;
  runCli(
    args: string[],
    options?: {
      token?: string;
      input?: string;
      timeoutMs?: number;
      api?: boolean;
    },
  ): Promise<CliResult>;
  runCliJson<T>(
    args: string[],
    options?: {
      token?: string;
      input?: string;
      timeoutMs?: number;
      api?: boolean;
    },
  ): Promise<T>;
  startCli(
    args: string[],
    options?: { token?: string; api?: boolean; input?: string },
  ): CliHandle;
  writeArtifact(name: string, content: string): Promise<void>;
  trackedService(id: string): void;
  cleanup(): Promise<void>;
}

function sanitize(text: string): string {
  return text
    .replace(/s4s_[A-Za-z0-9_-]{8,}/g, "s4s_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /("(?:password|token|apiKey|secret)"\s*:\s*")[^"]+(")/gi,
      "$1[REDACTED]$2",
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function waitFor<T>(
  label: string,
  probe: () => T | Promise<T>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const suffix =
    lastError instanceof Error ? `: ${sanitize(lastError.message)}` : "";
  throw new Error(`timed out waiting for ${label}${suffix}`);
}

function stopChild(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

export async function createHarness(
  options: { setupAdminToken?: boolean } = {},
): Promise<Harness> {
  const tempDir = await mkdtemp(join(tmpdir(), "sys4sys e2e "));
  const configDir = join(tempDir, "config");
  await mkdir(configDir, { recursive: true });

  const adminEmail = "admin@example.local";
  const adminPassword = randomBytes(18).toString("base64url");
  const env = {
    NODE_ENV: "test",
    DATABASE_URL: join(tempDir, "e2e.db"),
    SESSION_SECRET: randomBytes(32).toString("hex"),
    SECRET_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    MONITOR_ENABLED: "false",
    LOG_LEVEL: "warn",
    PORT: "8787",
    HOST: "127.0.0.1",
    SYS4SYS_CONFIG_DIR: configDir,
    SERVICE_AUTOSTART_ON_BOOT: "false",
    SERVICE_STOP_GRACE_MS: "1000",
    DEPLOY_REQUIRE_APPROVAL_DEFAULT: "false",
    DEPLOY_ALLOW_SELF_APPROVAL: "false",
    AI_DAILY_LIMIT: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }

  const appModule = await import("../../../api/src/app.js");
  const app = await appModule.buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!isRecord(address) || typeof address.port !== "number") {
    await app.close();
    throw new Error("could not determine E2E API port");
  }
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const serviceIds = new Set<string>();
  let adminToken = "";
  let adminTokenId = "";
  let adminSessionCookie = "";
  let cleaned = false;

  function childEnv(token?: string): NodeJS.ProcessEnv {
    const child = { ...process.env };
    for (const key of SECRET_ENV_KEYS) delete child[key];
    child.SYS4SYS_CONFIG_DIR = configDir;
    child.SYS4SYS_API_URL = apiUrl;
    if (token) child.SYS4SYS_TOKEN = token;
    return child;
  }

  function finalArgs(args: string[], useApi: boolean): string[] {
    if (!useApi || args.includes("--api")) return args;
    return [...args, "--api", apiUrl];
  }

  function startCli(
    args: string[],
    runOptions: { token?: string; api?: boolean; input?: string } = {},
  ): CliHandle {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "src/bin.ts",
        ...finalArgs(args, runOptions.api !== false),
      ],
      {
        cwd: cliRoot,
        env: childEnv(runOptions.token),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin.end(runOptions.input ?? "");
    const closed = new Promise<CliResult>((resolve) => {
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
    return {
      child,
      stdout: () => stdout,
      stderr: () => stderr,
      closed: () => closed,
      stop: () => stopChild(child),
    };
  }

  async function runCli(
    args: string[],
    runOptions: {
      token?: string;
      input?: string;
      timeoutMs?: number;
      api?: boolean;
    } = {},
  ): Promise<CliResult> {
    const handle = startCli(args, runOptions);
    const timeoutMs = runOptions.timeoutMs ?? 120_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<CliResult>((_, reject) => {
      timer = setTimeout(() => {
        handle.stop();
        reject(
          new Error(
            `CLI timed out after ${timeoutMs}ms: ${args.map((arg) => sanitize(arg)).join(" ")}\n${sanitize(
              handle.stderr(),
            )}`,
          ),
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([handle.closed(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function runCliJson<T>(
    args: string[],
    runOptions: Parameters<Harness["runCli"]>[1] = {},
  ): Promise<T> {
    const result = await runCli(args, runOptions);
    if (result.code !== 0) {
      throw new Error(
        `CLI failed (${result.code}): ${args.join(" ")}\nstdout:\n${sanitize(
          result.stdout,
        )}\nstderr:\n${sanitize(result.stderr)}`,
      );
    }
    const text = result.stdout.trim();
    if (!text) throw new Error(`CLI returned no JSON: ${args.join(" ")}`);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new Error(
        `CLI returned non-JSON output: ${args.join(" ")}\n${sanitize(
          text.slice(0, 2_000),
        )}${error instanceof Error ? `\n${error.message}` : ""}`,
      );
    }
  }

  async function requestApi<T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<T> {
    const requestHeaders = { Accept: "application/json", ...headers };
    if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${path} -> ${response.status}\n${sanitize(text.slice(0, 2_000))}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function api<T>(
    method: string,
    path: string,
    body?: unknown,
    token: string | null = adminToken,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return requestApi<T>(method, path, body, headers);
  }

  async function sessionApi<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!adminSessionCookie) {
      throw new Error("admin session cookie is not available");
    }
    return requestApi<T>(method, path, body, {
      Cookie: `sys4sys_session=${adminSessionCookie}`,
    });
  }

  async function loginAdmin(): Promise<void> {
    await runCliJson(
      ["auth", "login", "--email", adminEmail, "--password-stdin", "--json"],
      { input: adminPassword },
    );
    const raw = await readFile(join(configDir, "credentials.json"), "utf8");
    const credentials = JSON.parse(raw) as { sessionCookie?: string };
    if (!credentials.sessionCookie) {
      throw new Error("login did not store a session cookie");
    }
    adminSessionCookie = credentials.sessionCookie;
  }

  async function createToken(input: {
    name: string;
    scopes: string[];
    userId?: string;
  }): Promise<{ id: string; token: string; prefix: string }> {
    const args = [
      "tokens",
      "create",
      "--name",
      input.name,
      "--scope",
      input.scopes.join(","),
      "--json",
    ];
    if (input.userId) args.push("--user", input.userId);
    return runCliJson(args);
  }

  async function createAdminToken(): Promise<void> {
    const created = await createToken({
      name: "e2e-admin",
      scopes: ALL_SCOPES,
    });
    adminToken = created.token;
    adminTokenId = created.id;
  }

  async function createUser(input: {
    email: string;
    name: string;
    password: string;
    role: "admin" | "operator" | "viewer";
  }): Promise<{ id: string; email: string; role: string }> {
    return sessionApi("POST", "/api/users", input);
  }

  async function createOperator(): Promise<{
    id: string;
    email: string;
    password: string;
    token: string;
  }> {
    const password = randomBytes(18).toString("base64url");
    const email = `operator-${randomUUID().slice(0, 8)}@example.local`;
    const user = await createUser({
      email,
      name: "E2E Operator",
      password,
      role: "operator",
    });
    const token = await createToken({
      name: "e2e-operator",
      scopes: OPERATOR_SCOPES,
      userId: user.id,
    });
    return { id: user.id, email, password, token: token.token };
  }

  async function writeArtifact(name: string, content: string): Promise<void> {
    await mkdir(artifactsRoot, { recursive: true });
    const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, "-");
    await writeFile(
      join(artifactsRoot, `${Date.now()}-${safeName}`),
      sanitize(content),
      "utf8",
    );
  }

  async function cleanup(): Promise<void> {
    if (cleaned) return;
    cleaned = true;
    if (adminToken) {
      for (const id of serviceIds) {
        try {
          await api("POST", `/api/services/${encodeURIComponent(id)}/stop`);
        } catch {
          // best-effort; the process may already be stopped
        }
      }
    }
    try {
      await app.close();
    } catch {
      // best-effort
    }
    try {
      const dbModule = await import("../../../api/src/db/index.js");
      const client = (
        dbModule.db as unknown as { $client?: { close?: () => void } }
      ).$client;
      client?.close?.();
    } catch {
      // best-effort
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => undefined,
    );
  }

  const harness: Harness = {
    apiUrl,
    tempDir,
    configDir,
    adminEmail,
    adminPassword,
    get adminToken() {
      return adminToken;
    },
    get adminTokenId() {
      return adminTokenId;
    },
    loginAdmin,
    createAdminToken,
    createToken,
    createUser,
    createOperator,
    api,
    runCli,
    runCliJson,
    startCli,
    writeArtifact,
    trackedService: (id: string) => {
      serviceIds.add(id);
    },
    cleanup,
  };

  if (options.setupAdminToken !== false) {
    await loginAdmin();
    await createAdminToken();
  }

  return harness;
}

export async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { setupAdminToken?: boolean } = {},
): Promise<void> {
  const harness = await createHarness(options);
  try {
    await run(harness);
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    await harness.writeArtifact("failure.txt", message);
    throw error;
  } finally {
    await harness.cleanup();
  }
}

export async function writeScript(
  harness: Harness,
  filename: string,
  content: string,
): Promise<string> {
  const path = join(harness.tempDir, filename);
  await writeFile(path, content, "utf8");
  return path;
}

export const E2E_SCOPES = { ALL_SCOPES, OPERATOR_SCOPES };
