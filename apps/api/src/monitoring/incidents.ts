import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { evaluateRestart, type RestartDecision } from "@sys4sys/policy";
import type { IncidentSeverity, IncidentStatus } from "@sys4sys/shared";
import { enqueueIncidentAnalysis } from "../ai/queue.js";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  actions,
  approvals,
  hosts,
  incidentEvents,
  incidents,
  services,
} from "../db/schema.js";
import { checkServiceHealth, restartService } from "../services/manager.js";
import { notifyApprovalRequest, notifyIncident } from "./notify.js";
import {
  backoffMsForAttempt,
  isCrashLoop,
  isRecent,
  maxSeverity,
  parseBackoff,
} from "./rules.js";

type IncidentRow = typeof incidents.$inferSelect;
type IncidentEventRow = typeof incidentEvents.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type ActionRow = typeof actions.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;

export class IncidentError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IncidentError";
  }
}

export interface CreateIncidentInput {
  serviceId: string;
  fingerprint: string;
  title: string;
  severity: IncidentSeverity;
  detectedBy: "rule" | "health" | "process" | "ai";
  summary?: string;
  details?: Record<string, unknown>;
}

export interface IncidentContext {
  incident: IncidentRow;
  service: ServiceRow | null;
  host: HostRow | null;
  events: IncidentEventRow[];
  approvals: ApprovalRow[];
  actions: ActionRow[];
}

const recentExits = new Map<string, number[]>();
const scheduledRestarts = new Set<string>();

function nowMs(): number {
  return Date.now();
}

function backoffList(): number[] {
  return parseBackoff(config.AUTO_RESTART_BACKOFF_SEC);
}

export function recordServiceExit(serviceId: string): void {
  const now = nowMs();
  const windowMs = config.AUTO_RESTART_WINDOW_SEC * 1000;
  const history = (recentExits.get(serviceId) ?? []).filter(
    (ts) => now - ts <= windowMs,
  );
  history.push(now);
  recentExits.set(serviceId, history);
}

export async function appendIncidentEvent(
  incidentId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db.insert(incidentEvents).values({
    id: randomUUID(),
    incidentId,
    ts: new Date(),
    type,
    payload: payload ?? null,
  });
}

async function getService(serviceId: string): Promise<ServiceRow | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  return row ?? null;
}

async function getHost(hostId: string): Promise<HostRow | null> {
  const [row] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .limit(1);
  return row ?? null;
}

async function notifyForIncident(
  incident: IncidentRow,
  kind:
    | "detected"
    | "approved"
    | "rejected"
    | "recovered"
    | "restart_failed"
    | "escalated",
  extra?: string,
): Promise<void> {
  const service = await getService(incident.serviceId);
  const host = service ? await getHost(service.hostId) : null;
  await notifyIncident({ incident, service, host, kind, extra });
}

export async function createIncident(
  input: CreateIncidentInput,
): Promise<{ incident: IncidentRow; created: boolean }> {
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - config.INCIDENT_DEDUPE_MINUTES * 60 * 1000,
  );
  const [existing] = await db
    .select()
    .from(incidents)
    .where(
      and(
        eq(incidents.serviceId, input.serviceId),
        eq(incidents.fingerprint, input.fingerprint),
        or(isNull(incidents.resolvedAt), gte(incidents.startedAt, cutoff)),
      ),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(1);

  if (existing) {
    const reopened = existing.status === "resolved";
    const status: IncidentStatus = reopened ? "open" : existing.status;
    const [updated] = await db
      .update(incidents)
      .set({
        status,
        resolvedAt: null,
        title: input.title,
        severity: maxSeverity(existing.severity, input.severity),
        summary: input.summary ?? existing.summary,
      })
      .where(eq(incidents.id, existing.id))
      .returning();
    await appendIncidentEvent(existing.id, "recurred", {
      summary: input.summary,
      details: input.details,
    });
    return { incident: updated ?? existing, created: false };
  }

  const id = randomUUID();
  const [created] = await db
    .insert(incidents)
    .values({
      id,
      serviceId: input.serviceId,
      fingerprint: input.fingerprint,
      title: input.title,
      severity: input.severity,
      status: "open",
      startedAt: now,
      resolvedAt: null,
      detectedBy: input.detectedBy,
      restartAttempts: 0,
      summary: input.summary ?? null,
    })
    .returning();
  const incident = created!;
  await appendIncidentEvent(id, "detected", {
    summary: input.summary,
    details: input.details,
  });
  await writeAudit({
    actorLabel: "monitor",
    action: "incident.create",
    target: `incident:${id}`,
    after: {
      serviceId: input.serviceId,
      fingerprint: input.fingerprint,
      severity: input.severity,
      detectedBy: input.detectedBy,
    },
  }).catch(() => undefined);
  void notifyForIncident(incident, "detected", input.summary).catch(
    () => undefined,
  );
  enqueueIncidentAnalysis(incident.id);
  return { incident, created: true };
}

