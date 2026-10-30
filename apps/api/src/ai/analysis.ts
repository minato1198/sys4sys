import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, lte, ne } from "drizzle-orm";
import {
  analysisResultSchema,
  OpenAiCompatibleClient,
  renderMarkdownReport,
  type AnalysisInput,
  type AnalysisResult,
} from "@sys4sys/ai";
import { writeAudit } from "../audit.js";
import { db } from "../db/index.js";
import {
  aiAnalyses,
  hosts,
  incidents,
  logEvents,
  reports,
  services,
} from "../db/schema.js";
import {
  AI_PROVIDER,
  externalLogsAllowed,
  getEffectiveAiSettings,
} from "../settings/ai.js";
import { materializeActionProposals } from "../monitoring/action-proposals.js";
import { maskText, truncateLine } from "./mask.js";

type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;
type AiAnalysisRow = typeof aiAnalyses.$inferSelect;
type ReportRow = typeof reports.$inferSelect;
type LogRow = typeof logEvents.$inferSelect;

export const FALLBACK_PROVIDER = "template";
export const FALLBACK_MODEL = "rules-v1";
export const FALLBACK_PROMPT_VERSION = "fallback-v1";
export const AI_PROMPT_VERSION = "v1";
const FINGERPRINT_CACHE_MINUTES = 30;

export class AnalysisNotFoundError extends Error {
  readonly statusCode = 404;

  constructor() {
    super("インシデントが見つかりません");
    this.name = "AnalysisNotFoundError";
  }
}

export interface AnalysisContext {
  incident: IncidentRow;
  service: ServiceRow | null;
  host: HostRow | null;
  title: string;
  summary: string;
  logs: Array<{
    id: string;
    ts: string;
    level: string;
    message: string;
  }>;
  similarIncidents: Array<{ title: string; summary: string }>;
}

export interface AnalysisOutcome {
  analysis: AiAnalysisRow;
  report: ReportRow;
  fallback: boolean;
  fallbackReason: string | null;
}

function iso(value: Date): string {
  return value.toISOString();
}

function todayStart(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function fitLogs(
  lines: AnalysisContext["logs"],
  maxTokens: number,
): AnalysisContext["logs"] {
  const budget = Math.max(1024, maxTokens * 4);
  const selected: AnalysisContext["logs"] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const size = line.message.length + line.id.length + line.ts.length + 24;
    if (selected.length > 0 && used + size > budget) break;
    selected.push(line);
    used += size;
    if (used >= budget) break;
  }
  return selected.reverse();
}

async function loadContext(incidentId: string): Promise<AnalysisContext> {
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  if (!incident) throw new AnalysisNotFoundError();

  const [service] = await db
    .select()
    .from(services)
    .where(eq(services.id, incident.serviceId))
    .limit(1);
  const [host] = service
    ? await db.select().from(hosts).where(eq(hosts.id, service.hostId)).limit(1)
    : [];

  const windowStart = new Date(incident.startedAt.getTime() - 2 * 60 * 1000);
  const windowEnd = new Date(incident.startedAt.getTime() + 5 * 60 * 1000);
  let rows = await db
    .select()
    .from(logEvents)
    .where(
      and(
        eq(logEvents.serviceId, incident.serviceId),
        gte(logEvents.ts, windowStart),
        lte(logEvents.ts, windowEnd),
      ),
    )
    .orderBy(asc(logEvents.ts))
    .limit(200);
  if (rows.length === 0) {
    rows = (
      await db
        .select()
        .from(logEvents)
        .where(eq(logEvents.serviceId, incident.serviceId))
        .orderBy(desc(logEvents.ts))
        .limit(60)
    ).reverse();
  }

  const logs = rows.map((row: LogRow) => ({
    id: row.id,
    ts: iso(row.ts),
    level: row.level,
    message: truncateLine(maskText(row.message), 2000),
  }));

  const similarRows = await db
    .select({
      title: incidents.title,
      summary: incidents.summary,
    })
    .from(incidents)
    .where(
      and(
        eq(incidents.serviceId, incident.serviceId),
        ne(incidents.id, incident.id),
      ),
    )
    .orderBy(desc(incidents.startedAt))
    .limit(5);

  return {
    incident,
    service: service ?? null,
    host: host ?? null,
    title: truncateLine(maskText(incident.title), 500),
    summary: truncateLine(maskText(incident.summary ?? ""), 1000),
    logs,
    similarIncidents: similarRows.map((row) => ({
      title: truncateLine(maskText(row.title), 300),
      summary: truncateLine(maskText(row.summary ?? ""), 500),
    })),
  };
}

