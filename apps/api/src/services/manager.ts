import { createConnection } from "node:net";
import type { ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { and, eq, inArray, ne } from "drizzle-orm";
import spawn from "cross-spawn";
import {
  isProcessAlive,
  runFile,
  stopProcess,
  stripAnsi,
} from "@sys4sys/agent";
import type { HealthCheckInput } from "@sys4sys/shared";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { hosts, portReservations, services } from "../db/schema.js";
import { ingestLog } from "../logs/ingest.js";
import { isCommandAllowed } from "./allowlist.js";
import { serviceEvents } from "./events.js";
import { decryptServiceEnv, SERVICE_ENV_DECRYPTION_ERROR } from "./secrets.js";

export type ServiceRow = typeof services.$inferSelect;
export type HostRow = typeof hosts.$inferSelect;

export type HealthStatus = "healthy" | "unhealthy" | "unknown" | "stopped";

export interface HealthResult {
  serviceId: string;
  status: HealthStatus;
  latencyMs?: number;
  checkedAt: string;
  detail?: string;
  consecutiveFailures?: number;
}

export interface RuntimeInfo {
  running: boolean;
  adopted: boolean;
  pid: number | null;
  pidScope: string | null;
  health: HealthResult | null;
}

interface Runtime {
  serviceId: string;
  child: ChildProcess | null;
  pid: number | null;
  pidScope: string | null;
  scope: "windows" | "wsl";
  stopping: boolean;
  startedAt: Date;
  stdout?: Interface;
  stderr?: Interface;
  healthTimer?: NodeJS.Timeout;
  health?: HealthResult;
}

export class ServiceError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

const runtimes = new Map<string, Runtime>();
const healthFailures = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getService(id: string): Promise<ServiceRow | undefined> {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, id))
    .limit(1);
  return row;
}

async function getHost(id: string): Promise<HostRow | undefined> {
  const [row] = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return row;
}

function healthCheckOf(service: ServiceRow): HealthCheckInput | null {
  const raw = service.healthCheck;
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as { type?: unknown }).type;
  if (
    type !== "http" &&
    type !== "tcp" &&
    type !== "process" &&
    type !== "command"
  ) {
    return null;
  }
  return raw as unknown as HealthCheckInput;
}

export function wslCommandArgs(
  host: HostRow,
  command: string[],
  cwd?: string | null,
  env?: Record<string, string> | null,
): string[] {
  if (!host.distro) throw new Error("WSL distro is not configured");
  const args = [
    "-d",
    host.distro,
    ...(host.defaultUser ? ["-u", host.defaultUser] : []),
    ...(cwd ? ["--cd", cwd] : []),
    "--",
  ];
  const pairs = Object.entries(env ?? {}).map(
    ([key, value]) => `${key}=${value}`,
  );
  if (pairs.length > 0) args.push("env", ...pairs);
  args.push(...command);
  return args;
}

async function assertReservations(service: ServiceRow): Promise<void> {
  const expected = service.expectedPorts ?? [];
  if (expected.length === 0) return;
  const conflicts = await db
    .select()
    .from(portReservations)
    .where(
      and(
        inArray(portReservations.port, expected),
        ne(portReservations.serviceId, service.id),
      ),
    );
  if (conflicts.length > 0) {
    const labels = conflicts.map((row) => `${row.protocol}:${row.port}`);
    throw new ServiceError(
      409,
      `他のサービスが予約しているポートがあります: ${labels.join(", ")}`,
    );
  }
}

function attachLogs(
  runtime: Runtime,
  child: ChildProcess,
  hostId: string,
  serviceId: string,
): void {
  const attach = (
    stream: NodeJS.ReadableStream | null,
    name: "stdout" | "stderr",
  ): Interface | undefined => {
    if (!stream) return undefined;
    const rl = createInterface({ input: stream });
    rl.on("line", (line) => {
      const message = stripAnsi(line);
      if (!message.trim()) return;
      void ingestLog({
        hostId,
        serviceId,
        stream: name,
        message,
      }).catch((error: unknown) => {
        console.warn(`[logs] ingest ${name} failed: ${errorMessage(error)}`);
      });
    });
    return rl;
  };

  runtime.stdout = attach(child.stdout, "stdout");
  runtime.stderr = attach(child.stderr, "stderr");
}