export async function getIncidentContext(
  id: string,
): Promise<IncidentContext | null> {
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  if (!incident) return null;
  const service = await getService(incident.serviceId);
  const host = service ? await getHost(service.hostId) : null;
  const [events, pendingApprovals, recentActions] = await Promise.all([
    db
      .select()
      .from(incidentEvents)
      .where(eq(incidentEvents.incidentId, id))
      .orderBy(incidentEvents.ts),
    db
      .select()
      .from(approvals)
      .where(eq(approvals.incidentId, id))
      .orderBy(desc(approvals.requestedAt)),
    db
      .select()
      .from(actions)
      .where(eq(actions.incidentId, id))
      .orderBy(desc(actions.startedAt)),
  ]);
  return {
    incident,
    service,
    host,
    events,
    approvals: pendingApprovals,
    actions: recentActions,
  };
}

export async function ackIncident(
  id: string,
  actor: { id: string; email: string },
  note?: string,
): Promise<IncidentRow> {
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  if (!incident) throw new IncidentError(404, "インシデントが見つかりません");
  if (incident.status === "resolved") {
    throw new IncidentError(409, "解決済みのインシデントです");
  }
  const [updated] = await db
    .update(incidents)
    .set({ status: "acked" })
    .where(eq(incidents.id, id))
    .returning();
  await appendIncidentEvent(id, "acked", {
    by: actor.email,
    note: note ?? null,
  });
  return updated ?? incident;
}

async function expirePendingApprovals(incidentId: string): Promise<void> {
  await db
    .update(approvals)
    .set({
      status: "expired",
      decidedAt: new Date(),
      note: "インシデントが解決されました",
    })
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    );
}

export async function resolveIncident(
  id: string,
  actor: { id: string; email: string } | null,
  note?: string,
): Promise<IncidentRow> {
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  if (!incident) throw new IncidentError(404, "インシデントが見つかりません");
  const [updated] = await db
    .update(incidents)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(eq(incidents.id, id))
    .returning();
  await expirePendingApprovals(id);
  await appendIncidentEvent(id, "resolved", {
    by: actor?.email ?? "system",
    note: note ?? null,
  });
  return updated ?? incident;
}

async function resolveOtherIncidents(
  serviceId: string,
  keepIncidentId: string,
  note: string,
): Promise<void> {
  const rows = await db
    .update(incidents)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(
      and(
        eq(incidents.serviceId, serviceId),
        ne(incidents.id, keepIncidentId),
        inArray(incidents.status, ["open", "acked", "approval"]),
      ),
    )
    .returning({ id: incidents.id });
  for (const row of rows) {
    await expirePendingApprovals(row.id);
    await appendIncidentEvent(row.id, "resolved", {
      by: "system",
      note,
    });
  }
}

export async function createApproval(
  incidentId: string,
  reason: string,
): Promise<ApprovalRow> {
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!incident) throw new IncidentError(404, "インシデントが見つかりません");
  if (incident.status === "resolved") {
    throw new IncidentError(409, "解決済みのインシデントです");
  }

  const [existing] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(approvals)
    .values({
      id: randomUUID(),
      incidentId,
      requestedAction: {
        type: "restart",
        serviceId: incident.serviceId,
        reason,
      },
      status: "pending",
      requestedAt: new Date(),
    })
    .returning();
  const approval = created!;
  await db
    .update(incidents)
    .set({ status: "approval" })
    .where(eq(incidents.id, incidentId));
  await appendIncidentEvent(incidentId, "approval_requested", { reason });
  await writeAudit({
    actorLabel: "monitor",
    action: "approval.request",
    target: `incident:${incidentId}`,
    after: { reason },
  }).catch(() => undefined);

  const service = await getService(incident.serviceId);
  const host = service ? await getHost(service.hostId) : null;
  void notifyApprovalRequest(approval, incident, service, host).catch(
    () => undefined,
  );
  return approval;
}

export interface ApprovalDecisionResult {
  approval: ApprovalRow;
  action: ActionRow | null;
  incident: IncidentRow;
}

