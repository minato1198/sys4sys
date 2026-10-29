import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { and, eq, inArray } from "drizzle-orm";
import spawn from "cross-spawn";
import { stopProcess, stripAnsi } from "@sys4sys/agent";
import type { DeployConfigInput, LogLevel } from "@sys4sys/shared";
import type { AuthUser } from "../auth/types.js";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { actions, deployRequests, hosts, services } from "../db/schema.js";
import { ingestLog } from "../logs/ingest.js";
import {
  attachProcessLineStream,
  type ProcessLineStreamHandle,
} from "../logs/process-lines.js";
import { isCommandAllowed } from "./allowlist.js";
import {
  isLocalDeployRunning,
  releaseLocalDeploy,
  tryReserveLocalDeploy,
} from "./deploy-lock.js";
import { decryptServiceEnv, SERVICE_ENV_DECRYPTION_ERROR } from "./secrets.js";
import {
  checkServiceHealth,
  restartService,
  ServiceError,
  startService,
  stopService,
  wslCommandArgs,
  type HostRow,
  type ServiceRow,
} from "./manager.js";
import {
  getServiceController,
  type ServiceInspection,
} from "./service-control.js";

type ActionRow = typeof actions.$inferSelect;
type DeployResultStatus = "succeeded" | "failed";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.includes("SQLITE_CONSTRAINT");
}

function isSelfService(service: ServiceRow): boolean {
  if (service.controlMode !== "windows-service" || !config.SELF_SERVICE_NAME) {
    return false;
  }
  return (
    service.serviceName?.trim().toLowerCase() ===
    config.SELF_SERVICE_NAME.toLowerCase()
  );
}

async function getHost(id: string): Promise<HostRow | undefined> {
  const [row] = await db.select().from(hosts).where(eq(hosts.id, id)).limit(1);
  return row;
}

async function writeDeployLog(
  service: ServiceRow,
  stream: "stdout" | "stderr",
  message: string,
  actionId: string,
  level?: LogLevel,
): Promise<void> {
  try {
    await ingestLog({
      hostId: service.hostId,
      serviceId: service.id,
      stream,
      level,
      message: `[deploy] ${message}`,
      fields: { source: "deploy", actionId },
    });
  } catch (error) {
    // ログ保存の失敗でデプロイ自体を失敗させない。
    console.warn(
      `[deploy] log ingest failed (${service.name}): ${errorMessage(error)}`,
    );
  }
}

function attachDeployLogs(
  stream: NodeJS.ReadableStream | null,
  service: ServiceRow,
  name: "stdout" | "stderr",
  actionId: string,
): ProcessLineStreamHandle | undefined {
  if (!stream) return undefined;
  return attachProcessLineStream(
    stream as unknown as NodeJS.EventEmitter,
    (line) => {
      const message = stripAnsi(line).trimEnd();
      if (!message.trim()) return;
      void writeDeployLog(service, name, message, actionId).catch(
        (error: unknown) => {
          console.warn(
            `[deploy] log ingest failed (${service.name}): ${errorMessage(error)}`,
          );
        },
      );
    },
  );
}

interface ExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

function waitForExit(child: ChildProcess): Promise<ExitResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ExitResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error: Error) =>
      finish({ code: null, signal: null, error }),
    );
    // close は stdio の読み取り完了後に発火するため、最後のログを取りこぼしにくい。
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

async function finishDeploy(
  serviceId: string,
  actionId: string,
  status: DeployResultStatus,
  error: string | null,
  deployRequestId: string | null = null,
): Promise<void> {
  const now = new Date();
  await db
    .update(actions)
    .set({ status, finishedAt: now, error })
    .where(eq(actions.id, actionId));
  await db
    .update(services)
    .set({
      lastDeployAt: now,
      lastDeployStatus: status,
      lastDeployError: error,
      updatedAt: now,
    })
    .where(eq(services.id, serviceId));
  if (deployRequestId) {
    await db
      .update(deployRequests)
      .set({ status: status === "succeeded" ? "executed" : "failed" })
      .where(eq(deployRequests.id, deployRequestId));
  }
}

