import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { writeAudit } from "../audit.js";
import { db } from "../db/index.js";
import {
  actions,
  approvals,
  incidentActionProposals,
  incidents,
} from "../db/schema.js";
import { appendIncidentEvent } from "./incident-lifecycle.js";

type ActionRow = typeof actions.$inferSelect;
type ActionProposalRow = typeof incidentActionProposals.$inferSelect;

const STALE_ACTION_ERROR =
  "API が再起動したため、実行中のアクション結果を確認できませんでした";

async function markActionFailed(action: ActionRow): Promise<ActionRow | null> {
  const [updated] = await db
    .update(actions)
    .set({
      status: "failed",
      finishedAt: new Date(),
      error: STALE_ACTION_ERROR,
    })
    .where(
      and(
        eq(actions.id, action.id),
        inArray(actions.status, ["pending", "running"]),
      ),
    )
    .returning();
  return updated ?? null;
}

async function getPendingApprovalCount(incidentId: string): Promise<number> {
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    )
    .limit(5);
  return rows.length;
}

async function openIncidentIfNoPendingApproval(
  incidentId: string,
): Promise<void> {
  if ((await getPendingApprovalCount(incidentId)) > 0) return;
  await db
    .update(incidents)
    .set({ status: "open" })
    .where(and(eq(incidents.id, incidentId), eq(incidents.status, "approval")));
}

async function failProposalForStaleAction(
  proposal: ActionProposalRow,
  actionId: string | null,
): Promise<void> {
  const now = new Date();
  const [updatedProposal] = await db
    .update(incidentActionProposals)
    .set({
      status: "failed",
      executedAt: now,
      error: STALE_ACTION_ERROR,
    })
    .where(
      and(
        eq(incidentActionProposals.id, proposal.id),
        inArray(incidentActionProposals.status, ["approved", "executing"]),
      ),
    )
    .returning();
  if (!updatedProposal) return;

  await appendIncidentEvent(proposal.incidentId, "ai_action_stale", {
    proposalId: proposal.id,
    actionId,
    actionType: proposal.actionType,
    detail: STALE_ACTION_ERROR,
  });
  await openIncidentIfNoPendingApproval(proposal.incidentId);
  await writeAudit({
    actorLabel: "system:ai",
    action: "ai.action.stale",
    target: `proposal:${proposal.id}`,
    after: {
      incidentId: proposal.incidentId,
      serviceId: proposal.serviceId,
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      actionId,
      actionType: proposal.actionType,
      risk: proposal.risk,
      detail: STALE_ACTION_ERROR,
    },
  }).catch(() => undefined);
}

async function reconcileActions(): Promise<void> {
  const rows = await db
    .select()
    .from(actions)
    .where(
      and(
        inArray(actions.status, ["pending", "running"]),
        ne(actions.type, "deploy"),
      ),
    );

  for (const action of rows) {
    const updatedAction = await markActionFailed(action);
    if (!updatedAction) continue;

    const [proposal] = action.proposalId
      ? await db
          .select()
          .from(incidentActionProposals)
          .where(eq(incidentActionProposals.id, action.proposalId))
          .limit(1)
      : [];

    if (proposal) {
      await failProposalForStaleAction(proposal, action.id);
      continue;
    }

    if (action.incidentId) {
      await appendIncidentEvent(action.incidentId, "action_stale", {
        actionId: action.id,
        actionType: action.type,
        detail: STALE_ACTION_ERROR,
      });
      await openIncidentIfNoPendingApproval(action.incidentId);
    }

    await writeAudit({
      actorLabel: action.requestedBy ?? "system:ai",
      action: "action.stale",
      target: `action:${action.id}`,
      after: {
        incidentId: action.incidentId,
        serviceId: action.serviceId,
        actionId: action.id,
        actionType: action.type,
        detail: STALE_ACTION_ERROR,
      },
    }).catch(() => undefined);
  }
}

async function reconcileProposalsWithoutActiveAction(): Promise<void> {
  const proposals = await db
    .select()
    .from(incidentActionProposals)
    .where(inArray(incidentActionProposals.status, ["approved", "executing"]));

  for (const proposal of proposals) {
    if (proposal.actionId) {
      const [action] = await db
        .select()
        .from(actions)
        .where(eq(actions.id, proposal.actionId))
        .limit(1);
      if (action && ["pending", "running"].includes(action.status)) continue;
    }
    await failProposalForStaleAction(proposal, proposal.actionId);
  }
}

export async function reconcileInterruptedActions(): Promise<void> {
  await reconcileActions();
  await reconcileProposalsWithoutActiveAction();
}
