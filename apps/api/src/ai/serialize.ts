import { analysisResultSchema, type AnalysisResult } from "@sys4sys/ai";
import type { AiAnalysisRow, ReportRow } from "./analysis.js";

function fallbackResult(): AnalysisResult {
  return {
    severity: "error",
    category: "unknown",
    summary: "分析結果を読み込めませんでした",
    root_cause_hypothesis: "",
    evidence: [],
    recommended_actions: [],
    confidence: 0,
    needs_human: true,
  };
}

export function serializedAnalysis(row: AiAnalysisRow) {
  const parsed = analysisResultSchema.safeParse(row.result);
  const result = parsed.success ? parsed.data : fallbackResult();
  return {
    id: row.id,
    incidentId: row.incidentId,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    confidence: row.confidence,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
    result: {
      severity: result.severity,
      category: result.category,
      summary: result.summary,
      rootCauseHypothesis: result.root_cause_hypothesis,
      evidence: result.evidence.map((item) => ({
        logId: item.log_id ?? null,
        quote: item.quote,
      })),
      recommendedActions: result.recommended_actions.map((action) => ({
        type: action.type,
        target: action.target ?? null,
        detail: action.detail ?? null,
        risk: action.risk,
      })),
      confidence: result.confidence,
      needsHuman: result.needs_human,
    },
  };
}

export type SerializedAnalysis = ReturnType<typeof serializedAnalysis>;

export function serializedReport(row: ReportRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    format: row.format,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export type SerializedReport = ReturnType<typeof serializedReport>;