export async function decideApproval(
  id: string,
  decision: "approved" | "rejected",
  actor: { id: string; email: string },
  note?: string,
): Promise<ApprovalDecisionResult> {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, id))
    .limit(1);
  if (!approval) throw new IncidentError(404, "承認が見つかりません");
  if (approval.status !== "pending") {
    throw new IncidentError(409, "この承認は既に処理されています");
  }
  if (approval.requestedBy && approval.requestedBy === actor.id) {
    throw new IncidentError(403, "自己承認は許可されていません");
  }
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, approval.incidentId))
    .limit(1);
  if (!incident) throw new IncidentError(404, "インシデントが見つかりません");
  if (incident.status === "resolved") {
    throw new IncidentError(409, "解決済みのインシデントです");
  }

  const service =
    decision === "approved" ? await getService(incident.serviceId) : null;
  if (decision === "approved" && !service) {
    throw new IncidentError(404, "サービスが見つかりません");
  }

  const [updatedApproval] = await db
    .update(approvals)
    .set({
      status: decision,
      decidedBy: actor.email,
      decidedAt: new Date(),
      note: note ?? null,
    })
    .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
    .returning();
  if (!updatedApproval) {
    throw new IncidentError(409, "この承認は既に処理されています");
  }
  const decided = updatedApproval;

  if (decision === "rejected") {
    const [updatedIncident] = await db
      .update(incidents)
      .set({ status: "open" })
      .where(
        and(eq(incidents.id, incident.id), ne(incidents.status, "resolved")),
      )
      .returning();
    await appendIncidentEvent(incident.id, "approval_rejected", {
      by: actor.email,
      note: note ?? null,
    });
    await writeAudit({
      actorUserId: actor.id,
      actorLabel: actor.email,
      action: "approval.rejected",
      target: `approval:${id}`,
      after: {
        serviceId: incident.serviceId,
        incidentId: incident.id,
      },
      reason: note ?? null,
    }).catch(() => undefined);
    void notifyForIncident(
      updatedIncident ?? incident,
      "rejected",
      note ?? undefined,
    ).catch(() => undefined);
    return {
      approval: decided,
      action: null,
      incident: updatedIncident ?? incident,
    };
  }

  await appendIncidentEvent(incident.id, "approval_approved", {
    by: actor.email,
    note: note ?? null,
  });
  const action = await startRestartAction({
    incident,
    service: service!,
    requestedBy: actor.email,
    approvedBy: actor.email,
    reason: `承認された再起動 (${actor.email})`,
    delayMs: 0,
  });
  await writeAudit({
    actorUserId: actor.id,
    actorLabel: actor.email,
    action: "approval.approved",
    target: `approval:${id}`,
    after: {
      serviceId: incident.serviceId,
      incidentId: incident.id,
      actionId: action.id,
    },
    reason: note ?? null,
  }).catch(() => undefined);
  void notifyForIncident(incident, "approved", note ?? undefined).catch(
    () => undefined,
  );
  return { approval: decided, action, incident };
}

export interface StartRestartInput {
  incident: IncidentRow;
  service: ServiceRow;
  requestedBy: string;
  approvedBy?: string | null;
  reason: string;
  delayMs: number;
}