async function waitForHealthy(
  serviceId: string,
  timeoutSec: number,
): Promise<{ status: string; detail?: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  let last: { status: string; detail?: string } = { status: "unknown" };

  while (Date.now() < deadline) {
    await sleep(2000);
    const [row] = await db
      .select()
      .from(services)
      .where(eq(services.id, serviceId))
      .limit(1);
    if (!row || !row.isActive) {
      throw new Error("デプロイ中にサービスが見つからなくなりました");
    }

    const health = await checkServiceHealth(serviceId);
    last = health;

    if (row.controlMode === "windows-service") {
      const controller = getServiceController(row);
      if (controller) {
        const inspection = await controller.inspect(row);
        if (inspection.missing) {
          throw new Error("Windows サービスが見つかりません");
        }
        if (
          inspection.state === "unknown" &&
          inspection.detail &&
          Date.now() >= deadline
        ) {
          throw new Error(inspection.detail);
        }
        const scmRunning =
          inspection.state === "running" || inspection.state === "degraded";
        const hasHealthCheck = Boolean(row.healthCheck);
        if (scmRunning && (!hasHealthCheck || health.status === "healthy")) {
          return health;
        }
      }
    } else if (
      row.status === "running" &&
      (health.status === "healthy" || health.status === "unknown")
    ) {
      return health;
    }
    if (row.status === "failed" || row.status === "stopped") {
      throw new Error(
        `サービスが ${row.status} になりました${
          row.lastError ? `: ${row.lastError}` : ""
        }`,
      );
    }
  }

  throw new Error(
    `ヘルスチェックが ${timeoutSec} 秒以内に成功しませんでした (status=${last.status}${
      last.detail ? `, ${last.detail}` : ""
    })`,
  );
}

export function isDeployRunning(serviceId: string): boolean {
  return isLocalDeployRunning(serviceId);
}

/**
 * デプロイ action を作成し、サービスに running 状態を記録する。
 * 実際の実行は runDeploy が非同期で行う。
 */
export async function beginDeploy(
  service: ServiceRow,
  user: AuthUser,
): Promise<ActionRow> {
  // DB チェックの await 中に別リクエストが入らないよう、先に in-memory で確保する。
  if (!tryReserveLocalDeploy(service.id)) {
    throw new ServiceError(409, "デプロイは既に実行中です");
  }

  try {
    const [running] = await db
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.serviceId, service.id),
          eq(actions.type, "deploy"),
          inArray(actions.status, ["pending", "running"]),
        ),
      )
      .limit(1);
    if (running) {
      throw new ServiceError(409, "デプロイは既に実行中です");
    }

    const startedAt = new Date();
    const actionId = randomUUID();
    await db.insert(actions).values({
      id: actionId,
      incidentId: null,
      serviceId: service.id,
      type: "deploy",
      status: "running",
      requestedBy: user.id,
      approvedBy: null,
      policyId: null,
      startedAt,
      finishedAt: null,
      error: null,
    });
    await db
      .update(services)
      .set({
        lastDeployAt: startedAt,
        lastDeployStatus: "running",
        lastDeployError: null,
        updatedAt: startedAt,
      })
      .where(eq(services.id, service.id));

    const [action] = await db
      .select()
      .from(actions)
      .where(eq(actions.id, actionId))
      .limit(1);
    if (!action) throw new Error("デプロイ action の作成に失敗しました");
    return action;
  } catch (error) {
    releaseLocalDeploy(service.id);
    if (isUniqueConstraint(error)) {
      throw new ServiceError(409, "デプロイは既に実行中です");
    }
    throw error;
  }
}

/**
 * デプロイを実行する。呼び出し側は await せず、202 を返す。
 * 例外はすべてここで処理し、action / service に失敗状態を残す。
 */
