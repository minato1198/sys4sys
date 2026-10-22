import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, notLike, or } from "drizzle-orm";
import type { IncidentSeverity } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { incidents, logEvents, services } from "../db/schema.js";
import {
  serviceEvents,
  type ServiceDegradedEvent,
  type ServiceExitEvent,
} from "../services/events.js";
import {
  createIncident,
  evaluateIncidentAutomation,
  recordServiceExit,
} from "./incidents.js";

type ServiceRow = typeof services.$inferSelect;

// デプロイ操作の出力はサービス異常ではないため、ログ監視の対象から外す。
const notDeployLog = or(
  isNull(logEvents.fields),
  notLike(logEvents.fields, '%"source":"deploy"%'),
);

let intervalTimer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;
let running = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findService(id: string): Promise<ServiceRow | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, id))
    .limit(1);
  return row ?? null;
}

async function handleExit(event: ServiceExitEvent): Promise<void> {
  recordServiceExit(event.serviceId);
  const service = await findService(event.serviceId);
  if (!service || !service.isActive) return;

  const { incident } = await createIncident({
    serviceId: service.id,
    fingerprint: `service-failure:${service.id}`,
    title: `サービスが異常終了しました: ${service.name}`,
    severity: "error",
    detectedBy: "process",
    summary: `exit code=${event.code ?? "null"}, signal=${
      event.signal ?? "null"
    }`,
    details: {
      code: event.code,
      signal: event.signal,
      exitedAt: event.exitedAt,
    },
  });
  await evaluateIncidentAutomation(incident, service, {
    consecutiveFailures: 1,
    failureThreshold: 1,
  });
}

async function handleDegraded(event: ServiceDegradedEvent): Promise<void> {
  const service = await findService(event.serviceId);
  if (!service || !service.isActive) return;
  const thresholds = service.healthCheck as { failures?: unknown } | null;
  const failureThreshold =
    typeof thresholds?.failures === "number" ? thresholds.failures : 3;

  const { incident } = await createIncident({
    serviceId: service.id,
    fingerprint: `service-failure:${service.id}`,
    title: `ヘルスチェックが失敗しました: ${service.name}`,
    severity: "error",
    detectedBy: "health",
    summary: event.detail,
    details: {
      consecutiveFailures: event.consecutiveFailures,
      checkedAt: event.checkedAt,
    },
  });
  await evaluateIncidentAutomation(incident, service, {
    consecutiveFailures: event.consecutiveFailures,
    failureThreshold,
  });
}

async function lastLog(serviceId: string) {
  const [row] = await db
    .select()
    .from(logEvents)
    .where(eq(logEvents.serviceId, serviceId))
    .orderBy(desc(logEvents.ts))
    .limit(1);
  return row ?? null;
}

async function runHeartbeatRules(service: ServiceRow): Promise<void> {
  if (config.MONITOR_HEARTBEAT_TIMEOUT_SEC <= 0) return;
  const last = await lastLog(service.id);
  if (!last) return;
  if (service.lastStartedAt && last.ts < service.lastStartedAt) return;
  const ageSec = (Date.now() - last.ts.getTime()) / 1000;
  if (ageSec < config.MONITOR_HEARTBEAT_TIMEOUT_SEC) return;

  const { incident } = await createIncident({
    serviceId: service.id,
    fingerprint: `heartbeat:${service.id}`,
    title: `ログ / ハートビートが途絶えています: ${service.name}`,
    severity: "warning",
    detectedBy: "rule",
    summary: `最後のログから ${Math.round(ageSec)} 秒経過しています`,
    details: { lastLogAt: last.ts.toISOString(), ageSec },
  });
  await evaluateIncidentAutomation(incident, service);
}

async function runErrorLogRules(service: ServiceRow): Promise<void> {
  const threshold = config.MONITOR_ERROR_LOG_THRESHOLD;
  if (threshold <= 0) return;
  const cutoff = new Date(
    Date.now() - config.MONITOR_ERROR_LOG_WINDOW_SEC * 1000,
  );
  const rows = await db
    .select()
    .from(logEvents)
    .where(
      and(
        eq(logEvents.serviceId, service.id),
        inArray(logEvents.level, ["error", "fatal"]),
        gte(logEvents.ts, cutoff),
        notDeployLog,
      ),
    )
    .orderBy(desc(logEvents.ts))
    .limit(threshold);
  if (rows.length < threshold) return;
  const latest = rows[0]!;

  const { incident } = await createIncident({
    serviceId: service.id,
    fingerprint: `logs:${service.id}`,
    title: `エラーログが多発しています: ${service.name}`,
    severity: "error",
    detectedBy: "rule",
    summary: `${config.MONITOR_ERROR_LOG_WINDOW_SEC} 秒以内に ${rows.length} 件以上のエラー`,
    details: {
      count: rows.length,
      latestMessage: latest.message.slice(0, 1000),
      latestAt: latest.ts.toISOString(),
    },
  });
  await evaluateIncidentAutomation(incident, service);
}