export async function startRestartAction(
  input: StartRestartInput,
): Promise<ActionRow> {
  const [created] = await db
    .insert(actions)
    .values({
      id: randomUUID(),
      incidentId: input.incident.id,
      serviceId: input.service.id,
      type: "restart",
      status: input.delayMs > 0 ? "pending" : "running",
      requestedBy: input.requestedBy,
      approvedBy: input.approvedBy ?? null,
      policyId: null,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
    })
    .returning();
  const action = created!;

  if (input.delayMs > 0) {
    const timer = setTimeout(() => {
      void executeRestart(action.id).catch((error: unknown) => {
        console.warn(
          `[monitor] scheduled restart failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, input.delayMs);
    timer.unref();
  } else {
    void executeRestart(action.id).catch((error: unknown) => {
      console.warn(
        `[monitor] restart action failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  return action;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyRecovery(
  serviceId: string,
  timeoutSec: number,
): Promise<{ ok: boolean; detail: string }> {
  const deadline = Date.now() + timeoutSec * 1000;
  let stableSince: number | null = null;
  let detail = "復旧確認がタイムアウトしました";

  while (Date.now() < deadline) {
    const service = await getService(serviceId);
    if (!service) return { ok: false, detail: "サービスが見つかりません" };

    if (service.status === "stopped" || service.status === "failed") {
      stableSince = null;
      detail = service.lastError ?? `status=${service.status}`;
    } else if (service.status === "running") {
      if (!service.healthCheck) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= 3000) {
          return { ok: true, detail: "プロセスが 3 秒以上安定しています" };
        }
      } else {
        const health = await checkServiceHealth(serviceId).catch(
          (error: unknown) => ({
            status: "unhealthy" as const,
            detail: error instanceof Error ? error.message : String(error),
          }),
        );
        if (health.status === "healthy") {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= 1000) {
            return { ok: true, detail: health.detail ?? "healthy" };
          }
        } else {
          stableSince = null;
          detail = health.detail ?? `health=${health.status}`;
        }
      }
    } else {
      stableSince = null;
      detail = `status=${service.status}`;
    }
    await sleep(1000);
  }
  return { ok: false, detail };
}

async function failRestart(
  action: ActionRow,
  incident: IncidentRow,
  service: ServiceRow,
  detail: string,
  retry: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .update(actions)
    .set({
      status: "failed",
      finishedAt: now,
      error: detail.slice(0, 2000),
    })
    .where(eq(actions.id, action.id));
  const attempts = incident.restartAttempts + 1;
  const [updatedIncident] = await db
    .update(incidents)
    .set({
      status: "open",
      restartAttempts: attempts,
      summary: `再起動後の復旧確認に失敗しました: ${detail}`.slice(0, 2000),
    })
    .where(eq(incidents.id, incident.id))
    .returning();
  const current = updatedIncident ?? incident;
  await appendIncidentEvent(incident.id, "restart_failed", {
    attempt: attempts,
    detail,
  });
  await writeAudit({
    actorLabel: action.requestedBy ?? "monitor",
    action: "service.restart.failed",
    target: `service:${service.id}`,
    after: { incidentId: incident.id, attempt: attempts, detail },
  }).catch(() => undefined);
  void notifyForIncident(current, "restart_failed", detail).catch(
    () => undefined,
  );

  const crashLoop = isCrashLoop(
    recentExits.get(service.id) ?? [],
    Date.now(),
    config.AUTO_RESTART_WINDOW_SEC * 1000,
  );
  if (retry && !crashLoop && attempts < config.AUTO_RESTART_MAX_ATTEMPTS) {
    const delay = backoffMsForAttempt(attempts, backoffList());
    const timer = setTimeout(() => {
      void (async () => {
        const freshIncident = await db
          .select()
          .from(incidents)
          .where(eq(incidents.id, incident.id))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        const freshService = await getService(service.id);
        if (
          !freshIncident ||
          freshIncident.status === "resolved" ||
          !freshService
        ) {
          return;
        }
        await startRestartAction({
          incident: freshIncident,
          service: freshService,
          requestedBy: "system:auto-retry",
          approvedBy: null,
          reason: `自動再試行 (${attempts + 1}/${config.AUTO_RESTART_MAX_ATTEMPTS})`,
          delayMs: 0,
        });
      })().catch(() => undefined);
    }, delay);
    timer.unref();
  } else if (retry) {
    const reason = crashLoop
      ? "crash loop detected"
      : "max restart attempts reached";
    await db
      .update(incidents)
      .set({ severity: "critical" })
      .where(eq(incidents.id, incident.id));
    await appendIncidentEvent(incident.id, "escalated", { reason, attempts });
    void notifyForIncident(
      current,
      "escalated",
      crashLoop
        ? "クラッシュループを検出したため自動再起動を停止しました"
        : "最大再試行回数に達しました",
    ).catch(() => undefined);
  }
}

async function executeRestart(actionId: string): Promise<void> {
  const [action] = await db
    .select()
    .from(actions)
    .where(eq(actions.id, actionId))
    .limit(1);
  if (!action) return;
  if (action.status === "succeeded" || action.status === "failed") return;
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, action.incidentId ?? ""))
    .limit(1);
  if (!incident) return;
  if (incident.status === "resolved") {
    await db
      .update(actions)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: "インシデントは既に解決されています",
      })
      .where(eq(actions.id, actionId));
    return;
  }
  const service = await getService(action.serviceId);
  if (!service) {
    await db
      .update(actions)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: "サービスが見つかりません",
      })
      .where(eq(actions.id, actionId));
    return;
  }

  await db
    .update(actions)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(actions.id, actionId));

  try {
    await restartService(service.id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await failRestart(
      action,
      incident,
      service,
      detail,
      service.autoRestartPhase === "auto" &&
        Boolean(action.requestedBy?.startsWith("system")),
    );
    return;
  }

  const verification = await verifyRecovery(
    service.id,
    config.AUTO_RESTART_VERIFY_TIMEOUT_SEC,
  );
  if (!verification.ok) {
    await failRestart(
      action,
      incident,
      service,
      verification.detail,
      service.autoRestartPhase === "auto" &&
        Boolean(action.requestedBy?.startsWith("system")),
    );
    return;
  }

  const now = new Date();
  await db
    .update(actions)
    .set({ status: "succeeded", finishedAt: now, error: null })
    .where(eq(actions.id, actionId));
  const [updatedIncident] = await db
    .update(incidents)
    .set({
      status: "resolved",
      resolvedAt: now,
      summary: `再起動後に復旧を確認しました: ${verification.detail}`.slice(
        0,
        2000,
      ),
    })
    .where(eq(incidents.id, incident.id))
    .returning();
  const current = updatedIncident ?? incident;
  await expirePendingApprovals(incident.id);
  await appendIncidentEvent(incident.id, "recovered", {
    detail: verification.detail,
    actionId,
  });
  await resolveOtherIncidents(
    service.id,
    incident.id,
    "サービスが復旧したため自動解決",
  );
  await writeAudit({
    actorLabel: action.requestedBy ?? "monitor",
    action: "service.restart.succeeded",
    target: `service:${service.id}`,
    after: { incidentId: incident.id, actionId },
  }).catch(() => undefined);
  void notifyForIncident(current, "recovered", verification.detail).catch(
    () => undefined,
  );
}