async function countRequestsToday(): Promise<number> {
  const rows = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(
      and(
        gte(aiAnalyses.createdAt, todayStart()),
        eq(aiAnalyses.provider, AI_PROVIDER),
      ),
    );
  return rows.length;
}

async function findCachedAnalysis(
  context: AnalysisContext,
): Promise<{ row: AiAnalysisRow; result: AnalysisResult } | null> {
  const cutoff = new Date(Date.now() - FINGERPRINT_CACHE_MINUTES * 60 * 1000);
  const [row] = await db
    .select({ analysis: aiAnalyses })
    .from(aiAnalyses)
    .innerJoin(incidents, eq(aiAnalyses.incidentId, incidents.id))
    .where(
      and(
        eq(incidents.fingerprint, context.incident.fingerprint),
        eq(incidents.serviceId, context.incident.serviceId),
        ne(aiAnalyses.incidentId, context.incident.id),
        gte(aiAnalyses.createdAt, cutoff),
        eq(aiAnalyses.provider, AI_PROVIDER),
      ),
    )
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(1);
  if (!row) return null;
  const parsed = analysisResultSchema.safeParse(row.analysis.result);
  if (!parsed.success) return null;
  return { row: row.analysis, result: parsed.data };
}

function fallbackAnalysis(
  context: AnalysisContext,
  reason: string,
): AnalysisResult {
  const errors = context.logs.filter(
    (line) => line.level === "error" || line.level === "fatal",
  );
  const evidenceSource = (errors.length > 0 ? errors : context.logs).slice(-5);
  const category =
    context.incident.detectedBy === "health"
      ? "health_check_failure"
      : context.incident.detectedBy === "process"
        ? "process_exit"
        : "rule_match";

  const actions: AnalysisResult["recommended_actions"] = [
    {
      type: "investigate",
      target: context.service?.name ?? undefined,
      detail: "ログ、直近の設定変更、依存サービスを確認してください",
      risk: "none",
    },
  ];
  if (context.service?.autoRestartPhase === "auto") {
    actions.push({
      type: "restart",
      target: context.service.name,
      detail: "ポリシーエンジンの許可範囲内で再起動を検討してください",
      risk: "medium",
    });
  }

  return {
    severity: context.incident.severity,
    category,
    summary:
      context.summary ||
      `${context.service?.name ?? "サービス"} でインシデントを検知しました`,
    root_cause_hypothesis: [
      "AI 分析を実行できませんでした。",
      `理由: ${reason}`,
      "ログと直近の変更を確認し、原因を特定してください。",
    ].join(" "),
    evidence: evidenceSource.map((line) => ({
      log_id: line.id,
      quote: truncateLine(line.message, 500),
    })),
    recommended_actions: actions,
    confidence: 0.15,
    needs_human: true,
  };
}