export async function runDeploy(
  service: ServiceRow,
  deploy: DeployConfigInput,
  actionId: string,
  user: AuthUser,
  ip: string | null,
  deployRequestId: string | null = null,
): Promise<void> {
  const external = service.controlMode === "windows-service";
  const controlOwner = external ? (deploy.serviceControlOwner ?? null) : null;
  let mustStartAfterDeploy = false;

  try {
    if (isSelfService(service)) {
      throw new ServiceError(
        409,
        "sys4sys 自身はこの API からデプロイできません。外部のオーケストレータから実行してください",
      );
    }

    const allowed = isCommandAllowed(deploy.command);
    if (!allowed.ok) {
      throw new ServiceError(
        422,
        allowed.reason ?? "デプロイコマンドが許可されていません",
      );
    }

    const cwd = (deploy.cwd?.trim() || service.cwd?.trim() || "").trim();
    if (!cwd) {
      throw new ServiceError(
        422,
        "デプロイ用の cwd がありません。サービスまたはデプロイ設定で指定してください",
      );
    }

    const host = await getHost(service.hostId);
    if (!host) throw new ServiceError(422, "ホストが見つかりません");
    if (!host.enabled) {
      throw new ServiceError(409, "ホストが無効化されています");
    }
    if (host.kind === "wsl" && !host.distro) {
      throw new ServiceError(422, "WSL ホストの distro が設定されていません");
    }
    if (host.kind === "windows") {
      if (!existsSync(cwd)) {
        throw new ServiceError(422, `デプロイ cwd が存在しません: ${cwd}`);
      }
      if (!statSync(cwd).isDirectory()) {
        throw new ServiceError(
          422,
          `デプロイ cwd がディレクトリではありません: ${cwd}`,
        );
      }
    }

    if (external) {
      if (host.kind !== "windows") {
        throw new ServiceError(
          422,
          "windows-service は Windows ホストでのみ deploy できます",
        );
      }
      if (!service.serviceName) {
        throw new ServiceError(422, "serviceName が設定されていません");
      }
      if (!controlOwner) {
        throw new ServiceError(
          422,
          "windows-service の deploy には serviceControlOwner が必要です",
        );
      }
    }

    const restartAfter = external
      ? controlOwner === "sys4sys"
      : deploy.restartAfter;

    let env: Record<string, string>;
    try {
      env = {
        ...(decryptServiceEnv(service.env) ?? {}),
        ...(decryptServiceEnv(deploy.env) ?? {}),
        SYS4SYS_DEPLOY_ACTION_ID: actionId,
        ...(external
          ? {
              SYS4SYS_SERVICE_CONTROL: controlOwner!,
              SYS4SYS_SERVICE_NAME: service.serviceName!,
            }
          : {}),
      };
    } catch {
      throw new ServiceError(500, SERVICE_ENV_DECRYPTION_ERROR);
    }

    if (external && controlOwner === "sys4sys") {
      const controller = getServiceController(service);
      if (!controller) {
        throw new ServiceError(422, "外部サービスではありません");
      }
      await writeDeployLog(
        service,
        "stdout",
        "stopping service via SCM",
        actionId,
        "info",
      );
      const before = await controller.inspect(service);
      if (before.missing) {
        throw new ServiceError(503, "Windows サービスが見つかりません");
      }
      if (before.state === "unknown") {
        throw new ServiceError(
          503,
          before.detail ?? "Windows サービスの状態を確認できませんでした",
        );
      }
      if (before.state !== "stopped") {
        await stopService(service.id, { allowDuringDeploy: true });
      }
      const stopped: ServiceInspection = await controller.inspect(service);
      if (stopped.missing) {
        throw new ServiceError(503, "Windows サービスが見つかりません");
      }
      if (stopped.state !== "stopped") {
        throw new ServiceError(
          503,
          `サービスの停止を確認できませんでした (state=${stopped.state})`,
        );
      }
      mustStartAfterDeploy = true;
      await writeDeployLog(
        service,
        "stdout",
        "service is stopped",
        actionId,
        "info",
      );
    }

    await writeDeployLog(
      service,
      "stdout",
      `starting: ${deploy.command.join(" ")} (cwd=${cwd})`,
      actionId,
      "info",
    );

    const child =
      host.kind === "windows"
        ? spawn(deploy.command[0]!, deploy.command.slice(1), {
            cwd,
            env: { ...process.env, ...env },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          })
        : spawn("wsl.exe", wslCommandArgs(host, deploy.command, cwd, env), {
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });

    const stdout = attachDeployLogs(child.stdout, service, "stdout", actionId);
    const stderr = attachDeployLogs(child.stderr, service, "stderr", actionId);

    let timedOut = false;
    const timeoutMs = deploy.timeoutSec * 1000;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        void stopProcess({
          scope: "windows",
          pid: child.pid,
          force: true,
        }).catch((error: unknown) => {
          console.warn(
            `[deploy] timed out process stop failed: ${errorMessage(error)}`,
          );
        });
      }
    }, timeoutMs);

    // stopProcess が効かない場合でも runDeploy を永久に待たせない。
    let hardTimer: NodeJS.Timeout | undefined;
    const hardStop = new Promise<ExitResult>((resolve) => {
      hardTimer = setTimeout(() => {
        resolve({
          code: null,
          signal: null,
          error: new Error(
            `デプロイプロセスが ${deploy.timeoutSec} 秒のタイムアウト後も終了しません`,
          ),
        });
      }, timeoutMs + 15_000);
      hardTimer.unref();
    });

    const result = await Promise.race([waitForExit(child), hardStop]);

    clearTimeout(timeoutTimer);
    if (hardTimer) clearTimeout(hardTimer);
    stdout?.destroy();
    stderr?.destroy();

    if (result.error) {
      throw new Error(
        `デプロイコマンドの実行に失敗しました: ${result.error.message}`,
      );
    }
    if (timedOut) {
      throw new Error(
        `デプロイがタイムアウトしました (${deploy.timeoutSec} 秒)`,
      );
    }
    if (result.code !== 0) {
      throw new Error(
        `デプロイコマンドが異常終了しました (exit=${result.code ?? "null"}${
          result.signal ? `, signal=${result.signal}` : ""
        })`,
      );
    }

    await writeDeployLog(
      service,
      "stdout",
      "command completed successfully",
      actionId,
      "info",
    );

    if (external) {
      if (controlOwner === "sys4sys") {
        await writeDeployLog(
          service,
          "stdout",
          "starting service via SCM",
          actionId,
          "info",
        );
        await startService(service.id, { allowDuringDeploy: true });
        mustStartAfterDeploy = false;
        await writeDeployLog(
          service,
          "stdout",
          "service is running",
          actionId,
          "info",
        );
      } else {
        await writeDeployLog(
          service,
          "stdout",
          "service control owned by deploy script",
          actionId,
          "info",
        );
      }
      await writeDeployLog(
        service,
        "stdout",
        `waiting for health (timeout ${deploy.healthTimeoutSec}s)`,
        actionId,
        "info",
      );
      const health = await waitForHealthy(service.id, deploy.healthTimeoutSec);
      await writeDeployLog(
        service,
        "stdout",
        `service is ${health.status}`,
        actionId,
        "info",
      );
    } else if (restartAfter) {
      await writeDeployLog(
        service,
        "stdout",
        "restarting service",
        actionId,
        "info",
      );
      await restartService(service.id, { allowDuringDeploy: true });
      await writeDeployLog(
        service,
        "stdout",
        `waiting for health (timeout ${deploy.healthTimeoutSec}s)`,
        actionId,
        "info",
      );
      const health = await waitForHealthy(service.id, deploy.healthTimeoutSec);
      await writeDeployLog(
        service,
        "stdout",
        `service is ${health.status}`,
        actionId,
        "info",
      );
    } else {
      await writeDeployLog(
        service,
        "stdout",
        "restart skipped (restartAfter=false)",
        actionId,
        "info",
      );
    }

    await finishDeploy(
      service.id,
      actionId,
      "succeeded",
      null,
      deployRequestId,
    );
    await writeDeployLog(
      service,
      "stdout",
      "deploy succeeded",
      actionId,
      "info",
    );
    try {
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.deploy",
        target: `service:${service.id}`,
        after: {
          actionId,
          command: deploy.command,
          cwd,
          status: "succeeded",
          controlMode: service.controlMode,
          serviceName: service.serviceName,
          serviceControlOwner: controlOwner,
        },
        ip,
      });
    } catch (auditError) {
      // 監査ログの失敗で成功済みデプロイを失敗扱いにしない。
      console.warn(
        `[deploy] failed to write success audit: ${errorMessage(auditError)}`,
      );
    }
  } catch (error) {
    let message = errorMessage(error).slice(0, 2000);

    if (mustStartAfterDeploy && controlOwner === "sys4sys") {
      try {
        await writeDeployLog(
          service,
          "stdout",
          "deploy failed; starting service via SCM",
          actionId,
          "warn",
        );
        await startService(service.id, { allowDuringDeploy: true });
        mustStartAfterDeploy = false;
        await writeDeployLog(
          service,
          "stdout",
          "service recovery start completed",
          actionId,
          "info",
        );
      } catch (startError) {
        const startMessage = `サービスの復旧起動に失敗しました: ${errorMessage(startError)}`;
        message = `${message}\n${startMessage}`.slice(0, 2000);
        await writeDeployLog(
          service,
          "stderr",
          startMessage,
          actionId,
          "error",
        ).catch(() => undefined);
      }
    }

    try {
      await writeDeployLog(
        service,
        "stderr",
        `deploy failed: ${message}`,
        actionId,
        "error",
      );
    } catch {
      // ログ保存に失敗しても action の失敗記録は続ける
    }
    try {
      await finishDeploy(
        service.id,
        actionId,
        "failed",
        message,
        deployRequestId,
      );
    } catch (finishError) {
      console.warn(
        `[deploy] failed to persist failure state: ${errorMessage(finishError)}`,
      );
    }
    try {
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.deploy.failed",
        target: `service:${service.id}`,
        after: {
          actionId,
          controlMode: service.controlMode,
          serviceName: service.serviceName,
          serviceControlOwner: controlOwner,
        },
        reason: message.slice(0, 500),
        ip,
      });
    } catch (auditError) {
      console.warn(
        `[deploy] failed to write audit: ${errorMessage(auditError)}`,
      );
    }
  } finally {
    releaseLocalDeploy(service.id);
  }
}

/**
 * API 再起動時に running のまま残ったデプロイを失敗として確定する。
 * 実際のデプロイプロセスは API と共に失われているため、成功扱いにはしない。
 */
export async function reconcileDeployments(): Promise<void> {
  const rows = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.type, "deploy"),
        inArray(actions.status, ["pending", "running"]),
      ),
    );

  const cutoff = Date.now() - config.DEPLOY_STALE_MS;
  for (const row of rows) {
    if (isLocalDeployRunning(row.serviceId)) continue;
    if (new Date(row.startedAt).getTime() > cutoff) continue;
    const now = new Date();
    const message =
      "API がデプロイ中に再起動したため、デプロイ結果を確認できませんでした";
    await db
      .update(actions)
      .set({ status: "failed", finishedAt: now, error: message })
      .where(eq(actions.id, row.id));
    await db
      .update(services)
      .set({
        lastDeployAt: now,
        lastDeployStatus: "failed",
        lastDeployError: message,
        updatedAt: now,
      })
      .where(eq(services.id, row.serviceId));
  }
}