function closeRuntime(runtime: Runtime): void {
  if (runtime.healthTimer) clearInterval(runtime.healthTimer);
  runtime.stdout?.close();
  runtime.stderr?.close();
  runtime.stdout = undefined;
  runtime.stderr = undefined;
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("プロセスの起動がタイムアウトしました")),
      10_000,
    );
    child.once("spawn", () => finish());
    child.once("error", (error: Error) => finish(error));
  });
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function handleExit(
  runtime: Runtime,
  service: ServiceRow,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (runtimes.get(service.id) !== runtime) return;
  const wasStopping = runtime.stopping;
  runtimes.delete(service.id);
  closeRuntime(runtime);
  healthFailures.delete(service.id);

  const exitedAt = new Date();
  const message = `service exited (code=${code ?? "null"}, signal=${
    signal ?? "null"
  })`;
  void db
    .update(services)
    .set({
      status: wasStopping ? "stopped" : "failed",
      pid: null,
      pidScope: null,
      lastExitedAt: exitedAt,
      lastExitCode: code,
      lastError: wasStopping ? null : message,
      updatedAt: exitedAt,
    })
    .where(eq(services.id, service.id))
    .then(() => {
      if (!wasStopping) {
        serviceEvents.emit("exited", {
          serviceId: service.id,
          hostId: service.hostId,
          code,
          signal,
          exitedAt: exitedAt.toISOString(),
        });
      }
    })
    .catch((error: unknown) => {
      console.warn(`[services] exit update failed: ${errorMessage(error)}`);
    });

  void ingestLog({
    hostId: service.hostId,
    serviceId: service.id,
    stream: "stderr",
    level: wasStopping ? "info" : "error",
    message,
  }).catch(() => undefined);

  if (!wasStopping) {
    void writeAudit({
      actorLabel: "system",
      action: "service.exit",
      target: `service:${service.id}`,
      after: { code, signal },
    }).catch(() => undefined);
  }
}

