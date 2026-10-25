import type { FastifyInstance } from "fastify";
import { reportExportQuerySchema, reportQuerySchema } from "@sys4sys/shared";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getReportWithContext, type ReportRow } from "../ai/analysis.js";
import { serializedAnalysis, serializedReport } from "../ai/serialize.js";
import { requireAuth } from "../auth/guard.js";
import { db } from "../db/index.js";
import { incidents, reports, services } from "../db/schema.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;

function incidentSummary(
  incident: IncidentRow | null,
  service: ServiceRow | null,
) {
  if (!incident) return null;
  return {
    id: incident.id,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    startedAt: incident.startedAt.toISOString(),
    serviceId: incident.serviceId,
    serviceName: service?.name ?? null,
  };
}

function reportListRow(row: {
  report: ReportRow;
  incident: IncidentRow | null;
  service: ServiceRow | null;
}) {
  return {
    ...serializedReport(row.report),
    incident: incidentSummary(row.incident, row.service),
  };
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/reports",
    { preHandler: requireAuth, config: { scopes: ["reports:read"] } },
    async (request) => {
      const query = reportQuerySchema.parse(request.query);
      const where = query.incidentId
        ? eq(reports.incidentId, query.incidentId)
        : undefined;
      const rows = await db
        .select({
          report: reports,
          incident: incidents,
          service: services,
        })
        .from(reports)
        .leftJoin(incidents, eq(reports.incidentId, incidents.id))
        .leftJoin(services, eq(incidents.serviceId, services.id))
        .where(where)
        .orderBy(desc(reports.createdAt))
        .limit(query.limit)
        .offset(query.offset);
      const totalRows = await db
        .select({ id: reports.id })
        .from(reports)
        .where(where);
      return {
        items: rows.map(reportListRow),
        total: totalRows.length,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.get(
    "/reports/:id",
    { preHandler: requireAuth, config: { scopes: ["reports:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const context = await getReportWithContext(id);
      if (!context) {
        return reply.code(404).type("application/problem+json").send({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "レポートが見つかりません",
        });
      }
      const [service] = context.incident
        ? await db
            .select()
            .from(services)
            .where(eq(services.id, context.incident.serviceId))
            .limit(1)
        : [];
      return {
        ...serializedReport(context.report),
        incident: incidentSummary(context.incident, service ?? null),
        analysis: context.analysis
          ? serializedAnalysis(context.analysis)
          : null,
      };
    },
  );

  app.get(
    "/reports/:id/export",
    { preHandler: requireAuth, config: { scopes: ["reports:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const query = reportExportQuerySchema.parse(request.query);
      const context = await getReportWithContext(id);
      if (!context) {
        return reply.code(404).type("application/problem+json").send({
          type: "about:blank",
          title: "Not Found",
          status: 404,
          detail: "レポートが見つかりません",
        });
      }
      const filename = `sys4sys-report-${id.slice(0, 8)}.${query.format}`;
      reply.header("content-disposition", `attachment; filename="${filename}"`);
      if (query.format === "json") {
        return {
          report: serializedReport(context.report),
          analysis: context.analysis
            ? serializedAnalysis(context.analysis)
            : null,
        };
      }
      return reply
        .type("text/markdown; charset=utf-8")
        .send(context.report.body);
    },
  );
}
