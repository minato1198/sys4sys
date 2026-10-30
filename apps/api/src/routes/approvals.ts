import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { approvalDecisionSchema, approvalQuerySchema } from "@sys4sys/shared";
import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import {
  approvals,
  hosts,
  incidentActionProposals,
  incidents,
  services,
} from "../db/schema.js";
import {
  decideApproval,
  IncidentError,
  type ApprovalDecisionResult,
} from "../monitoring/incidents.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type ApprovalRow = typeof approvals.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;
type ActionProposalRow = typeof incidentActionProposals.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function approvalResponse(
  row: ApprovalRow,
  incident: IncidentRow | null,
  service: ServiceRow | null,
  host: HostRow | null,
  proposal: ActionProposalRow | null = null,
) {
  const executionStatus =
    proposal &&
    ["approved", "executing", "succeeded", "failed"].includes(proposal.status)
      ? proposal.status
      : null;
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
    executionStatus,
    proposal: proposal
      ? {
          id: proposal.id,
          actionType: proposal.actionType,
          risk: proposal.risk,
          confidence: proposal.confidence,
          rationale: proposal.rationale,
          status: proposal.status,
          actionId: proposal.actionId,
          expiresAt: iso(proposal.expiresAt),
          error: proposal.error,
        }
      : null,
    incident: incident
      ? {
          id: incident.id,
          serviceId: incident.serviceId,
          title: incident.title,
          severity: incident.severity,
          status: incident.status,
          summary: incident.summary,
          startedAt: iso(incident.startedAt),
        }
      : null,
    service: service
      ? {
          id: service.id,
          hostId: service.hostId,
          name: service.name,
          status: service.status,
          autoRestartPhase: service.autoRestartPhase,
        }
      : null,
    host: host
      ? {
          id: host.id,
          kind: host.kind,
          name: host.name,
          distro: host.distro,
        }
      : null,
  };
}

function decisionResponse(result: ApprovalDecisionResult) {
  return {
    approval: approvalResponse(
      result.approval,
      result.incident,
      null,
      null,
      result.proposal,
    ),
    proposal: result.proposal
      ? {
          id: result.proposal.id,
          actionType: result.proposal.actionType,
          status: result.proposal.status,
          risk: result.proposal.risk,
          confidence: result.proposal.confidence,
          rationale: result.proposal.rationale,
          approvalId: result.proposal.approvalId,
          actionId: result.proposal.actionId,
        }
      : null,
    action: result.action
      ? {
          id: result.action.id,
          type: result.action.type,
          status: result.action.status,
          requestedBy: result.action.requestedBy,
          approvedBy: result.action.approvedBy,
          proposalId: result.action.proposalId,
          approvalId: result.action.approvalId,
          source: result.action.source,
          startedAt: iso(result.action.startedAt),
        }
      : null,
    incident: {
      id: result.incident.id,
      status: result.incident.status,
    },
  };
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    detail,
  });
}

function handleError(reply: FastifyReply, error: unknown) {
  if (error instanceof IncidentError) {
    const title =
      error.statusCode === 404
        ? "Not Found"
        : error.statusCode === 409
          ? "Conflict"
          : error.statusCode === 403
            ? "Forbidden"
            : "Error";
    return problem(reply, error.statusCode, title, error.message);
  }
  throw error;
}

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/approvals",
    { preHandler: requireAuth, config: { scopes: ["approvals:read"] } },
    async (request) => {
      const query = approvalQuerySchema.parse(request.query);
      const [rows, all] = await Promise.all([
        db
          .select()
          .from(approvals)
          .where(eq(approvals.status, query.status))
          .orderBy(desc(approvals.requestedAt))
          .limit(query.limit),
        db
          .select({ id: approvals.id })
          .from(approvals)
          .where(eq(approvals.status, query.status)),
      ]);

      const incidentIds = [...new Set(rows.map((row) => row.incidentId))];
      const incidentRows =
        incidentIds.length > 0
          ? await db
              .select()
              .from(incidents)
              .where(inArray(incidents.id, incidentIds))
          : [];
      const incidentMap = new Map(incidentRows.map((row) => [row.id, row]));
      const serviceIds = [...new Set(incidentRows.map((row) => row.serviceId))];
      const serviceRows =
        serviceIds.length > 0
          ? await db
              .select()
              .from(services)
              .where(inArray(services.id, serviceIds))
          : [];
      const serviceMap = new Map(serviceRows.map((row) => [row.id, row]));
      const hostIds = [...new Set(serviceRows.map((row) => row.hostId))];
      const hostRows =
        hostIds.length > 0
          ? await db.select().from(hosts).where(inArray(hosts.id, hostIds))
          : [];
      const hostMap = new Map(hostRows.map((row) => [row.id, row]));
      const proposalIds = [
        ...new Set(
          rows
            .map((row) => row.proposalId)
            .filter((value): value is string => Boolean(value)),
        ),
      ];
      const proposalRows =
        proposalIds.length > 0
          ? await db
              .select()
              .from(incidentActionProposals)
              .where(inArray(incidentActionProposals.id, proposalIds))
          : [];
      const proposalMap = new Map(proposalRows.map((row) => [row.id, row]));

      return {
        items: rows.map((row) => {
          const incident = incidentMap.get(row.incidentId) ?? null;
          const service = incident
            ? (serviceMap.get(incident.serviceId) ?? null)
            : null;
          return approvalResponse(
            row,
            incident,
            service,
            service ? (hostMap.get(service.hostId) ?? null) : null,
            row.proposalId ? (proposalMap.get(row.proposalId) ?? null) : null,
          );
        }),
        total: all.length,
      };
    },
  );

  const decide =
    (decision: "approved" | "rejected") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = approvalDecisionSchema.parse(request.body ?? {});
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        const result = await decideApproval(id, decision, user, body.note);
        return reply
          .code(decision === "approved" ? 202 : 200)
          .send(decisionResponse(result));
      } catch (error) {
        return handleError(reply, error);
      }
    };

  app.post(
    "/approvals/:id/approve",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["approvals:decide"] },
    },
    decide("approved"),
  );
  app.post(
    "/approvals/:id/reject",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["approvals:decide"] },
    },
    decide("rejected"),
  );
}