function startHealthTimer(
  runtime: Runtime,
  service: ServiceRow,
  host: HostRow,
): void {
  const check = healthCheckOf(service);
  if (!check) return;
  const intervalMs = Math.max(1, check.intervalSec ?? 10) * 1000;
  const run = () => {
    void checkServiceHealth(service.id).catch((error: unknown) => {
      console.warn(
        `[services] health check ${service.id} failed: ${errorMessage(error)}`,
      );
    });
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  runtime.healthTimer = timer;
  const initial = setTimeout(run, Math.min(1500, intervalMs));
  initial.unref();
  void host;
}

export async function startService(id: string): Promise<ServiceRow> {
  const service = await getService(id);
  if (!service || !service.isActive) {
    throw new ServiceError(404, "サービスが見つかりません");
  }
  if (
    runtimes.has(id) ||
    ["starting", "running", "degraded", "restarting"].includes(service.status)
  ) {
    throw new ServiceError(409, "サービスは既に起動しています");
  }

  const host = await getHost(service.hostId);
  if (!host) throw new ServiceError(422, "ホストが見つかりません");
  if (!host.enabled) {
    throw new ServiceError(409, "ホストが無効化されています");
  }
  if (host.kind === "wsl" && !host.distro) {
    throw new ServiceError(422, "WSL ホストに distro が設定されていません");
  }

  const allowed = isCommandAllowed(service.command);
  if (!allowed.ok) {
    throw new ServiceError(
      422,
      allowed.reason ?? "コマンドが許可されていません",
    );
  }
  await assertReservations(service);

  const startedAt = new Date();
  await db
    .update(services)
    .set({
      status: "starting",
      pid: null,
      pidScope: null,
      lastStartedAt: startedAt,
      lastError: null,
      updatedAt: startedAt,
    })
    .where(eq(services.id, id));

  const runtime: Runtime = {
    serviceId: id,
    child: null,
    pid: null,
    pidScope: null,
    // Windows / WSL のどちらも、保存する PID は wsl.exe を含む Windows 側の
    // プロセス ID。停止は taskkill /T でプロセスツリーごと行う。
    scope: "windows",
    stopping: false,
    startedAt,
  };
  runtimes.set(id, runtime);

  try {
    let serviceEnv: Record<string, string> | null;
    try {
      serviceEnv = decryptServiceEnv(service.env);
    } catch {
      throw new ServiceError(500, SERVICE_ENV_DECRYPTION_ERROR);
    }

    const child =
      host.kind === "windows"
        ? spawn(service.command[0]!, service.command.slice(1), {
            cwd: service.cwd ?? undefined,
            env: { ...process.env, ...(serviceEnv ?? {}) },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn(
            "wsl.exe",
            wslCommandArgs(host, service.command, service.cwd, serviceEnv),
            {
              env: process.env,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            },
          );

    runtime.child = child;
    attachLogs(runtime, child, service.hostId, service.id);
    child.once("exit", (code, signal) => {
      handleExit(runtime, service, code, signal);
    });

    await waitForSpawn(child);

    const pid = child.pid ?? null;
    const pidScope: string | null = null;

    if (child.exitCode !== null) {
      throw new Error(
        `プロセスが起動直後に終了しました (code=${child.exitCode})`,
      );
    }
    if (!pid) {
      throw new Error("プロセス ID を取得できませんでした");
    }

    runtime.pid = pid;
    runtime.pidScope = pidScope;

    const now = new Date();
    await db
      .update(services)
      .set({
        status: "running",
        pid,
        pidScope,
        lastStartedAt: startedAt,
        lastExitedAt: null,
        lastExitCode: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(services.id, id));

    startHealthTimer(runtime, service, host);

    void ingestLog({
      hostId: service.hostId,
      serviceId: service.id,
      stream: "stdout",
      level: "info",
      message: `service started (pid=${pid ?? "unknown"})`,
    }).catch(() => undefined);

    const updated = await getService(id);
    return updated ?? service;
  } catch (error) {
    const message = errorMessage(error);
    const failedRuntime = runtimes.get(id);
    if (failedRuntime) {
      runtimes.delete(id);
      closeRuntime(failedRuntime);
      failedRuntime.child?.kill("SIGKILL");
    }
    healthFailures.delete(id);
    await db
      .update(services)
      .set({
        status: "failed",
        pid: null,
        pidScope: null,
        lastExitedAt: new Date(),
        lastError: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(services.id, id));
    void ingestLog({
      hostId: service.hostId,
      serviceId: service.id,
      stream: "stderr",
      level: "error",
      message: `service start failed: ${message}`,
    }).catch(() => undefined);
    throw new ServiceError(409, `サービスを起動できませんでした: ${message}`);
  }
}

async function signalStop(
  scope: "windows" | "wsl",
  pidScope: string | null,
  pid: number | null,
  runtime: Runtime | undefined,
  signal: "TERM" | "KILL",
): Promise<void> {
  const child = runtime?.child;
  const isWindowsPlatform = process.platform === "win32";
  const canUseChildHandle = Boolean(child);
  const shouldSignalChildDirectly =
    canUseChildHandle &&
    (signal === "KILL" || !pid || (scope === "windows" && !isWindowsPlatform));

  if (pid && pid > 4 && (scope === "wsl" || isWindowsPlatform)) {
    try {
      await stopProcess({
        scope,
        pidScope,
        pid,
        signal,
        force: signal === "KILL",
      });
    } catch (error) {
      // Windows で taskkill が失敗しても、直接起動した子プロセスが
      // あれば SIGTERM / SIGKILL で停止する。WSL は wsl.exe kill が主経路。
      if (!canUseChildHandle) throw error;
    }
  }

  if (shouldSignalChildDirectly && child) {
    child.kill(signal === "KILL" ? "SIGKILL" : "SIGTERM");
  }
}

async function waitForDeath(
  runtime: Runtime | undefined,
  pid: number | null,
  scope: "windows" | "wsl",
  pidScope: string | null,
  timeoutMs: number,
): Promise<boolean> {
  if (runtime?.child) {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      const exited = await Promise.race([
        onceExit(runtime.child).then(() => true),
        sleep(timeoutMs).then(() => false),
      ]);
      if (!exited) return false;
    }
  }

  if (!pid) return true;
  const deadline = Date.now() + Math.max(500, timeoutMs);
  while (Date.now() < deadline) {
    if (!(await isProcessAlive({ scope, pidScope, pid }))) return true;
    await sleep(200);
  }
  return !(await isProcessAlive({ scope, pidScope, pid }));
}

export async function stopService(id: string): Promise<ServiceRow> {
  const service = await getService(id);
  if (!service || !service.isActive) {
    throw new ServiceError(404, "サービスが見つかりません");
  }

  const runtime = runtimes.get(id);
  const host = await getHost(service.hostId);
  if (!host) throw new ServiceError(422, "ホストが見つかりません");

  const pid = runtime?.pid ?? service.pid ?? null;
  const pidScope = runtime?.pidScope ?? service.pidScope ?? null;
  const scope = runtime?.scope ?? (service.pidScope ? "wsl" : "windows");

  if (!runtime && !pid && service.status === "stopped") {
    throw new ServiceError(409, "サービスは停止しています");
  }

  if (runtime) runtime.stopping = true;

  try {
    try {
      await signalStop(scope, pidScope, pid, runtime, "TERM");
    } catch {
      // Windows の taskkill /T は /F なしでは子プロセスを止められないことがある。
      // 猶予後に KILL へフォールバックする。
    }

    let died = await waitForDeath(
      runtime,
      pid,
      scope,
      pidScope,
      config.SERVICE_STOP_GRACE_MS,
    );
    if (!died) {
      try {
        await signalStop(scope, pidScope, pid, runtime, "KILL");
      } catch {
        // 最終確認で判断する
      }
      died = await waitForDeath(runtime, pid, scope, pidScope, 3000);
    }

    if (!died) {
      if (runtime) runtime.stopping = false;
      throw new ServiceError(409, "プロセスを停止できませんでした");
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      409,
      `プロセスを停止できませんでした: ${errorMessage(error)}`,
    );
  }

  if (runtime?.child && runtime.child.exitCode === null) {
    runtime.child.kill("SIGKILL");
  }
  if (runtime) {
    runtimes.delete(id);
    closeRuntime(runtime);
  }
  healthFailures.delete(id);

  const now = new Date();
  await db
    .update(services)
    .set({
      status: "stopped",
      pid: null,
      pidScope: null,
      lastExitedAt: now,
      lastExitCode: runtime?.child?.exitCode ?? null,
      lastError: null,
      updatedAt: now,
    })
    .where(eq(services.id, id));

  void ingestLog({
    hostId: service.hostId,
    serviceId: service.id,
    stream: "stdout",
    level: "info",
    message: "service stopped",
  }).catch(() => undefined);

  const updated = await getService(id);
  return updated ?? service;
}

export async function restartService(id: string): Promise<ServiceRow> {
  const service = await getService(id);
  if (!service || !service.isActive) {
    throw new ServiceError(404, "サービスが見つかりません");
  }

  const runtime = runtimes.get(id);
  const running =
    Boolean(runtime) ||
    Boolean(service.pid) ||
    ["starting", "running", "degraded", "restarting"].includes(service.status);

  try {
    if (running) {
      await db
        .update(services)
        .set({ status: "restarting", updatedAt: new Date() })
        .where(eq(services.id, id));
      await stopService(id);
    }
    return await startService(id);
  } catch (error) {
    await db
      .update(services)
      .set({
        status: "failed",
        lastError: errorMessage(error).slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(services.id, id));
    throw error;
  }
}

async function runHttpCheck(
  url: string,
  timeoutMs: number,
): Promise<{ healthy: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "manual",
    });
    return {
      healthy: response.status >= 200 && response.status < 400,
      detail: `HTTP ${response.status}`,
    };
  } catch (error) {
    return { healthy: false, detail: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }
}

function runTcpCheck(
  port: number,
  timeoutMs: number,
): Promise<{ healthy: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (healthy: boolean, detail: string) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve({ healthy, detail });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true, "TCP connected"));
    socket.once("timeout", () => finish(false, "TCP timeout"));
    socket.once("error", (error) => finish(false, error.message));
  });
}

