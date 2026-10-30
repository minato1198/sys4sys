import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import type { AnalysisResult } from "@sys4sys/ai";
import type { Role } from "@sys4sys/shared";
import { writeAudit } from "../audit.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  approvals,
  hosts,
  incidentActionProposals,
  incidentEvents,
  incidents,
  services,
} from "../db/schema.js";
import { notifyApprovalRequest } from "./notify.js";

type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type ActionProposalRow = typeof incidentActionProposals.$inferSelect;
type ActionProposalType = ActionProposalRow["actionType"];

const ACTIVE_PROPOSAL_STATUSES = [
  "proposed",
  "pending_approval",
  "approved",
  "executing",
  "succeeded",
] as const;

export class ActionProposalError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ActionProposalError";
  }
}

function normalizeType(value: string): ActionProposalType | null {
  const type = value.trim().toLowerCase();
  if (type === "restart" || type === "start" || type === "stop") {
    return type;
  }
  if (type === "deploy") return "deploy";
  return null;
}

function configuredTypes(): Set<ActionProposalType> {
  const configured = new Set<ActionProposalType>();
  for (const raw of config.AI_ACTION_ALLOWED_TYPES.split(",")) {
    const type = normalizeType(raw);
    if (!type) continue;
    configured.add(type);
  }
  return configured;
}

/**
 * Phase 1 で実際に実行承認を出せる種別。
 * deploy は表示・保存だけ可能で、実行承認の対象にはしない。
 */
export function allowedProposalActionTypes(): Set<ActionProposalType> {
  if (!config.AI_ACTION_EXECUTION_ENABLED) return new Set();
  const allowed = new Set<ActionProposalType>();
  const configured = configuredTypes();
  if (configured.has("restart")) allowed.add("restart");
  if (configured.has("start")) allowed.add("start");
  if (config.AI_ACTION_STOP_ENABLED && configured.has("stop")) {
    allowed.add("stop");
  }
  return allowed;
}

export function isProposalActionAllowed(type: string): boolean {
  const normalized = normalizeType(type);
  return normalized !== null && allowedProposalActionTypes().has(normalized);
}

function targetMatchesService(
  target: string | undefined,
  service: ServiceRow,
): boolean {
  const value = target?.trim().toLowerCase();
  if (!value) return true;
  return (
    value === service.name.toLowerCase() || value === service.id.toLowerCase()
  );
}

function normalizeRationale(
  value: string | undefined,
  fallback: string,
): string {
  return (value?.trim() || fallback).replace(/\s+/g, " ").slice(0, 2000);
}

