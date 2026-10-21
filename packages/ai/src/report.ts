import type { AnalysisResult } from "./prompt.js";

export interface ReportContext {
  incidentId: string;
  serviceName: string;
  title: string;
  startedAt: string;
  logExcerpt?: Array<{
    id: string;
    ts: string;
    level: string;
    message: string;
  }>;
}

export function renderMarkdownReport(
  context: ReportContext,
  analysis: AnalysisResult,
): string {
  const evidence =
    analysis.evidence.length > 0
      ? analysis.evidence
          .map(
            (item) =>
              `- ${item.log_id ? `\`${item.log_id}\`: ` : ""}${item.quote}`,
          )
          .join("\n")
      : "- 該当するログ行を特定できませんでした";

  const actions =
    analysis.recommended_actions.length > 0
      ? analysis.recommended_actions
          .map(
            (action) =>
              `| ${action.type} | ${action.target ?? "-"} | ${action.detail ?? "-"} | ${action.risk} |`,
          )
          .join("\n")
      : "| investigate | - | ログと設定の確認 | none |";

  const logs =
    context.logExcerpt && context.logExcerpt.length > 0
      ? context.logExcerpt
          .map(
            (line) => `${line.ts} ${line.level.toUpperCase()} ${line.message}`,
          )
          .join("\n")
      : "(no log excerpt)";

  return `# インシデントレポート: ${context.title}

- **Incident ID**: ${context.incidentId}
- **Service**: ${context.serviceName}
- **Started at**: ${context.startedAt}
- **Severity**: ${analysis.severity}
- **Category**: ${analysis.category}
- **Confidence**: ${(analysis.confidence * 100).toFixed(0)}%
- **Generated at**: ${new Date().toISOString()}

## 概要

${analysis.summary}

## 推定原因

${analysis.root_cause_hypothesis || "特定できませんでした"}

## 根拠ログ

${evidence}

## 推奨対応

| 種別 | 対象 | 内容 | リスク |
| --- | --- | --- | --- |
${actions}

## ログ抜粋

\`\`\`text
${logs}
\`\`\`

## 注意

- このレポートはローカル LLM による推定を含みます。実行前に内容を確認してください。
- 自動実行されるのは、ポリシーエンジンが許可した操作のみです。
${analysis.needs_human ? "- **人の確認が必要** と判定されています。\n" : ""}`;
}
