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
  requestedAction: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
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
  if (severity === "critical" || severity === "error") return "text-danger-400";
  if (severity === "warning") return "text-warn-400";
  return "text-mist-200";
}

function severityBadge(severity: IncidentSeverity): string {
  if (severity === "critical")
    return "border-danger-400/40 bg-danger-400/15 text-danger-400";
  if (severity === "error")
    return "border-danger-400/30 bg-danger-400/10 text-danger-400";
  if (severity === "warning")
    return "border-warn-400/30 bg-warn-400/10 text-warn-400";
  return "border-ink-700 bg-ink-800 text-mist-200";
}

function statusBadge(status: IncidentStatus): string {
  if (status === "open")
    return "border-danger-400/40 bg-danger-400/10 text-danger-400";
  if (status === "approval")
    return "border-warn-400/40 bg-warn-400/10 text-warn-400";
  if (status === "acked") return "border-sky-400/40 bg-sky-400/10 text-sky-300";
  return "border-signal-400/30 bg-signal-400/10 text-signal-400";
}

function actionStatusTone(status: string): string {
  if (status === "succeeded") return "text-signal-400";
  if (status === "failed") return "text-danger-400";
  if (status === "running" || status === "pending") return "text-warn-400";
  return "text-mist-400";
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
      title="Incidents"
      description="監視ルールが検知した異常、承認、再起動の履歴を確認します。"
      user={user}
    >
      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-6 rounded-lg border border-signal-400/30 bg-signal-400/10 px-4 py-3 text-sm text-signal-400">
          {message}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total", value: summary.total, tone: "text-white" },
          { label: "Open", value: summary.open, tone: "text-danger-400" },
          { label: "Approval", value: summary.approval, tone: "text-warn-400" },
          {
            label: "Resolved",
            value: summary.resolved,
            tone: "text-signal-400",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4"
          >
            <div className="text-xs font-medium text-mist-400">
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

      <section className="mt-6 overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">
              インシデント一覧
            </h2>
            <p className="text-xs text-mist-400">
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
              className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
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
              className="rounded-md border border-ink-700 bg-ink-800 px-2.5 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
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
              className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white"
            >
              更新
            </button>
          </div>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[960px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-700/70 bg-ink-950/40 text-xs text-mist-400">
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
            <tbody className="divide-y divide-ink-700/40">
              {loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-mist-400"
                  >
                    読み込み中…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-mist-400"
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
                        ? "bg-ink-800/70"
                        : "hover:bg-ink-800/40"
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
                      <div className="max-w-80 text-sm font-medium text-white">
                        {incident.title}
                      </div>
                      <div className="mt-0.5 max-w-80 truncate text-xs text-mist-400">
                        {incident.summary ?? incident.fingerprint}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-xs text-mist-200">
                        {incident.service?.name ?? incident.serviceId}
                      </div>
                      <div className="mt-0.5 text-xs text-mist-400">
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
                        <div className="mt-1 text-xs text-mist-400">
                          restart attempts: {incident.restartAttempts}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-xs text-mist-200">
                      {formatDate(incident.startedAt)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {incident.pendingApprovalId ? (
                        <Link
                          href="/approvals"
                          className="text-warn-400 hover:underline"
                        >
                          承認待ち
                        </Link>
                      ) : (
                        <span className="text-mist-400">—</span>
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
        <section className="mt-6 rounded-xl border border-ink-700/70 bg-ink-900/50">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                {detail?.title ?? "インシデント詳細"}
              </h2>
              <p className="mt-0.5 text-xs text-mist-400">
                {detail
                  ? `${detail.fingerprint} / detected by ${detail.detectedBy}`
                  : "読み込み中…"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="rounded-md border border-ink-700 px-2.5 py-1 text-xs text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400"
            >
              閉じる
            </button>
          </div>

          {detail ? (
            <div className="grid gap-4 p-4 lg:grid-cols-[1.1fr_0.9fr]">
              <div className="space-y-4">
                <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
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
                    <span className="text-xs text-mist-400">
                      {formatDate(detail.startedAt)}
                    </span>
                  </div>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="text-xs text-mist-400">Service</dt>
                      <dd className="text-mist-200">
                        {detail.service?.name ?? detail.serviceId}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-mist-400">Host</dt>
                      <dd className="text-mist-200">
                        {detail.host
                          ? `${detail.host.kind.toUpperCase()} ${
                              detail.host.distro ?? detail.host.name
                            }`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-mist-400">Auto restart</dt>
                      <dd className="text-mist-200">
                        {detail.service?.autoRestartPhase ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-mist-400">Resolved</dt>
                      <dd className="text-mist-200">
                        {formatDate(detail.resolvedAt)}
                      </dd>
                    </div>
                  </dl>
                  {detail.summary ? (
                    <p className="mt-3 whitespace-pre-wrap text-xs text-mist-200">
                      {detail.summary}
                    </p>
                  ) : null}
                  {detail.service?.lastError ? (
                    <p className="mt-2 whitespace-pre-wrap rounded border border-danger-400/20 bg-danger-400/5 px-2 py-1.5 font-mono text-xs text-danger-400">
                      {detail.service.lastError}
                    </p>
                  ) : null}
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-mist-400">
                    Timeline
                  </h3>
                  <ol className="mt-2 space-y-2">
                    {detail.events.map((event) => (
                      <li
                        key={event.id}
                        className="rounded-lg border border-ink-700/60 bg-ink-950/30 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-mist-200">
                            {EVENT_LABELS[event.type] ?? event.type}
                          </span>
                          <span className="text-xs text-mist-400">
                            {formatDate(event.ts)}
                          </span>
                        </div>
                        {formatPayload(event.payload) ? (
                          <pre className="scrollbar-thin mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs text-mist-400">
                            {formatPayload(event.payload)}
                          </pre>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold text-mist-400">
                      AI analysis
                    </h3>
                    <div className="flex items-center gap-2">
                      {detail.report ? (
                        <Link
                          href={`/reports?focus=${encodeURIComponent(
                            detail.report.id,
                          )}`}
                          className="rounded border border-signal-400/30 bg-signal-400/10 px-2 py-1 text-xs font-medium text-signal-400 transition hover:bg-signal-400/20"
                        >
                          レポートを開く
                        </Link>
                      ) : null}
                      {canOperate ? (
                        <button
                          type="button"
                          disabled={analyzing}
                          onClick={() => void analyze()}
                          className="rounded border border-ink-700 bg-ink-800/80 px-2 py-1 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white disabled:opacity-50"
                        >
                          {analyzing ? "投入中…" : "AI 分析を実行"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {detail.analysis ? (
                    <div className="mt-2 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-mist-400">
                        <span
                          className={`rounded border px-1.5 py-0.5 font-medium ${
                            detail.analysis.provider === "template"
                              ? "border-warn-400/30 bg-warn-400/10 text-warn-400"
                              : "border-signal-400/30 bg-signal-400/10 text-signal-400"
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
                      <p className="text-xs leading-relaxed text-mist-200">
                        {detail.analysis.result.summary}
                      </p>
                      <dl className="grid gap-1 text-xs sm:grid-cols-2">
                        <div>
                          <dt className="text-mist-400">Category</dt>
                          <dd className="font-mono text-mist-200">
                            {detail.analysis.result.category}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-mist-400">Generated</dt>
                          <dd className="text-mist-200">
                            {formatDate(detail.analysis.createdAt)}
                          </dd>
                        </div>
                      </dl>
                      {detail.analysis.result.rootCauseHypothesis ? (
                        <div>
                          <div className="text-xs text-mist-400">推定原因</div>
                          <p className="mt-1 whitespace-pre-wrap text-xs text-mist-200">
                            {detail.analysis.result.rootCauseHypothesis}
                          </p>
                        </div>
                      ) : null}
                      {detail.analysis.result.evidence.length > 0 ? (
                        <div>
                          <div className="text-xs text-mist-400">根拠ログ</div>
                          <ul className="mt-1 space-y-1">
                            {detail.analysis.result.evidence.map(
                              (item, index) => (
                                <li
                                  key={`${item.logId ?? "log"}-${index}`}
                                  className="rounded border border-ink-700/60 bg-ink-900/60 px-2 py-1 font-mono text-xs text-mist-400"
                                >
                                  {item.logId ? (
                                    <span className="mr-1 text-signal-400">
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
                          <div className="text-xs text-mist-400">推奨対応</div>
                          <ul className="mt-1 space-y-1">
                            {detail.analysis.result.recommendedActions.map(
                              (action, index) => (
                                <li
                                  key={`${action.type}-${index}`}
                                  className="flex items-start justify-between gap-2 rounded border border-ink-700/60 bg-ink-900/60 px-2 py-1 text-xs"
                                >
                                  <span className="text-mist-200">
                                    <span className="font-mono text-signal-400">
                                      {action.type}
                                    </span>{" "}
                                    {action.target ?? ""} {action.detail ?? ""}
                                  </span>
                                  <span className="shrink-0 text-warn-400">
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
                    <p className="mt-2 text-xs text-mist-400">
                      AI
                      分析はまだありません。インシデント作成時に自動実行され、
                      未設定時はルールベースのレポートを生成します。
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                  <h3 className="text-xs font-semibold text-mist-400">
                    Response
                  </h3>
                  {canOperate && detail.status !== "resolved" ? (
                    <div className="mt-2 space-y-2">
                      <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        rows={2}
                        placeholder="対応メモ（任意）"
                        className="w-full rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-2 text-xs text-mist-200 focus:border-signal-400/50"
                      />
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act("ack")}
                          className="min-h-11 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-400/20 disabled:opacity-50 sm:min-h-10"
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
                          className="min-h-11 rounded-md border border-signal-400/40 bg-signal-400/10 px-3 py-1.5 text-xs font-medium text-signal-400 transition hover:bg-signal-400/20 disabled:opacity-50 sm:min-h-10"
                        >
                          Resolve
                        </button>
                        {detail.pendingApprovalId ? (
                          <Link
                            href="/approvals"
                            className="rounded-md border border-warn-400/40 bg-warn-400/10 px-3 py-1.5 text-xs font-medium text-warn-400 transition hover:bg-warn-400/20"
                          >
                            承認画面へ
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-mist-400">
                      {detail.status === "resolved"
                        ? "解決済みです。"
                        : "この操作には operator 以上の権限が必要です。"}
                    </p>
                  )}
                </div>

                <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                  <h3 className="text-xs font-semibold text-mist-400">
                    Approvals
                  </h3>
                  {detail.approvals.length === 0 ? (
                    <p className="mt-2 text-xs text-mist-400">
                      承認リクエストはありません。
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.approvals.map((approval) => (
                        <li
                          key={approval.id}
                          className="rounded border border-ink-700/60 bg-ink-900/60 px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-mist-200">
                              {approval.status}
                            </span>
                            <span className="text-xs text-mist-400">
                              {formatDate(approval.requestedAt)}
                            </span>
                          </div>
                          {approval.decidedBy ? (
                            <div className="mt-1 text-xs text-mist-400">
                              by {approval.decidedBy}
                            </div>
                          ) : null}
                          {approval.note ? (
                            <div className="mt-1 text-xs text-mist-400">
                              {approval.note}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                  <h3 className="text-xs font-semibold text-mist-400">
                    Actions
                  </h3>
                  {detail.actions.length === 0 ? (
                    <p className="mt-2 text-xs text-mist-400">
                      再起動アクションはありません。
                    </p>
                  ) : (
                    <ul className="mt-2 space-y-2">
                      {detail.actions.map((action) => (
                        <li
                          key={action.id}
                          className="rounded border border-ink-700/60 bg-ink-900/60 px-2.5 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-mist-200">
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
                          <div className="mt-1 text-xs text-mist-400">
                            {formatDate(action.startedAt)} →{" "}
                            {formatDate(action.finishedAt)}
                          </div>
                          {action.error ? (
                            <div className="mt-1 break-words text-xs text-danger-400">
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
            <div className="px-4 py-8 text-center text-sm text-mist-400">
              読み込み中…
            </div>
          )}
        </section>
      ) : null}

      {confirmDialog}
    </AppShell>
  );
}