function promptInput(
  context: AnalysisContext,
  maxInputTokens: number,
): AnalysisInput {
  return {
    serviceName: context.service?.name ?? "unknown",
    title: context.title,
    startedAt: iso(context.incident.startedAt),
    logLines: fitLogs(context.logs, maxInputTokens),
    similarIncidents: context.similarIncidents,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return truncateLine(maskText(message), 500);
}

/**
 * インシデント 1 件を分析し、Markdown レポートを保存する。
 * AI 未設定・外部送信禁止・日次上限・接続失敗時はルールベースにフォールバックする。
 */
export async function analyzeIncident(
  incidentId: string,
  options: {
    actorLabel?: string;
    actorUserId?: string | null;
    trigger?: "auto" | "manual";
  } = {},
): Promise<AnalysisOutcome> {
  const context = await loadContext(incidentId);
  const settings = await getEffectiveAiSettings();
  let result: AnalysisResult | null = null;
  let provider = FALLBACK_PROVIDER;
  let model = FALLBACK_MODEL;
  let promptVersion = FALLBACK_PROMPT_VERSION;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let fallbackReason: string | null = null;

  if (!settings) {
    fallbackReason = "AI プロバイダが未設定です";
  } else if (!externalLogsAllowed(settings)) {
    fallbackReason =
      "外部エンドポイントへのログ送信が無効です（設定で有効化できます）";
  } else {
    const used = await countRequestsToday();
    if (settings.dailyRequestLimit <= 0) {
      fallbackReason = "日次リクエスト上限が 0 に設定されています";
    } else if (used >= settings.dailyRequestLimit) {
      fallbackReason = `日次リクエスト上限（${settings.dailyRequestLimit} 件）に達しました`;
    } else {
      const cached = await findCachedAnalysis(context);
      if (cached) {
        result = cached.result;
        provider = `cache:${cached.row.provider}`;
        model = cached.row.model;
        promptVersion = cached.row.promptVersion;
      } else {
        const client = new OpenAiCompatibleClient({
          baseUrl: settings.baseUrl,
          model: settings.model,
          apiKey: settings.apiKey,
          timeoutSec: settings.timeoutSec,
          temperature: settings.temperature,
        });
        try {
          const response = await client.analyze(
            promptInput(context, settings.maxInputTokens),
          );
          result = response.result;
          provider = AI_PROVIDER;
          model = settings.model;
          promptVersion = AI_PROMPT_VERSION;
          inputTokens = response.usage.inputTokens;
          outputTokens = response.usage.outputTokens;
          latencyMs = Math.round(response.latencyMs);
        } catch (error) {
          fallbackReason = `AI リクエストに失敗しました: ${safeErrorMessage(error)}`;
        }
      }
    }
  }

  if (!result) {
    result = fallbackAnalysis(context, fallbackReason ?? "unknown");
  }

  const createdAt = new Date();
  const [analysis] = await db
    .insert(aiAnalyses)
    .values({
      id: randomUUID(),
      incidentId: context.incident.id,
      provider,
      model,
      promptVersion,
      inputTokens,
      outputTokens,
      result: result as unknown as Record<string, unknown>,
      confidence: result.confidence,
      latencyMs,
      createdAt,
    })
    .returning();
  if (!analysis) throw new Error("AI 分析結果を保存できませんでした");

  const reportBody = renderMarkdownReport(
    {
      incidentId: context.incident.id,
      serviceName: context.service?.name ?? "unknown",
      title: context.title,
      startedAt: iso(context.incident.startedAt),
      logExcerpt: context.logs.slice(-40),
    },
    result,
  );
  const [report] = await db
    .insert(reports)
    .values({
      id: randomUUID(),
      incidentId: context.incident.id,
      format: "markdown",
      body: reportBody,
      createdAt: new Date(),
    })
    .returning();
  if (!report) throw new Error("レポートを保存できませんでした");

  await writeAudit({
    actorUserId: options.actorUserId ?? null,
    actorLabel: options.actorLabel ?? "system:ai",
    action: "report.create",
    target: `incident:${context.incident.id}`,
    after: {
      analysisId: analysis.id,
      reportId: report.id,
      provider,
      model,
      fallback: Boolean(fallbackReason),
      trigger: options.trigger ?? "auto",
    },
  }).catch(() => undefined);

  try {
    await materializeActionProposals({
      incident: context.incident,
      service: context.service,
      analysis,
      result,
      analysisRequestedBy:
        options.trigger === "manual" ? (options.actorUserId ?? null) : null,
    });
  } catch (error) {
    console.warn(
      `[ai] action proposal materialization failed for incident ${context.incident.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    analysis,
    report,
    fallback: Boolean(fallbackReason),
    fallbackReason,
  };
}

export async function getLatestAnalysisReport(
  incidentId: string,
): Promise<{ analysis: AiAnalysisRow | null; report: ReportRow | null }> {
  const [analysis] = await db
    .select()
    .from(aiAnalyses)
    .where(eq(aiAnalyses.incidentId, incidentId))
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(1);
  const [report] = await db
    .select()
    .from(reports)
    .where(eq(reports.incidentId, incidentId))
    .orderBy(desc(reports.createdAt))
    .limit(1);
  return { analysis: analysis ?? null, report: report ?? null };
}

export async function getReportWithContext(reportId: string): Promise<{
  report: ReportRow;
  incident: IncidentRow | null;
  analysis: AiAnalysisRow | null;
} | null> {
  const [report] = await db
    .select()
    .from(reports)
    .where(eq(reports.id, reportId))
    .limit(1);
  if (!report) return null;
  const [incident] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, report.incidentId))
    .limit(1);
  const [analysis] = await db
    .select()
    .from(aiAnalyses)
    .where(eq(aiAnalyses.incidentId, report.incidentId))
    .orderBy(desc(aiAnalyses.createdAt))
    .limit(1);
  return {
    report,
    incident: incident ?? null,
    analysis: analysis ?? null,
  };
}

export { analysisResultSchema };
export type { AiAnalysisRow, ReportRow };
