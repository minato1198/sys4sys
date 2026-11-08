import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  actions,
  incidentActionProposals,
  incidents,
  services,
} from "../db/schema.js";
import { hasRunningDeploy } from "../services/deploy-lock.js";
import {
  checkServiceHealth,
  restartService,
  startService,
  stopService,
} from "../services/manager.js";
import {
  isProposalActionAllowed,
  supersedeOtherProposals,
} from "./action-proposals.js";
import {
  appendIncidentEvent,
  expirePendingApprovals,
  getIncident,
  getService,
  notifyForIncident,
  resolveOtherIncidents,
} from "./incident-lifecycle.js";

type ActionRow = typeof actions.$inferSelect;
type ActionProposalRow = typeof incidentActionProposals.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;

export interface StartProposalInput {
  incident: IncidentRow;
  service: ServiceRow;
  proposal: ActionProposalRow;
  approvedBy: string;
}

export function proposalSnapshotMatches(
  snapshot: Record<string, unknown>,
  service: typeof services.$inferSelect,
): boolean {
  return (
    snapshot.serviceStatus === service.status &&
    snapshot.serviceName === service.name
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function verifyRecovery(
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

async function succeedProposalExecution(
  action: ActionRow,
  proposal: ActionProposalRow,
  incident: IncidentRow,
  service: ServiceRow,
  detail: string,
  resolveIncident: boolean,
): Promise<void> {
  const now = new Date();
  await db
    .update(actions)
    .set({ status: "succeeded", finishedAt: now, error: null })
    .where(eq(actions.id, action.id));
  await db
    .update(incidentActionProposals)
    .set({
      status: "succeeded",
      executedAt: now,
      error: null,
    })
    .where(eq(incidentActionProposals.id, proposal.id));

  let current = incident;
  if (resolveIncident) {
    const [updatedIncident] = await db
      .update(incidents)
      .set({
        status: "resolved",
        resolvedAt: now,
        summary:
          `${proposal.actionType} 後に復旧を確認しました: ${detail}`.slice(
            0,
            2000,
          ),
      })
      .where(eq(incidents.id, incident.id))
      .returning();
    current = updatedIncident ?? incident;
    await supersedeOtherProposals(incident.id, proposal.id);
    await expirePendingApprovals(incident.id);
    await resolveOtherIncidents(
      service.id,
      incident.id,
      "AI 承認アクションでサービスが復旧したため自動解決",
    );
  } else {
    const [updatedIncident] = await db
      .update(incidents)
      .set({
        status: "open",
        summary: `${proposal.actionType} を実行しました: ${detail}`.slice(
          0,
          2000,
        ),
      })
      .where(
        and(eq(incidents.id, incident.id), ne(incidents.status, "resolved")),
      )
      .returning();
    current = updatedIncident ?? incident;
    await supersedeOtherProposals(incident.id, proposal.id);
    await expirePendingApprovals(incident.id);
  }

  await appendIncidentEvent(incident.id, "ai_action_succeeded", {
    actionId: action.id,
    proposalId: proposal.id,
    actionType: proposal.actionType,
    resolved: resolveIncident,
    detail,
  });
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.succeeded",
    target: `service:${service.id}`,
    after: {
      incidentId: incident.id,
      serviceId: service.id,
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      actionId: action.id,
      actionType: proposal.actionType,
      risk: proposal.risk,
      confidence: proposal.confidence,
      resolved: resolveIncident,
      detail,
    },
  }).catch(() => undefined);
  void notifyForIncident(current, "ai_action_succeeded", detail).catch(
    () => undefined,
  );
}

async function failProposalExecution(
  action: ActionRow,
  proposal: ActionProposalRow,
  incident: IncidentRow | null,
  service: ServiceRow | null,
  detail: string,
  options: {
    proposalStatus?: "failed" | "expired";
    auditAction?: "ai.action.failed" | "ai.action.stale";
    eventType?: "ai_action_failed" | "ai_action_stale";
  } = {},
): Promise<void> {
  const now = new Date();
  const message = detail.slice(0, 2000);
  const proposalStatus = options.proposalStatus ?? "failed";
  const auditAction = options.auditAction ?? "ai.action.failed";
  const eventType = options.eventType ?? "ai_action_failed";
  await db
    .update(actions)
    .set({ status: "failed", finishedAt: now, error: message })
    .where(eq(actions.id, action.id));
  await db
    .update(incidentActionProposals)
    .set({
      status: proposalStatus,
      executedAt: now,
      error: message,
    })
    .where(
      and(
        eq(incidentActionProposals.id, proposal.id),
        inArray(incidentActionProposals.status, ["approved", "executing"]),
      ),
    );

  let current = incident;
  if (incident) {
    const attempts =
      action.type === "restart"
        ? incident.restartAttempts + 1
        : incident.restartAttempts;
    const [updatedIncident] = await db
      .update(incidents)
      .set({
        status: "open",
        restartAttempts: attempts,
        summary: `AI 承認アクションに失敗しました: ${message}`.slice(0, 2000),
      })
      .where(eq(incidents.id, incident.id))
      .returning();
    current = updatedIncident ?? incident;
    await appendIncidentEvent(incident.id, eventType, {
      actionId: action.id,
      proposalId: proposal.id,
      actionType: proposal.actionType,
      detail: message,
    });
  }

  await writeAudit({
    actorLabel: "system:ai",
    action: auditAction,
    target: service ? `service:${service.id}` : `proposal:${proposal.id}`,
    after: {
      incidentId: incident?.id ?? proposal.incidentId,
      serviceId: service?.id ?? proposal.serviceId,
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      actionId: action.id,
      actionType: proposal.actionType,
      risk: proposal.risk,
      detail: message,
    },
  }).catch(() => undefined);
  if (current) {
    void notifyForIncident(current, "ai_action_failed", message).catch(
      () => undefined,
    );
  }
}

async function executeProposalAction(actionId: string): Promise<void> {
  const [action] = await db
    .select()
    .from(actions)
    .where(eq(actions.id, actionId))
    .limit(1);
  if (!action) return;
  if (action.status === "succeeded" || action.status === "failed") return;

  const [proposal] = action.proposalId
    ? await db
        .select()
        .from(incidentActionProposals)
        .where(eq(incidentActionProposals.id, action.proposalId))
        .limit(1)
    : [];
  if (!proposal) {
    await db
      .update(actions)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: "提案が見つかりません",
      })
      .where(eq(actions.id, actionId));
    return;
  }

  const incident = await getIncident(action.incidentId ?? "");
  if (!incident) {
    await failProposalExecution(
      action,
      proposal,
      null,
      null,
      "インシデントが見つかりません",
    );
    return;
  }
  if (incident.status === "resolved") {
    await failProposalExecution(
      action,
      proposal,
      incident,
      null,
      "インシデントは既に解決されています",
    );
    return;
  }
  const service = await getService(action.serviceId);
  if (!service) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      null,
      "サービスが見つかりません",
    );
    return;
  }
  if (service.id !== proposal.serviceId) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      "提案とサービスの対象が一致しません",
      {
        proposalStatus: "expired",
        auditAction: "ai.action.stale",
        eventType: "ai_action_stale",
      },
    );
    return;
  }
  if (!isProposalActionAllowed(proposal.actionType)) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      "このアクションは現在実行できません",
    );
    return;
  }
  if (await hasRunningDeploy(service.id)) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      "デプロイ中のため実行できません",
    );
    return;
  }
  if (!proposalSnapshotMatches(proposal.snapshot, service)) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      "提案時のサービス状態から変化しています。再分析してください",
      {
        proposalStatus: "expired",
        auditAction: "ai.action.stale",
        eventType: "ai_action_stale",
      },
    );
    return;
  }
  if (proposal.status !== "approved") {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      "提案が実行可能な状態ではありません",
    );
    return;
  }

  const [claimed] = await db
    .update(incidentActionProposals)
    .set({ status: "executing" })
    .where(
      and(
        eq(incidentActionProposals.id, proposal.id),
        eq(incidentActionProposals.status, "approved"),
      ),
    )
    .returning();
  if (!claimed) {
    await db
      .update(actions)
      .set({
        status: "failed",
        finishedAt: new Date(),
        error: "提案は既に実行中または処理済みです",
      })
      .where(eq(actions.id, actionId));
    return;
  }

  await db
    .update(actions)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(actions.id, actionId));
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.started",
    target: `service:${service.id}`,
    after: {
      incidentId: incident.id,
      serviceId: service.id,
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      actionId: action.id,
      actionType: proposal.actionType,
      risk: proposal.risk,
    },
  }).catch(() => undefined);

  try {
    if (proposal.actionType === "restart") {
      await restartService(service.id);
    } else if (proposal.actionType === "start") {
      await startService(service.id);
    } else if (proposal.actionType === "stop") {
      await stopService(service.id);
      await succeedProposalExecution(
        action,
        proposal,
        incident,
        service,
        "サービスを停止しました",
        false,
      );
      return;
    } else {
      await failProposalExecution(
        action,
        proposal,
        incident,
        service,
        "deploy は Phase 2 以降でのみ実行できます",
      );
      return;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await failProposalExecution(action, proposal, incident, service, detail);
    return;
  }

  const verification = await verifyRecovery(
    service.id,
    config.AUTO_RESTART_VERIFY_TIMEOUT_SEC,
  );
  if (!verification.ok) {
    await failProposalExecution(
      action,
      proposal,
      incident,
      service,
      verification.detail,
    );
    return;
  }
  await succeedProposalExecution(
    action,
    proposal,
    incident,
    service,
    verification.detail,
    true,
  );
}

export async function startProposalAction(
  input: StartProposalInput,
): Promise<ActionRow> {
  const [created] = await db
    .insert(actions)
    .values({
      id: randomUUID(),
      incidentId: input.incident.id,
      serviceId: input.service.id,
      type: input.proposal.actionType,
      status: "pending",
      requestedBy: "system:ai",
      approvedBy: input.approvedBy,
      policyId: null,
      proposalId: input.proposal.id,
      approvalId: input.proposal.approvalId,
      source: "ai_approved",
      startedAt: new Date(),
      finishedAt: null,
      error: null,
    })
    .returning();
  if (!created) {
    throw new Error("AI アクションを作成できませんでした");
  }
  await db
    .update(incidentActionProposals)
    .set({ actionId: created.id })
    .where(eq(incidentActionProposals.id, input.proposal.id));
  void executeProposalAction(created.id).catch((error: unknown) => {
    console.warn(
      `[monitor] proposal action failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  return created;
}