function dedupeKey(
  incidentId: string,
  actionType: ActionProposalType,
  serviceId: string,
  rationale: string,
): string {
  return createHash("sha256")
    .update(
      [incidentId, actionType, serviceId, rationale.toLowerCase()].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

function serviceSnapshot(service: ServiceRow, incident: IncidentRow) {
  return {
    serviceName: service.name,
    serviceStatus: service.status,
    servicePid: service.pid,
    controlMode: service.controlMode,
    lastStartedAt: service.lastStartedAt?.toISOString() ?? null,
    lastExitedAt: service.lastExitedAt?.toISOString() ?? null,
    incidentStatus: incident.status,
  };
}

function snapshotMatches(
  snapshot: Record<string, unknown>,
  service: ServiceRow,
): boolean {
  return (
    snapshot.serviceStatus === service.status &&
    snapshot.serviceName === service.name
  );
}

async function getIncident(incidentId: string): Promise<IncidentRow | null> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  return row ?? null;
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

async function pendingApprovalForIncident(
  incidentId: string,
): Promise<ApprovalRow | null> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(desc(approvals.requestedAt))
    .limit(1);
  return row ?? null;
}

export interface MaterializeActionProposalsInput {
  incident: IncidentRow;
  service: ServiceRow | null;
  analysis: {
    id: string;
    provider: string;
    model: string;
    promptVersion: string;
    confidence: number;
  };
  result: AnalysisResult;
  analysisRequestedBy: string | null;
}

export async function materializeActionProposals(
  input: MaterializeActionProposalsInput,
): Promise<ActionProposalRow[]> {
  if (!config.AI_ACTION_EXECUTION_ENABLED) return [];
  if (!input.service) return [];
  if (input.incident.status === "resolved") return [];
  if (
    input.analysis.provider === "template" ||
    input.analysis.model === "rules-v1"
  ) {
    return [];
  }
  if (input.result.confidence < config.AI_ACTION_MIN_CONFIDENCE) return [];

  const allowedTypes = allowedProposalActionTypes();
  if (allowedTypes.size === 0) return [];

  const existing = await db
    .select({ dedupeKey: incidentActionProposals.dedupeKey })
    .from(incidentActionProposals)
    .where(
      and(
        eq(incidentActionProposals.incidentId, input.incident.id),
        inArray(incidentActionProposals.status, [...ACTIVE_PROPOSAL_STATUSES]),
      ),
    );
  const seen = new Set(existing.map((row) => row.dedupeKey));
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + config.AI_ACTION_TTL_MIN * 60 * 1000,
  );
  const snapshot = serviceSnapshot(input.service, input.incident);
  const created: ActionProposalRow[] = [];

  for (const action of input.result.recommended_actions) {
    if (created.length >= config.AI_ACTION_MAX_PROPOSALS) break;
    const actionType = normalizeType(action.type);
    if (!actionType || !allowedTypes.has(actionType)) continue;
    if (!targetMatchesService(action.target, input.service)) continue;

    const rationale = normalizeRationale(
      action.detail,
      `${actionType} suggested by AI for ${input.service.name}`,
    );
    const key = dedupeKey(
      input.incident.id,
      actionType,
      input.service.id,
      rationale,
    );
    if (seen.has(key)) continue;
    seen.add(key);

    const [row] = await db
      .insert(incidentActionProposals)
      .values({
        id: randomUUID(),
        incidentId: input.incident.id,
        analysisId: input.analysis.id,
        serviceId: input.service.id,
        actionType,
        status: "proposed",
        risk: action.risk === "none" ? "low" : action.risk,
        confidence: input.result.confidence,
        rationale,
        parameters: null,
        snapshot,
        dedupeKey: key,
        sortOrder: created.length,
        analysisRequestedBy: input.analysisRequestedBy,
        approvalId: null,
        actionId: null,
        createdAt: now,
        expiresAt,
        decidedAt: null,
        executedAt: null,
        error: null,
      })
      .returning();
    if (row) created.push(row);
  }

  if (created.length === 0) return [];

  await db.insert(incidentEvents).values({
    id: randomUUID(),
    incidentId: input.incident.id,
    ts: new Date(),
    type: "ai_action_proposed",
    payload: {
      analysisId: input.analysis.id,
      proposalIds: created.map((row) => row.id),
      actions: created.map((row) => ({
        id: row.id,
        actionType: row.actionType,
        risk: row.risk,
      })),
    },
  });
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.proposed",
    target: `incident:${input.incident.id}`,
    after: {
      analysisId: input.analysis.id,
      incidentId: input.incident.id,
      serviceId: input.service.id,
      provider: input.analysis.provider,
      model: input.analysis.model,
      promptVersion: input.analysis.promptVersion,
      proposals: created.map((row) => ({
        proposalId: row.id,
        actionType: row.actionType,
        risk: row.risk,
        confidence: row.confidence,
      })),
    },
  }).catch(() => undefined);

  if (config.AI_ACTION_AUTO_REQUEST_APPROVAL) {
    await autoRequestPrimaryProposalApproval(input.incident.id);
  }
  return created;
}

function selectionRank(
  proposal: ActionProposalRow,
  serviceStatus: ServiceRow["status"],
): [number, number, number, number] {
  const preferStart = serviceStatus === "stopped" || serviceStatus === "failed";
  const typeRank =
    proposal.actionType === (preferStart ? "start" : "restart")
      ? 0
      : proposal.actionType === (preferStart ? "restart" : "start")
        ? 1
        : 2;
  const riskRank =
    proposal.risk === "low" ? 0 : proposal.risk === "medium" ? 1 : 2;
  return [typeRank, riskRank, -proposal.confidence, proposal.sortOrder];
}

export async function autoRequestPrimaryProposalApproval(
  incidentId: string,
): Promise<ApprovalRow | null> {
  if (
    !config.AI_ACTION_EXECUTION_ENABLED ||
    !config.AI_ACTION_AUTO_REQUEST_APPROVAL
  ) {
    return null;
  }
  const incident = await getIncident(incidentId);
  if (!incident || incident.status === "resolved") return null;
  const service = await getService(incident.serviceId);
  if (!service) return null;
  if (await pendingApprovalForIncident(incidentId)) return null;

  const proposals = await db
    .select()
    .from(incidentActionProposals)
    .where(
      and(
        eq(incidentActionProposals.incidentId, incidentId),
        eq(incidentActionProposals.status, "proposed"),
        gt(incidentActionProposals.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(incidentActionProposals.sortOrder));
  if (proposals.length === 0) return null;
  const primary = [...proposals].sort((a, b) => {
    const left = selectionRank(a, service.status);
    const right = selectionRank(b, service.status);
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index]! - right[index]!;
    }
    return 0;
  })[0];
  if (!primary) return null;

  return claimProposalApproval({
    proposal: primary,
    incident,
    service,
    requestedBy: primary.analysisRequestedBy,
    actorLabel: "system:ai",
    note: null,
  });
}