async function runPatternRules(service: ServiceRow): Promise<void> {
  const patternText = config.MONITOR_LOG_PATTERN.trim();
  if (!patternText) return;
  let pattern: RegExp;
  try {
    pattern = new RegExp(patternText);
  } catch (error) {
    console.warn(
      `[monitor] invalid MONITOR_LOG_PATTERN: ${errorMessage(error)}`,
    );
    return;
  }
  const cutoff = new Date(Date.now() - 60_000);
  const rows = await db
    .select()
    .from(logEvents)
    .where(
      and(
        eq(logEvents.serviceId, service.id),
        gte(logEvents.ts, cutoff),
        notDeployLog,
      ),
    )
    .orderBy(desc(logEvents.ts))
    .limit(200);
  const matched = rows.find((row) => pattern.test(row.message));
  if (!matched) return;
  const fingerprint = `pattern:${service.id}:${createHash("sha256")
    .update(patternText)
    .digest("hex")
    .slice(0, 12)}`;

  const { incident } = await createIncident({
    serviceId: service.id,
    fingerprint,
    title: `監視パターンに一致するログ: ${service.name}`,
    severity: "error" as IncidentSeverity,
    detectedBy: "rule",
    summary: matched.message.slice(0, 1000),
    details: { pattern: patternText, logId: matched.id },
  });
  await evaluateIncidentAutomation(incident, service);
}

export async function runMonitorCycle(): Promise<void> {
  if (!running) return;
  const rows = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.isActive, true),
        inArray(services.status, ["running", "degraded"]),
      ),
    );
  for (const service of rows) {
    try {
      await runHeartbeatRules(service);
      await runErrorLogRules(service);
      await runPatternRules(service);
    } catch (error) {
      console.warn(
        `[monitor] rules failed for ${service.name}: ${errorMessage(error)}`,
      );
    }
  }
}

async function safeHandle(handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    console.warn(`[monitor] event handler failed: ${errorMessage(error)}`);
  }
}

async function onExit(event: ServiceExitEvent): Promise<void> {
  await safeHandle(() => handleExit(event));
}

async function onDegraded(event: ServiceDegradedEvent): Promise<void> {
  await safeHandle(() => handleDegraded(event));
}

export function startMonitor(): void {
  if (!config.MONITOR_ENABLED || running) return;
  running = true;
  serviceEvents.on("exited", onExit);
  serviceEvents.on("degraded", onDegraded);

  startupTimer = setTimeout(() => {
    void runMonitorCycle().catch((error: unknown) => {
      console.warn(`[monitor] initial cycle failed: ${errorMessage(error)}`);
    });
  }, config.MONITOR_STARTUP_DELAY_SEC * 1000);
  startupTimer.unref();

  intervalTimer = setInterval(() => {
    void runMonitorCycle().catch((error: unknown) => {
      console.warn(`[monitor] cycle failed: ${errorMessage(error)}`);
    });
  }, config.MONITOR_INTERVAL_SEC * 1000);
  intervalTimer.unref();
  console.log(
    `[monitor] started (interval=${config.MONITOR_INTERVAL_SEC}s, heartbeat=${
      config.MONITOR_HEARTBEAT_TIMEOUT_SEC || "off"
    }, errorLogThreshold=${config.MONITOR_ERROR_LOG_THRESHOLD || "off"})`,
  );
}

export function stopMonitor(): void {
  running = false;
  serviceEvents.off("exited", onExit);
  serviceEvents.off("degraded", onDegraded);
  if (startupTimer) clearTimeout(startupTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  startupTimer = null;
  intervalTimer = null;
}

/** テスト用: 実行中の監視状態を確認する。 */
export function monitorStatus(): { running: boolean } {
  return { running };
}

/** テスト用: 指定サービスの監視ルールを即時実行する。 */
export async function runRulesForService(serviceId: string): Promise<void> {
  const service = await findService(serviceId);
  if (!service) return;
  await runHeartbeatRules(service);
  await runErrorLogRules(service);
  await runPatternRules(service);
}

/** 監視対象のインシデント数を返す（テスト用）。 */
export async function countOpenIncidents(): Promise<number> {
  const rows = await db
    .select({ id: incidents.id })
    .from(incidents)
    .where(eq(incidents.status, "open"));
  return rows.length;
}