async function runHealthCheck(
  service: ServiceRow,
  host: HostRow,
  check: HealthCheckInput,
): Promise<{ healthy: boolean; detail: string }> {
  const timeoutMs = Math.max(1, check.timeoutSec ?? 3) * 1000;

  if (check.type === "http") {
    if (!check.url) return { healthy: false, detail: "url が未設定です" };
    return runHttpCheck(check.url, timeoutMs);
  }
  if (check.type === "tcp") {
    if (!check.port) return { healthy: false, detail: "port が未設定です" };
    return runTcpCheck(check.port, timeoutMs);
  }
  if (check.type === "process") {
    const pid = runsPidFor(service);
    if (!pid) return { healthy: false, detail: "PID がありません" };
    const alive = await isProcessAlive({
      scope: service.pidScope ? "wsl" : "windows",
      pidScope: service.pidScope,
      pid,
    });
    return {
      healthy: alive,
      detail: alive
        ? `pid ${pid} は生存しています`
        : `pid ${pid} が見つかりません`,
    };
  }

  const command = check.command ?? [];
  if (command.length === 0) {
    return { healthy: false, detail: "command が未設定です" };
  }
  const allowed = isCommandAllowed(command);
  if (!allowed.ok) {
    return {
      healthy: false,
      detail: allowed.reason ?? "コマンドが許可されていません",
    };
  }
  try {
    let serviceEnv: Record<string, string> | null = null;
    if (host.kind !== "windows") {
      try {
        serviceEnv = decryptServiceEnv(service.env);
      } catch {
        return { healthy: false, detail: SERVICE_ENV_DECRYPTION_ERROR };
      }
    }

    if (host.kind === "windows") {
      await runFile(command[0]!, command.slice(1), timeoutMs);
    } else {
      await runFile(
        "wsl.exe",
        wslCommandArgs(host, command, service.cwd, serviceEnv),
        timeoutMs,
      );
    }
    return { healthy: true, detail: "command exited 0" };
  } catch (error) {
    return { healthy: false, detail: errorMessage(error) };
  }
}