interface ClaimApprovalInput {
  proposal: ActionProposalRow;
  incident: IncidentRow;
  service: ServiceRow;
  requestedBy: string | null;
  actorLabel: string;
  actorUserId?: string | null;
  note: string | null;
}

async function claimProposalApproval(
  input: ClaimApprovalInput,
): Promise<ApprovalRow> {
  const existing = await pendingApprovalForIncident(input.incident.id);
  if (existing) {
    throw new ActionProposalError(
      409,
      "同一インシデントに承認待ちのリクエストがあります",
      { approvalId: existing.id },
    );
  }

  const approvalId = randomUUID();
  const [approval] = await db
    .insert(approvals)
    .values({
      id: approvalId,
      incidentId: input.incident.id,
      proposalId: input.proposal.id,
      source: "ai",
      requestedAction: {
        type: input.proposal.actionType,
        serviceId: input.service.id,
        proposalId: input.proposal.id,
        reason: input.proposal.rationale ?? "",
        risk: input.proposal.risk,
      },
      requestedBy: input.requestedBy,
      status: "pending",
      requestedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      note: input.note,
      expiresAt: input.proposal.expiresAt,
    })
    .returning();
  if (!approval) {
    throw new ActionProposalError(500, "承認リクエストを作成できませんでした");
  }

  const [updatedProposal] = await db
    .update(incidentActionProposals)
    .set({ status: "pending_approval", approvalId })
    .where(
      and(
        eq(incidentActionProposals.id, input.proposal.id),
        eq(incidentActionProposals.status, "proposed"),
      ),
    )
    .returning();
  if (!updatedProposal) {
    await db.delete(approvals).where(eq(approvals.id, approvalId));
    throw new ActionProposalError(409, "この提案は既に処理されています");
  }

  await db
    .update(incidents)
    .set({ status: "approval" })
    .where(
      and(
        eq(incidents.id, input.incident.id),
        inArray(incidents.status, ["open", "acked"]),
      ),
    );
  await db.insert(incidentEvents).values({
    id: randomUUID(),
    incidentId: input.incident.id,
    ts: new Date(),
    type: "approval_requested",
    payload: {
      approvalId,
      proposalId: input.proposal.id,
      actionType: input.proposal.actionType,
      risk: input.proposal.risk,
      source: "ai",
      expiresAt: input.proposal.expiresAt.toISOString(),
    },
  });
  await writeAudit({
    actorUserId: input.actorUserId ?? null,
    actorLabel: input.actorLabel,
    action: "approval.request",
    target: `incident:${input.incident.id}`,
    after: {
      approvalId,
      proposalId: input.proposal.id,
      serviceId: input.service.id,
      actionType: input.proposal.actionType,
      risk: input.proposal.risk,
      source: "ai",
      expiresAt: input.proposal.expiresAt.toISOString(),
    },
    reason: input.note,
  }).catch(() => undefined);

  const host = await getHost(input.service.hostId);
  void notifyApprovalRequest(
    approval,
    input.incident,
    input.service,
    host,
  ).catch(() => undefined);
  return approval;
}

export async function requestProposalApproval(
  proposalId: string,
  actor: { id: string; email: string; role: Role },
  note?: string,
): Promise<{ proposal: ActionProposalRow; approval: ApprovalRow }> {
  const [proposal] = await db
    .select()
    .from(incidentActionProposals)
    .where(eq(incidentActionProposals.id, proposalId))
    .limit(1);
  if (!proposal) {
    throw new ActionProposalError(404, "提案が見つかりません");
  }
  if (proposal.expiresAt.getTime() <= Date.now()) {
    await expireProposal(proposal, "提案の有効期限が切れています");
    throw new ActionProposalError(409, "提案の有効期限が切れています");
  }
  if (proposal.status !== "proposed") {
    throw new ActionProposalError(409, "この提案は既に処理されています");
  }
  if (!isProposalActionAllowed(proposal.actionType)) {
    throw new ActionProposalError(422, "このアクションは現在実行できません");
  }
  if (proposal.actionType === "stop" && actor.role !== "admin") {
    throw new ActionProposalError(403, "stop の承認依頼は admin のみ可能です");
  }
  const incident = await getIncident(proposal.incidentId);
  if (!incident) {
    throw new ActionProposalError(404, "インシデントが見つかりません");
  }
  if (incident.status === "resolved") {
    throw new ActionProposalError(409, "解決済みのインシデントです");
  }
  const service = await getService(proposal.serviceId);
  if (!service || service.id !== incident.serviceId) {
    throw new ActionProposalError(404, "サービスが見つかりません");
  }
  if (!snapshotMatches(proposal.snapshot, service)) {
    await expireProposal(proposal, "提案時のサービス状態から変化しています");
    throw new ActionProposalError(
      409,
      "提案時のサービス状態から変化しています。再分析してください",
    );
  }

  const approval = await claimProposalApproval({
    proposal,
    incident,
    service,
    requestedBy: actor.id,
    actorLabel: actor.email,
    actorUserId: actor.id,
    note: note ?? null,
  });
  const [updated] = await db
    .select()
    .from(incidentActionProposals)
    .where(eq(incidentActionProposals.id, proposal.id))
    .limit(1);
  return { proposal: updated ?? proposal, approval };
}

