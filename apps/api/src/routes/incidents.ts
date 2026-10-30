import type { FastifyInstance, FastifyReply } from "fastify";
import { incidentActionSchema, incidentQuerySchema } from "@sys4sys/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getLatestAnalysisReport } from "../ai/analysis.js";
import { serializedAnalysis, serializedReport } from "../ai/serialize.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import {
  approvals,
  hosts,
  incidentActionProposals,
  incidents,
  services,
} from "../db/schema.js";
import { expireProposalsForIncident } from "../monitoring/action-proposals.js";
import {
  ackIncident,
  getIncidentContext,
  IncidentError,
  resolveIncident,
  type IncidentContext,
} from "../monitoring/incidents.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;
type ActionProposalRow = typeof incidentActionProposals.$inferSelect;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function hostResponse(row: HostRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    distro: row.distro,
    defaultUser: row.defaultUser,
    enabled: row.enabled,
  };
}

function serviceResponse(row: ServiceRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    hostId: row.hostId,
    status: row.status,
    autoRestartPhase: row.autoRestartPhase,
    lastStartedAt: iso(row.lastStartedAt),
    lastExitedAt: iso(row.lastExitedAt),
    lastExitCode: row.lastExitCode,
    lastError: row.lastError,
  };
}

function incidentResponse(
  row: IncidentRow,
  service: ServiceRow | null,
  host: HostRow | null,
  pendingApprovalId: string | null,
) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    fingerprint: row.fingerprint,
    title: row.title,
    severity: row.severity,
    status: row.status,
    startedAt: iso(row.startedAt),
    resolvedAt: iso(row.resolvedAt),
    detectedBy: row.detectedBy,
    restartAttempts: row.restartAttempts,
    summary: row.summary,
    pendingApprovalId,
    service: serviceResponse(service),
    host: hostResponse(host),
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

function contextResponse(context: IncidentContext) {
  const pending = context.approvals.find((row) => row.status === "pending");
  return {
    ...incidentResponse(
      context.incident,
      context.service,
      context.host,
      pending?.id ?? null,
    ),
    events: context.events.map((row) => ({
      id: row.id,
      ts: iso(row.ts),
      type: row.type,
      payload: row.payload,
    })),
    approvals: context.approvals.map(approvalResponse),
    proposals: context.proposals.map(proposalResponse),
    actions: context.actions.map((row) => ({
      id: row.id,
      serviceId: row.serviceId,
      type: row.type,
      status: row.status,
      requestedBy: row.requestedBy,
      approvedBy: row.approvedBy,
      proposalId: row.proposalId,
      approvalId: row.approvalId,
      source: row.source,
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      error: row.error,
    })),
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

function handleIncidentError(reply: FastifyReply, error: unknown) {
  if (error instanceof IncidentError) {
    const title =
      error.statusCode === 404
        ? "Not Found"
        : error.statusCode === 409
          ? "Conflict"
          : "Error";
    return problem(reply, error.statusCode, title, error.message);
  }
  throw error;
}

async function detailForId(id: string) {
  await expireProposalsForIncident(id).catch(() => undefined);
  const context = await getIncidentContext(id);
  if (!context) return null;
  const latest = await getLatestAnalysisReport(id);
  return {
    ...contextResponse(context),
    analysis: latest.analysis ? serializedAnalysis(latest.analysis) : null,
    report: latest.report ? serializedReport(latest.report) : null,
  };
}

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/incidents",
    { preHandler: requireAuth, config: { scopes: ["incidents:read"] } },
    async (request) => {
      const query = incidentQuerySchema.parse(request.query);
      const where = and(
        query.status ? eq(incidents.status, query.status) : undefined,
        query.severity ? eq(incidents.severity, query.severity) : undefined,
        query.serviceId ? eq(incidents.serviceId, query.serviceId) : undefined,
      );
      const [rows, all] = await Promise.all([
        db
          .select()
          .from(incidents)
          .where(where)
          .orderBy(desc(incidents.startedAt))
          .limit(query.limit)
          .offset(query.offset),
        db.select({ id: incidents.id }).from(incidents).where(where),
      ]);

      const serviceIds = [...new Set(rows.map((row) => row.serviceId))];
      const serviceRows =
        serviceIds.length > 0
          ? await db
              .select()
              .from(services)
              .where(inArray(services.id, serviceIds))
          : [];
      const serviceMap = new Map(serviceRows.map((row) => [row.id, row]));
      const hostIds = [
        ...new Set(serviceRows.map((row) => row.hostId).filter(Boolean)),
      ];
      const hostRows =
        hostIds.length > 0
          ? await db.select().from(hosts).where(inArray(hosts.id, hostIds))
          : [];
      const hostMap = new Map(hostRows.map((row) => [row.id, row]));
      const incidentIds = rows.map((row) => row.id);
      const pending =
        incidentIds.length > 0
          ? await db
              .select()
              .from(approvals)
              .where(
                and(
                  inArray(approvals.incidentId, incidentIds),
                  eq(approvals.status, "pending"),
                ),
              )
          : [];
      const approvalByIncident = new Map(
        pending.map((row) => [row.incidentId, row.id]),
      );

      return {
        items: rows.map((row) => {
          const service = serviceMap.get(row.serviceId) ?? null;
          return incidentResponse(
            row,
            service,
            service ? (hostMap.get(service.hostId) ?? null) : null,
            approvalByIncident.get(row.id) ?? null,
          );
        }),
        total: all.length,
      };
    },
  );

  app.get(
    "/incidents/:id",
    { preHandler: requireAuth, config: { scopes: ["incidents:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const detail = await detailForId(id);
      if (!detail) {
        return problem(reply, 404, "Not Found", "インシデントが見つかりません");
      }
      return detail;
    },
  );

  app.post(
    "/incidents/:id/ack",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["incidents:write"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = incidentActionSchema.parse(request.body ?? {});
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        await ackIncident(id, user, body.note);
        await writeAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "incident.ack",
          target: `incident:${id}`,
          reason: body.note ?? null,
          ip: request.ip,
        });
        return (await detailForId(id)) ?? reply.code(204).send();
      } catch (error) {
        return handleIncidentError(reply, error);
      }
    },
  );

  app.post(
    "/incidents/:id/resolve",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["incidents:write"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = incidentActionSchema.parse(request.body ?? {});
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        await resolveIncident(id, user, body.note);
        await writeAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "incident.resolve",
          target: `incident:${id}`,
          reason: body.note ?? null,
          ip: request.ip,
        });
        return (await detailForId(id)) ?? reply.code(204).send();
      } catch (error) {
        return handleIncidentError(reply, error);
      }
    },
  );
}
