"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppShell } from "../components/AppShell";
import { useConfirmDialog } from "../components/ui/useConfirmDialog";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface HostView {
  id: string;
  kind: "windows" | "wsl";
  name: string;
  distro: string | null;
}

interface ServiceView {
  id: string;
  name: string;
  hostId: string;
  status: string;
  autoRestartPhase: "observe" | "approve" | "auto";
  lastStartedAt: string | null;
  lastExitedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
}

type IncidentSeverity = "info" | "warning" | "error" | "critical";
type IncidentStatus = "open" | "acked" | "approval" | "resolved";

interface Incident {
  id: string;
  serviceId: string;
  fingerprint: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  startedAt: string;
  resolvedAt: string | null;
  detectedBy: "rule" | "health" | "process" | "ai";
  restartAttempts: number;
  summary: string | null;
  pendingApprovalId: string | null;
  service: ServiceView | null;
  host: HostView | null;
}

interface IncidentEvent {
  id: string;
  ts: string;
  type: string;
  payload: Record<string, unknown> | null;
}

interface Approval {
  id: string;
  incidentId: string;
  proposalId: string | null;
  source: "policy" | "ai" | "manual";
  requestedAction: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  expiresAt: string | null;
}

type ActionProposalStatus =
  | "proposed"
  | "pending_approval"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "rejected"
  | "expired"
  | "superseded";

type ActionProposalRisk = "low" | "medium" | "high";

interface ActionProposal {
  id: string;
  incidentId: string;
  analysisId: string | null;
  serviceId: string;
  actionType: "restart" | "start" | "stop" | "deploy";
  status: ActionProposalStatus;
  risk: ActionProposalRisk;
  confidence: number;
  rationale: string | null;
  analysisRequestedBy: string | null;
  approvalId: string | null;
  actionId: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  error: string | null;
}

interface IncidentAction {
  id: string;
  serviceId: string;
  type: string;
  status: string;
  requestedBy: string | null;
  approvedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface AiAnalysis {
  id: string;
  incidentId: string;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  confidence: number;
  latencyMs: number;
  createdAt: string;
  result: {
    severity: IncidentSeverity;
    category: string;
    summary: string;
    rootCauseHypothesis: string;
    evidence: Array<{ logId: string | null; quote: string }>;
    recommendedActions: Array<{
      type: string;
      target: string | null;
      detail: string | null;
      risk: string;
    }>;
    confidence: number;
    needsHuman: boolean;
  };
}

interface ReportView {
  id: string;
  incidentId: string;
  format: "markdown" | "json";
  body: string;
  createdAt: string;
}

interface IncidentDetail extends Incident {
  events: IncidentEvent[];
  approvals: Approval[];
  proposals: ActionProposal[];
  actions: IncidentAction[];
  analysis: AiAnalysis | null;
  report: ReportView | null;
}

interface IncidentList {
  items: Incident[];
  total: number;
}

interface Problem {
  detail?: string;
}

const STATUSES: Array<{ value: "" | IncidentStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "approval", label: "Approval" },
  { value: "acked", label: "Acked" },
  { value: "resolved", label: "Resolved" },
];