function runsPidFor(service: ServiceRow): number | null {
  return runtimes.get(service.id)?.pid ?? service.pid ?? null;
}

export async function checkServiceHealth(id: string): Promise<HealthResult> {
  const service = await getService(id);
  if (!service || !service.isActive) {
    throw new ServiceError(404, "サービスが見つかりません");
  }

  const checkedAt = new Date().toISOString();
  const runtime = runtimes.get(id);
  const pid = runsPidFor(service);
  const running =
    Boolean(runtime) ||
    Boolean(pid) ||
    ["starting", "running", "degraded"].includes(service.status);

  if (!running || service.status === "stopped" || service.status === "failed") {
    return { serviceId: id, status: "stopped", checkedAt, detail: "停止中" };
  }

  const check = healthCheckOf(service);
  if (!check) {
    const result: HealthResult = {
      serviceId: id,
      status: "unknown",
      checkedAt,
      detail: "ヘルスチェックが設定されていません",
    };
    if (runtime) runtime.health = result;
    return result;
  }

  const host = await getHost(service.hostId);
  if (!host) {
    return {
      serviceId: id,
      status: "unknown",
      checkedAt,
      detail: "ホストが見つかりません",
    };
  }

  const started = performance.now();
  const result = await runHealthCheck(service, host, check);
  const latencyMs = Math.round(performance.now() - started);
  const failures = result.healthy ? 0 : (healthFailures.get(id) ?? 0) + 1;
  healthFailures.set(id, failures);

  const health: HealthResult = {
    serviceId: id,
    status: result.healthy ? "healthy" : "unhealthy",
    latencyMs,
    checkedAt,
    detail: result.detail,
    consecutiveFailures: failures,
  };

  if (runtime) runtime.health = health;

  if (result.healthy && service.status === "degraded") {
    await db
      .update(services)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(services.id, id));
  } else if (!result.healthy && failures >= (check.failures ?? 3)) {
    if (service.status !== "degraded") {
      await db
        .update(services)
        .set({
          status: "degraded",
          lastError: result.detail.slice(0, 2000),
          updatedAt: new Date(),
        })
        .where(eq(services.id, id));
      serviceEvents.emit("degraded", {
        serviceId: id,
        detail: result.detail,
        consecutiveFailures: failures,
        checkedAt,
      });
      void ingestLog({
        hostId: service.hostId,
        serviceId: service.id,
        stream: "stderr",
        level: "error",
        message: `health check failed: ${result.detail}`,
      }).catch(() => undefined);
    }
  }

  return health;
}

