import type { FastifyInstance, FastifyReply } from "fastify";
import {
  actionProposalQuerySchema,
  actionProposalRequestApprovalSchema,
} from "@sys4sys/shared";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { approvals, incidentActionProposals } from "../db/schema.js";
import {
  ActionProposalError,
  requestProposalApproval,
} from "../monitoring/action-proposals.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type ActionProposalRow = typeof incidentActionProposals.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function proposalResponse(row: ActionProposalRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    analysisId: row.analysisId,
    serviceId: row.serviceId,
    actionType: row.actionType,
    status: row.status,
    risk: row.risk,
    confidence: row.confidence,
    rationale: row.rationale,
    parameters: row.parameters,
    snapshot: row.snapshot,
    analysisRequestedBy: row.analysisRequestedBy,
    approvalId: row.approvalId,
    actionId: row.actionId,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    decidedAt: iso(row.decidedAt),
    executedAt: iso(row.executedAt),
    error: row.error,
  };
}

function approvalResponse(row: ApprovalRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    proposalId: row.proposalId,
    source: row.source,
    requestedAction: row.requestedAction,
    requestedBy: row.requestedBy,
    status: row.status,
    requestedAt: iso(row.requestedAt),
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    note: row.note,
    expiresAt: iso(row.expiresAt),
  };
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  extra?: Record<string, unknown>,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title,
      status,
      detail,
      ...extra,
    });
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ActionProposalError) {
    const title =
      error.statusCode === 404
        ? "Not Found"
        : error.statusCode === 409
          ? "Conflict"
          : error.statusCode === 403
            ? "Forbidden"
            : error.statusCode === 422
              ? "Unprocessable Entity"
              : "Error";
    return problem(
      reply,
      error.statusCode,
      title,
      error.message,
      error.details,
    );
  }
  throw error;
}

export async function actionProposalRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/action-proposals",
    { preHandler: requireAuth, config: { scopes: ["approvals:read"] } },
    async (request) => {
      const query = actionProposalQuerySchema.parse(request.query);
      const rows = await db
        .select()
        .from(incidentActionProposals)
        .where(
          and(
            query.incidentId
              ? eq(incidentActionProposals.incidentId, query.incidentId)
              : undefined,
            query.status
              ? eq(incidentActionProposals.status, query.status)
              : undefined,
          ),
        )
        .orderBy(asc(incidentActionProposals.createdAt))
        .limit(query.limit);
      return { items: rows.map(proposalResponse), total: rows.length };
    },
  );

  app.post(
    "/action-proposals/:id/request-approval",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["approvals:request"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = actionProposalRequestApprovalSchema.parse(
        request.body ?? {},
      );
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        const result = await requestProposalApproval(id, user, body.note);
        return reply.code(201).send({
          proposal: proposalResponse(result.proposal),
          approval: approvalResponse(result.approval),
        });
      } catch (error) {
        return handleError(reply, error);
      }
    },
  );
}