export interface AutomationContext {
  consecutiveFailures?: number;
  failureThreshold?: number;
}

export async function evaluateIncidentAutomation(
  incident: IncidentRow,
  service: ServiceRow,
  context: AutomationContext = {},
): Promise<RestartDecision | null> {
  if (incident.status === "resolved") return null;
  const now = nowMs();
  const windowStart = new Date(now - config.AUTO_RESTART_WINDOW_SEC * 1000);

  const [pendingApproval] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.incidentId, incident.id),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingApproval) return null;

  const recentActions = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.serviceId, service.id),
        eq(actions.type, "restart"),
        gte(actions.startedAt, windowStart),
      ),
    )
    .orderBy(desc(actions.startedAt));
  const latest = recentActions[0];
  if (
    latest &&
    (latest.status === "pending" || latest.status === "running") &&
    isRecent(latest.startedAt, now, 60_000)
  ) {
    return null;
  }

  const attemptsInWindow = recentActions.length;
  const cooldownRemainingSec =
    latest && latest.startedAt
      ? Math.max(
          0,
          Math.ceil(
            (latest.startedAt.getTime() +
              config.AUTO_RESTART_COOLDOWN_SEC * 1000 -
              now) /
              1000,
          ),
        )
      : 0;
  const lastVerifyFailed =
    latest?.status === "failed" &&
    isRecent(latest.startedAt, now, config.AUTO_RESTART_WINDOW_SEC * 1000);
  const crashLoop = isCrashLoop(
    recentExits.get(service.id) ?? [],
    now,
    config.AUTO_RESTART_WINDOW_SEC * 1000,
  );

  const decision = evaluateRestart({
    phase: service.autoRestartPhase,
    enabled: service.autoRestartPhase !== "observe",
    healthy: false,
    consecutiveFailures: context.consecutiveFailures ?? 1,
    failureThreshold: context.failureThreshold ?? 1,
    crashLoop,
    portConflict: false,
    resourceExhausted: false,
    attemptsInWindow,
    maxAttempts: config.AUTO_RESTART_MAX_ATTEMPTS,
    cooldownRemainingSec,
    lastVerifyFailed,
  });

  if (decision.action === "request_approval") {
    await createApproval(incident.id, decision.reason);
  } else if (decision.action === "restart") {
    if (!scheduledRestarts.has(incident.id)) {
      scheduledRestarts.add(incident.id);
      const delayMs = backoffMsForAttempt(attemptsInWindow, backoffList());
      try {
        await startRestartAction({
          incident,
          service,
          requestedBy: "system:auto",
          approvedBy: null,
          reason: decision.reason,
          delayMs,
        });
      } finally {
        scheduledRestarts.delete(incident.id);
      }
    }
  } else if (decision.action === "escalate") {
    await db
      .update(incidents)
      .set({ severity: "critical" })
      .where(eq(incidents.id, incident.id));
    await appendIncidentEvent(incident.id, "escalated", {
      reason: decision.reason,
    });
    void notifyForIncident(incident, "escalated", decision.reason).catch(
      () => undefined,
    );
  }
  return decision;
}