const SEVERITIES: Array<{ value: "" | IncidentSeverity; label: string }> = [
  { value: "", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function severityTone(severity: IncidentSeverity): string {
  if (severity === "critical" || severity === "error") return "text-danger";
  if (severity === "warning") return "text-warning";
  return "text-fg";
}

function severityBadge(severity: IncidentSeverity): string {
  if (severity === "critical")
    return "border-danger/40 bg-danger/15 text-danger";
  if (severity === "error") return "border-danger/30 bg-danger/10 text-danger";
  if (severity === "warning")
    return "border-warning/30 bg-warning/10 text-warning";
  return "border-border bg-surface-muted text-fg";
}

function statusBadge(status: IncidentStatus): string {
  if (status === "open") return "border-danger/40 bg-danger/10 text-danger";
  if (status === "approval")
    return "border-warning/40 bg-warning/10 text-warning";
  if (status === "acked") return "border-info/40 bg-info/10 text-info";
  return "border-success/30 bg-success/10 text-success";
}

function actionStatusTone(status: string): string {
  if (status === "succeeded") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "running" || status === "pending") return "text-warning";
  return "text-fg-muted";
}

function riskBadge(risk: ActionProposalRisk): string {
  if (risk === "high") return "border-danger/40 bg-danger/10 text-danger";
  if (risk === "medium") return "border-warning/40 bg-warning/10 text-warning";
  return "border-info/40 bg-info/10 text-info";
}

function proposalStatusBadge(status: ActionProposalStatus): string {
  if (status === "pending_approval")
    return "border-warning/40 bg-warning/10 text-warning";
  if (status === "approved" || status === "executing")
    return "border-info/40 bg-info/10 text-info";
  if (status === "succeeded")
    return "border-success/40 bg-success/10 text-success";
  if (status === "failed" || status === "rejected")
    return "border-danger/40 bg-danger/10 text-danger";
  return "border-border bg-surface text-fg-muted";
}

const EVENT_LABELS: Record<string, string> = {
  detected: "検知",
  recurred: "再発",
  acked: "確認済み",
  approval_requested: "承認リクエスト",
  approval_approved: "承認",
  approval_rejected: "却下",
  resolved: "解決",
  recovered: "復旧",
  restart_failed: "再起動失敗",
  ai_action_proposed: "AI 提案",
  ai_action_succeeded: "AI 操作成功",
  ai_action_failed: "AI 操作失敗",
  ai_action_stale: "AI 提案 陳腐化",
  ai_action_expired: "AI 提案 期限切れ",
  ai_action_superseded: "AI 提案 置換",
  escalated: "エスカレーション",
};

function formatPayload(payload: Record<string, unknown> | null): string {
  if (!payload || Object.keys(payload).length === 0) return "";
  return JSON.stringify(payload);
}

export default function IncidentsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [items, setItems] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"" | IncidentStatus>("");
  const [severityFilter, setSeverityFilter] = useState<"" | IncidentSeverity>(
    "",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ limit: "100" });
    if (statusFilter) params.set("status", statusFilter);
    if (severityFilter) params.set("severity", severityFilter);
    const response = await fetch(`/api/incidents?${params.toString()}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`incidents ${response.status}`);
    const body = (await response.json()) as IncidentList;
    setItems(body.items);
    setTotal(body.total);
  }, [severityFilter, statusFilter]);

  const loadDetail = useCallback(async (id: string) => {
    const response = await fetch(`/api/incidents/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`incident ${response.status}`);
    setDetail((await response.json()) as IncidentDetail);
  }, []);

  useEffect(() => {
    const focus = new URLSearchParams(window.location.search).get("focus");
    if (focus) setSelectedId(focus);
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const meResponse = await fetch("/api/auth/me", { cache: "no-store" });
        if (meResponse.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
        if (active) setUser((await meResponse.json()) as AuthUser);
        await loadList();
        if (active) setError(null);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [loadDetail, selectedId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadList().catch(() => undefined);
      if (selectedId) {
        void loadDetail(selectedId).catch(() => undefined);
      }
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadList, selectedId]);

  async function act(action: "ack" | "resolve"): Promise<string | null> {
    if (!selectedId) return null;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/incidents/${encodeURIComponent(selectedId)}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: note.trim() || undefined }),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `${action} に失敗しました (${response.status})`,
        );
      }
      setDetail((await response.json()) as IncidentDetail);
      setNote("");
      setMessage(action === "ack" ? "確認済みにしました" : "解決しました");
      await loadList();
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      return text;
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    if (!selectedId) return;
    setAnalyzing(true);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/incidents/${encodeURIComponent(selectedId)}/analyze`,
        { method: "POST" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `AI 分析の実行に失敗しました (${response.status})`,
        );
      }
      setMessage(
        "AI 分析をキューに追加しました。完了までしばらくお待ちください。",
      );
      const id = selectedId;
      window.setTimeout(() => {
        void loadDetail(id).catch(() => undefined);
      }, 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnalyzing(false);
    }
  }

  async function requestApproval(proposal: ActionProposal) {
    setProposalBusyId(proposal.id);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/action-proposals/${encodeURIComponent(proposal.id)}/request-approval`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: note.trim() || undefined }),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `承認依頼に失敗しました (${response.status})`,
        );
      }
      setMessage("AI 提案を承認待ちにしました。承認画面で確認してください。");
      if (selectedId) await loadDetail(selectedId);
      await loadList();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProposalBusyId(null);
    }
  }

  const canOperate = user?.role === "admin" || user?.role === "operator";

  const summary = useMemo(() => {
    return {
      total,
      open: items.filter((item) => item.status === "open").length,
      approval: items.filter((item) => item.status === "approval").length,
      resolved: items.filter((item) => item.status === "resolved").length,
    };
  }, [items, total]);

  return (
    <AppShell
      title="インシデント"
      description="監視ルールが検知した異常、承認、再起動の履歴を確認します。"
      user={user}
    >
      {error ? (
        <div className="mt-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-6 rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          {message}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total", value: summary.total, tone: "text-fg" },
          { label: "Open", value: summary.open, tone: "text-danger" },
          { label: "Approval", value: summary.approval, tone: "text-warning" },
          {
            label: "Resolved",
            value: summary.resolved,
            tone: "text-success",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-border bg-surface p-4"
          >
            <div className="text-xs font-medium text-fg-muted">
              {card.label}
            </div>
            <div
              className={`mt-2 font-mono text-2xl tabular-nums ${card.tone}`}
            >
              {card.value}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">インシデント一覧</h2>
            <p className="text-xs text-fg-muted">
              10
              秒ごとに自動更新します。行を選択するとタイムラインを表示します。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value as "" | IncidentStatus)
              }
              className="rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-xs text-fg focus:border-success/50"
            >
              {STATUSES.map((item) => (
                <option key={item.value || "all"} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <select
              value={severityFilter}
              onChange={(event) =>
                setSeverityFilter(event.target.value as "" | IncidentSeverity)
              }
              className="rounded-md border border-border bg-surface-muted px-2.5 py-1.5 text-xs text-fg focus:border-success/50"
            >
              {SEVERITIES.map((item) => (
                <option key={item.value || "all"} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadList()}
              className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg"
            >
              更新
            </button>
          </div>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  Severity
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Incident
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Service
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Started
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Approval
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-fg-muted"
                  >
                    読み込み中…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-fg-muted"
                  >
                    条件に一致するインシデントはありません
                  </td>
                </tr>
              ) : (
                items.map((incident) => (
                  <tr
                    key={incident.id}
                    onClick={() => setSelectedId(incident.id)}
                    className={`cursor-pointer align-top transition ${
                      selectedId === incident.id
                        ? "bg-surface-muted"
                        : "hover:bg-surface-muted"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${severityBadge(
                          incident.severity,
                        )}`}
                      >
                        {incident.severity}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-80 text-sm font-medium text-fg">
                        {incident.title}
                      </div>
                      <div className="mt-0.5 max-w-80 truncate text-xs text-fg-muted">
                        {incident.summary ?? incident.fingerprint}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-fg">
                        {incident.service?.name ?? incident.serviceId}
                      </div>
                      <div className="mt-0.5 text-xs text-fg-muted">
                        {incident.host?.kind?.toUpperCase() ?? "?"}{" "}
                        {incident.host?.distro ?? incident.host?.name ?? ""}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${statusBadge(
                          incident.status,
                        )}`}
                      >
                        {incident.status}
                      </span>
                      {incident.restartAttempts > 0 ? (
                        <div className="mt-1 text-xs text-fg-muted">
                          restart attempts: {incident.restartAttempts}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-fg">
                      {formatDate(incident.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {incident.pendingApprovalId ? (
                        <Link
                          href="/approvals"
                          className="text-warning hover:underline"
                        >
                          承認待ち
                        </Link>
                      ) : (
                        <span className="text-fg-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selectedId ? (
        <section className="mt-6 rounded-xl border border-border bg-surface">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                {detail?.title ?? "インシデント詳細"}
              </h2>
              <p className="mt-0.5 text-xs text-fg-muted">
                {detail
                  ? `${detail.fingerprint} / detected by ${detail.detectedBy}`
                  : "読み込み中…"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:border-danger/40 hover:text-danger"
            >
              閉じる
            </button>
          </div>

          {detail ? (
            <div className="grid gap-4 p-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-xs font-medium ${severityBadge(
                        detail.severity,
                      )}`}
                    >
                      {detail.severity}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.5 text-xs font-medium ${statusBadge(
                        detail.status,
                      )}`}
                    >
                      {detail.status}
                    </span>
                    <span className="text-xs text-fg-muted">
                      {formatDate(detail.startedAt)}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-fg-muted">Service</dt>
                      <dd className="text-fg">
                        {detail.service?.name ?? detail.serviceId}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Host</dt>
                      <dd className="text-fg">
                        {detail.host
                          ? `${detail.host.kind.toUpperCase()} ${
                              detail.host.distro ?? detail.host.name
                            }`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Auto restart</dt>
                      <dd className="text-fg">
                        {detail.service?.autoRestartPhase ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-fg-muted">Resolved</dt>
                      <dd className="text-fg">
                        {formatDate(detail.resolvedAt)}
                      </dd>
                    </div>
                  </dl>
                  {detail.summary ? (
                    <p className="mt-3 whitespace-pre-wrap text-xs text-fg">
                      {detail.summary}
                    </p>
                  ) : null}
                  {detail.service?.lastError ? (
                    <p className="mt-2 whitespace-pre-wrap rounded border border-danger/20 bg-danger/5 px-2 py-1.5 font-mono text-xs text-danger">
                      {detail.service.lastError}
                    </p>
                  ) : null}
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-fg-muted">
                    Timeline
                  </h3>
                  <ol className="mt-2 space-y-2">
                    {detail.events.map((event) => (
                      <li
                        key={event.id}
                        className="rounded-lg border border-border bg-surface-muted px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-fg">
                            {EVENT_LABELS[event.type] ?? event.type}
                          </span>
                          <span className="text-xs text-fg-muted">
                            {formatDate(event.ts)}
                          </span>
                        </div>
                        {formatPayload(event.payload) ? (
                          <pre className="scrollbar-thin mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-muted">
                            {formatPayload(event.payload)}
                          </pre>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-fg-muted">
                      AI analysis
                    </h3>
                    <div className="flex items-center gap-2">
                      {detail.report ? (
                        <Link
                          href={`/reports?focus=${encodeURIComponent(
                            detail.report.id,
                          )}`}
                          className="rounded border border-success/30 bg-success/10 px-2 py-1 text-xs font-medium text-success transition hover:bg-success/20"
                        >
                          レポートを開く
                        </Link>
                      ) : null}
                      {canOperate ? (
                        <button
                          type="button"
                          disabled={analyzing}
                          onClick={() => void analyze()}
                          className="rounded border border-border bg-surface-muted px-2 py-1 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg disabled:opacity-50"
                        >
                          {analyzing ? "投入中…" : "AI 分析を実行"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {detail.analysis ? (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        <span
                          className={`rounded border px-1.5 py-0.5 font-medium ${
                            detail.analysis.provider === "template"
                              ? "border-warning/30 bg-warning/10 text-warning"
                              : "border-success/30 bg-success/10 text-success"
                          }`}
                        >
                          {detail.analysis.provider}
                        </span>
                        <span className="font-mono">
                          {detail.analysis.model}
                        </span>
                        <span>
                          confidence{" "}
                          {(detail.analysis.confidence * 100).toFixed(0)}%
                        </span>
                        {detail.analysis.latencyMs > 0 ? (
                          <span>{detail.analysis.latencyMs}ms</span>
                        ) : null}
                      </div>
                      <p className="text-xs leading-relaxed text-fg">
                        {detail.analysis.result.summary}
                      </p>
                      <dl className="grid gap-1 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-fg-muted">Category</dt>
                          <dd className="font-mono text-fg">
                            {detail.analysis.result.category}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-fg-muted">Generated</dt>
                          <dd className="text-fg">
                            {formatDate(detail.analysis.createdAt)}
                          </dd>
                        </div>
                      </dl>
                      {detail.analysis.result.rootCauseHypothesis ? (
                        <div>
                          <div className="text-xs text-fg-muted">推定原因</div>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-fg">
                            {detail.analysis.result.rootCauseHypothesis}
                          </p>
                        </div>
                      ) : null}
                      {detail.analysis.result.evidence.length > 0 ? (
                        <div>
                          <div className="text-xs text-fg-muted">根拠ログ</div>
                          <ul className="mt-1 space-y-1">
                            {detail.analysis.result.evidence.map(
                              (item, index) => (
                                <li
                                  key={`${item.logId ?? "log"}-${index}`}
                                  className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-fg-muted"
                                >
                                  {item.logId ? (
                                    <span className="mr-1 text-success">
                                      {item.logId.slice(0, 8)}
                                    </span>
                                  ) : null}
                                  {item.quote}
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      ) : null}
                      {detail.analysis.result.recommendedActions.length > 0 ? (
                        <div>
                          <div className="text-xs text-fg-muted">推奨対応</div>
                          <ul className="mt-1 space-y-1">
                            {detail.analysis.result.recommendedActions.map(
                              (action, index) => (
                                <li
                                  key={`${action.type}-${index}`}
                                  className="flex items-start justify-between gap-2 rounded border border-border bg-surface px-2 py-1 text-xs"
                                >
                                  <span className="text-fg">
                                    <span className="font-mono text-success">
                                      {action.type}
                                    </span>{" "}
                                    {action.target ?? ""} {action.detail ?? ""}
                                  </span>
                                  <span className="shrink-0 text-warning">
                                    {action.risk}
                                  </span>
                                </li>
                              ),
                            )}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-fg-muted">
                      AI
                      分析はまだありません。インシデント作成時に自動実行され、
                      未設定時はルールベースのレポートを生成します。
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <h3 className="text-xs font-semibold text-fg-muted">
                    AI 提案
                  </h3>
                  {detail.proposals.length === 0 ? (
                    <p className="mt-2 text-xs text-fg-muted">
                      実行可能な AI 提案はありません。機能が無効な場合や
                      フォールバック分析では生成されません。
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.proposals.map((proposal) => {
                        const selfRequested =
                          Boolean(proposal.analysisRequestedBy) &&
                          proposal.analysisRequestedBy === user?.id;
                        const canRequest =
                          canOperate &&
                          proposal.status === "proposed" &&
                          !detail.pendingApprovalId &&
                          detail.status !== "resolved";
                        return (
                          <li
                            key={proposal.id}
                            className="rounded border border-border bg-surface px-2.5 py-2 text-xs"
                          >
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono font-medium text-fg">
                                {proposal.actionType}
                              </span>
                              <span
                                className={`rounded border px-1.5 py-0.5 text-xs font-medium ${proposalStatusBadge(
                                  proposal.status,
                                )}`}
                              >
                                {proposal.status}
                              </span>
                              <span
                                className={`rounded border px-1.5 py-0.5 text-xs font-medium ${riskBadge(
                                  proposal.risk,
                                )}`}
                              >
                                risk {proposal.risk}
                              </span>
                              <span className="text-fg-muted">
                                confidence{" "}
                                {(proposal.confidence * 100).toFixed(0)}%
                              </span>
                            </div>
                            {proposal.rationale ? (
                              <p className="mt-1 whitespace-pre-wrap text-xs text-fg">
                                {proposal.rationale}
                              </p>
                            ) : null}
                            <div className="mt-1 text-xs text-fg-muted">
                              期限: {formatDate(proposal.expiresAt)}
                              {proposal.actionId
                                ? ` / action: ${proposal.actionId}`
                                : ""}
                            </div>
                            {proposal.error ? (
                              <div className="mt-1 break-words text-xs text-danger">
                                {proposal.error}
                              </div>
                            ) : null}
                            {selfRequested ? (
                              <p className="mt-1 text-xs text-warning">
                                あなたが実行した分析の提案です。承認は別の
                                operator / admin が行ってください。
                              </p>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {proposal.status === "pending_approval" ? (
                                <Link
                                  href="/approvals"
                                  className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-medium text-warning transition hover:bg-warning/20"
                                >
                                  承認画面へ
                                </Link>
                              ) : null}
                              {canRequest ? (
                                <button
                                  type="button"
                                  disabled={proposalBusyId === proposal.id}
                                  onClick={() => void requestApproval(proposal)}
                                  className="rounded border border-success/40 bg-success/10 px-2 py-1 text-xs font-medium text-success transition hover:bg-success/20 disabled:opacity-50"
                                >
                                  {proposalBusyId === proposal.id
                                    ? "依頼中…"
                                    : "この提案で承認依頼"}
                                </button>
                              ) : null}
                              {proposal.status === "proposed" &&
                              detail.pendingApprovalId ? (
                                <span className="text-xs text-fg-muted">
                                  別の承認待ちがあります
                                </span>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <h3 className="text-xs font-semibold text-fg-muted">
                    Response
                  </h3>
                  {canOperate && detail.status !== "resolved" ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        rows={2}
                        placeholder="対応メモ（任意）"
                        className="w-full rounded-md border border-border bg-surface-muted px-2.5 py-2 text-xs text-fg focus:border-success/50"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act("ack")}
                          className="min-h-11 rounded-md border border-info/40 bg-info/10 px-3 py-1.5 text-xs font-medium text-info transition hover:bg-info/20 disabled:opacity-50 sm:min-h-10"
                        >
                          Acknowledge
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            requestConfirm(
                              {
                                title: "インシデントを解決済みにしますか？",
                                description:
                                  "このインシデントを closed にし、監視対象から外します。",
                                target: (
                                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                    <dt className="text-fg-muted">Incident</dt>
                                    <dd>{detail.title}</dd>
                                    <dt className="text-fg-muted">Severity</dt>
                                    <dd>{detail.severity}</dd>
                                    <dt className="text-fg-muted">Service</dt>
                                    <dd>
                                      {detail.service?.name ??
                                        detail.serviceId ??
                                        "—"}
                                    </dd>
                                    <dt className="text-fg-muted">Status</dt>
                                    <dd>{detail.status}</dd>
                                  </dl>
                                ),
                                impact:
                                  "解決後に同じ条件が発生すれば、新しいインシデントとして記録されます。",
                                confirmLabel: "解決する",
                              },
                              () => act("resolve"),
                            )
                          }
                          className="min-h-11 rounded-md border border-success/40 bg-success/10 px-3 py-1.5 text-xs font-medium text-success transition hover:bg-success/20 disabled:opacity-50 sm:min-h-10"
                        >
                          Resolve
                        </button>
                        {detail.pendingApprovalId ? (
                          <Link
                            href="/approvals"
                            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition hover:bg-warning/20"
                          >
                            承認画面へ
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-fg-muted">
                      {detail.status === "resolved"
                        ? "解決済みです。"
                        : "この操作には operator 以上の権限が必要です。"}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <h3 className="text-xs font-semibold text-fg-muted">
                    Approvals
                  </h3>
                  {detail.approvals.length === 0 ? (
                    <p className="mt-2 text-xs text-fg-muted">
                      承認リクエストはありません。
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.approvals.map((approval) => (
                        <li
                          key={approval.id}
                          className="rounded border border-border bg-surface px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-fg">
                              {approval.status}
                            </span>
                            <span className="text-xs text-fg-muted">
                              {formatDate(approval.requestedAt)}
                            </span>
                          </div>
                          {approval.decidedBy ? (
                            <div className="mt-1 text-xs text-fg-muted">
                              by {approval.decidedBy}
                            </div>
                          ) : null}
                          {approval.note ? (
                            <div className="mt-1 text-xs text-fg-muted">
                              {approval.note}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-surface-muted p-3">
                  <h3 className="text-xs font-semibold text-fg-muted">
                    Actions
                  </h3>
                  {detail.actions.length === 0 ? (
                    <p className="mt-2 text-xs text-fg-muted">
                      再起動アクションはありません。
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.actions.map((action) => (
                        <li
                          key={action.id}
                          className="rounded border border-border bg-surface px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-fg">
                              {action.type}
                            </span>
                            <span
                              className={`text-xs ${actionStatusTone(
                                action.status,
                              )}`}
                            >
                              {action.status}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-fg-muted">
                            {formatDate(action.startedAt)} →{" "}
                            {formatDate(action.finishedAt)}
                          </div>
                          {action.error ? (
                            <div className="mt-1 break-words text-xs text-danger">
                              {action.error}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-fg-muted">
              読み込み中…
            </div>
          )}
        </section>
      ) : null}

      {confirmDialog}
    </AppShell>
  );
}