export async function expireProposal(
  proposal: ActionProposalRow,
  reason: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(incidentActionProposals)
    .set({
      status: "expired",
      decidedAt: now,
      error: reason.slice(0, 2000),
    })
    .where(
      and(
        eq(incidentActionProposals.id, proposal.id),
        inArray(incidentActionProposals.status, [
          "proposed",
          "pending_approval",
        ]),
      ),
    );
  if (proposal.approvalId) {
    await db
      .update(approvals)
      .set({ status: "expired", decidedAt: now, note: reason.slice(0, 500) })
      .where(
        and(
          eq(approvals.id, proposal.approvalId),
          eq(approvals.status, "pending"),
        ),
      );
  }
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.expired",
    target: `proposal:${proposal.id}`,
    after: {
      incidentId: proposal.incidentId,
      serviceId: proposal.serviceId,
      actionType: proposal.actionType,
      reason,
    },
  }).catch(() => undefined);
}

export async function expireProposalsForIncident(
  incidentId: string,
): Promise<void> {
  const now = new Date();
  const expired = await db
    .update(incidentActionProposals)
    .set({
      status: "expired",
      decidedAt: now,
      error: "承認待ちの有効期限が切れました",
    })
    .where(
      and(
        eq(incidentActionProposals.incidentId, incidentId),
        inArray(incidentActionProposals.status, [
          "proposed",
          "pending_approval",
        ]),
        lt(incidentActionProposals.expiresAt, now),
      ),
    )
    .returning({ id: incidentActionProposals.id });
  const expiredApprovals = await db
    .update(approvals)
    .set({
      status: "expired",
      decidedAt: now,
      note: "承認待ちの有効期限が切れました",
    })
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
        lt(approvals.expiresAt, now),
      ),
    )
    .returning({ id: approvals.id });
  if (expired.length === 0 && expiredApprovals.length === 0) return;
  const [pending] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(1);
  if (!pending) {
    await db
      .update(incidents)
      .set({ status: "open" })
      .where(
        and(eq(incidents.id, incidentId), eq(incidents.status, "approval")),
      );
  }
  await db.insert(incidentEvents).values({
    id: randomUUID(),
    incidentId,
    ts: now,
    type: "ai_action_expired",
    payload: {
      proposalIds: expired.map((row) => row.id),
      approvalIds: expiredApprovals.map((row) => row.id),
    },
  });
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.expired",
    target: `incident:${incidentId}`,
    after: {
      proposalIds: expired.map((row) => row.id),
      approvalIds: expiredApprovals.map((row) => row.id),
    },
  }).catch(() => undefined);
}

export async function supersedeOtherProposals(
  incidentId: string,
  keepProposalId: string,
): Promise<void> {
  const rows = await db
    .update(incidentActionProposals)
    .set({
      status: "superseded",
      decidedAt: new Date(),
      error: "別の提案が実行されました",
    })
    .where(
      and(
        eq(incidentActionProposals.incidentId, incidentId),
        inArray(incidentActionProposals.status, [
          "proposed",
          "pending_approval",
        ]),
        ne(incidentActionProposals.id, keepProposalId),
      ),
    )
    .returning({ id: incidentActionProposals.id });
  if (rows.length === 0) return;
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.superseded",
    target: `incident:${incidentId}`,
    after: {
      keepProposalId,
      proposalIds: rows.map((row) => row.id),
    },
  }).catch(() => undefined);
}

export async function getProposalsForIncident(
  incidentId: string,
): Promise<ActionProposalRow[]> {
  return db
    .select()
    .from(incidentActionProposals)
    .where(eq(incidentActionProposals.incidentId, incidentId))
    .orderBy(asc(incidentActionProposals.sortOrder));
}