export function runtimeInfo(id: string): RuntimeInfo {
  const runtime = runtimes.get(id);
  if (!runtime) {
    return {
      running: false,
      adopted: false,
      pid: null,
      pidScope: null,
      health: null,
    };
  }
  return {
    running: true,
    adopted: runtime.child === null,
    pid: runtime.pid,
    pidScope: runtime.pidScope,
    health: runtime.health ?? null,
  };
}

export async function reconcileServices(): Promise<void> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.isActive, true));
  if (rows.length === 0) return;

  const hostRows = await db.select().from(hosts);
  const hostMap = new Map(hostRows.map((row) => [row.id, row]));

  for (const service of rows) {
    if (service.status === "stopped" && !service.pid) continue;
    if (service.status === "failed" && !service.pid) continue;

    const host = hostMap.get(service.hostId);
    if (!host) {
      await db
        .update(services)
        .set({
          status: "stopped",
          pid: null,
          pidScope: null,
          lastError: "ホストが見つかりません",
          updatedAt: new Date(),
        })
        .where(eq(services.id, service.id));
      continue;
    }

    let alive = false;
    if (service.pid) {
      alive = await isProcessAlive({
        scope: service.pidScope ? "wsl" : "windows",
        pidScope: service.pidScope,
        pid: service.pid,
      });
    }

    if (alive) {
      const runtime: Runtime = {
        serviceId: service.id,
        child: null,
        pid: service.pid,
        pidScope: service.pidScope,
        scope: service.pidScope ? "wsl" : "windows",
        stopping: false,
        startedAt: service.lastStartedAt ?? new Date(),
      };
      runtimes.set(service.id, runtime);
      startHealthTimer(runtime, service, host);
      await db
        .update(services)
        .set({
          status: service.status === "degraded" ? "degraded" : "running",
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(services.id, service.id));
    } else {
      await db
        .update(services)
        .set({
          status: "stopped",
          pid: null,
          pidScope: null,
          lastExitedAt: new Date(),
          lastError:
            service.status === "stopped"
              ? service.lastError
              : "API 再起動時にプロセスを確認できませんでした",
          updatedAt: new Date(),
        })
        .where(eq(services.id, service.id));
    }
  }

  if (config.SERVICE_AUTOSTART_ON_BOOT) {
    for (const service of rows) {
      if (!service.autoStart) continue;
      try {
        await startService(service.id);
      } catch (error) {
        console.warn(
          `[services] auto start ${service.name} failed: ${errorMessage(error)}`,
        );
      }
    }
  }
}

export function closeServiceWatchers(): void {
  for (const runtime of runtimes.values()) closeRuntime(runtime);
  runtimes.clear();
  healthFailures.clear();
}
