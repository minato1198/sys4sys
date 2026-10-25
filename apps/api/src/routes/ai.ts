import type { FastifyInstance, FastifyReply } from "fastify";
import { aiSettingsUpdateSchema } from "@sys4sys/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getLatestAnalysisReport } from "../ai/analysis.js";
import { enqueueIncidentAnalysis } from "../ai/queue.js";
import { serializedAnalysis, serializedReport } from "../ai/serialize.js";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { db } from "../db/index.js";
import { incidents } from "../db/schema.js";
import {
  AiNotConfiguredError,
  getAiSettingsView,
  saveAiSettings,
  testAiSettings,
} from "../settings/ai.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

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

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/settings/ai",
    { preHandler: requireRole("admin"), config: { scopes: ["settings:read"] } },
    async () => getAiSettingsView(),
  );

  app.put(
    "/settings/ai",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["settings:write"] },
    },
    async (request, reply) => {
      const body = aiSettingsUpdateSchema.parse(request.body);
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      const before = await getAiSettingsView();
      const view = await saveAiSettings(body);
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "settings.ai.update",
        target: "settings:ai",
        before: {
          baseUrl: before.baseUrl,
          model: before.model,
          apiKeySet: before.apiKeySet,
          dailyRequestLimit: before.dailyRequestLimit,
          sendLogsExternally: before.sendLogsExternally,
        },
        after: {
          baseUrl: view.baseUrl,
          model: view.model,
          apiKeySet: view.apiKeySet,
          dailyRequestLimit: view.dailyRequestLimit,
          sendLogsExternally: view.sendLogsExternally,
        },
        ip: request.ip,
      });
      return view;
    },
  );

  app.post(
    "/ai/test",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["settings:write"] },
    },
    async (request, reply) => {
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        const result = await testAiSettings();
        await writeAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "settings.ai.test",
          target: "settings:ai",
          after: {
            modelCount: result.models.length,
            latencyMs: result.latencyMs,
          },
          ip: request.ip,
        });
        return result;
      } catch (error) {
        if (error instanceof AiNotConfiguredError) {
          return problem(reply, 409, "Conflict", error.message);
        }
        return problem(
          reply,
          502,
          "Bad Gateway",
          `AI プロバイダに接続できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );

  app.post(
    "/incidents/:id/analyze",
    {
      preHandler: requireRole("operator"),
      config: { scopes: ["incidents:write"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const [incident] = await db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.id, id))
        .limit(1);
      if (!incident) {
        return problem(reply, 404, "Not Found", "インシデントが見つかりません");
      }
      const queued = enqueueIncidentAnalysis(id);
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "ai.analyze.request",
        target: `incident:${id}`,
        after: { queued },
        ip: request.ip,
      });
      return reply.code(202).send({
        incidentId: id,
        queued: true,
        alreadyQueued: !queued,
        status: "queued",
      });
    },
  );

  app.get(
    "/incidents/:id/analysis",
    { preHandler: requireAuth, config: { scopes: ["incidents:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const [incident] = await db
        .select({ id: incidents.id })
        .from(incidents)
        .where(eq(incidents.id, id))
        .limit(1);
      if (!incident) {
        return problem(reply, 404, "Not Found", "インシデントが見つかりません");
      }
      const latest = await getLatestAnalysisReport(id);
      return {
        analysis: latest.analysis ? serializedAnalysis(latest.analysis) : null,
        report: latest.report ? serializedReport(latest.report) : null,
      };
    },
  );
}
