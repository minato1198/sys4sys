"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { NavLinks } from "../components/NavLinks";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

type IncidentSeverity = "info" | "warning" | "error" | "critical";

interface ReportIncident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: string;
  startedAt: string;
  serviceId: string;
  serviceName: string | null;
}

interface ReportListItem {
  id: string;
  incidentId: string;
  format: "markdown" | "json";
  body: string;
  createdAt: string;
  incident: ReportIncident | null;
}

interface AiAnalysis {
  id: string;
  provider: string;
  model: string;
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

interface ReportDetail extends ReportListItem {
  analysis: AiAnalysis | null;
}

interface ReportList {
  items: ReportListItem[];
  total: number;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
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

export default function ReportsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [items, setItems] = useState<ReportListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const response = await fetch("/api/reports?limit=100", {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`reports ${response.status}`);
    const body = (await response.json()) as ReportList;
    setItems(body.items);
    setTotal(body.total);
    setSelectedId((current) => {
      if (current && body.items.some((item) => item.id === current)) {
        return current;
      }
      return body.items[0]?.id ?? null;
    });
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const response = await fetch(`/api/reports/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`report ${response.status}`);
    setDetail((await response.json()) as ReportDetail);
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
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [loadDetail, loadList, selectedId]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const stats = useMemo(
    () => ({
      total,
      ai: items.filter((item) => item.incident?.severity === "critical").length,
      markdown: items.filter((item) => item.format === "markdown").length,
    }),
    [items, total],
  );

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg border border-signal-400/30 bg-signal-400/10">
            <span className="font-mono text-sm font-bold text-signal-400">
              s4s
            </span>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              Reports
            </h1>
            <p className="text-xs text-mist-400">
              AI 分析から生成された Markdown
              レポートを確認・ダウンロードします。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <NavLinks role={user?.role} />
          <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-3 py-1.5">
            <div className="text-right">
              <div className="text-xs text-mist-200">
                {user?.email ?? "認証確認中…"}
              </div>
              <div className="text-xs font-medium text-mist-400">
                {user?.role ?? ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded border border-ink-700 px-2 py-1 text-xs text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          {error}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-3 gap-3">
        {[
          { label: "Reports", value: stats.total, tone: "text-white" },
          { label: "Markdown", value: stats.markdown, tone: "text-signal-400" },
          {
            label: "Critical (recent)",
            value: stats.ai,
            tone: "text-danger-400",
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

      <div className="mt-6 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
        <section className="overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
          <div className="flex items-center justify-between border-b border-ink-700/70 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-white">レポート一覧</h2>
              <p className="text-xs text-mist-400">
                15 秒ごとに自動更新します。
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadList()}
              className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white"
            >
              更新
            </button>
          </div>
          <div className="scrollbar-thin max-h-[70vh] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-8 text-center text-sm text-mist-400">
                読み込み中…
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-mist-400">
                レポートはまだありません。インシデント作成時に自動生成されます。
              </div>
            ) : (
              <ul className="divide-y divide-ink-700/40">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(item.id)}
                      className={`w-full px-4 py-3 text-left transition ${
                        selectedId === item.id
                          ? "bg-ink-800/70"
                          : "hover:bg-ink-800/40"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-mist-200">
                            {item.incident?.title ?? item.incidentId}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-mist-400">
                            {item.incident?.serviceName ?? "unknown service"} ·{" "}
                            {formatDate(item.createdAt)}
                          </div>
                        </div>
                        {item.incident ? (
                          <span
                            className={`shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium ${severityBadge(
                              item.incident.severity,
                            )}`}
                          >
                            {item.incident.severity}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-mist-400">
                        {item.id}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-ink-700/70 bg-ink-900/50">
          {detail ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-white">
                    {detail.incident?.title ?? "レポート"}
                  </h2>
                  <p className="mt-0.5 font-mono text-xs text-mist-400">
                    {detail.id} · {formatDate(detail.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {detail.incident ? (
                    <Link
                      href={`/incidents?focus=${encodeURIComponent(
                        detail.incident.id,
                      )}`}
                      className="rounded border border-ink-700 px-2 py-1 text-xs text-mist-400 transition hover:border-signal-400/40 hover:text-white"
                    >
                      インシデント
                    </Link>
                  ) : null}
                  <a
                    href={`/api/reports/${encodeURIComponent(
                      detail.id,
                    )}/export?format=md`}
                    download
                    className="rounded border border-signal-400/30 bg-signal-400/10 px-2 py-1 text-xs font-medium text-signal-400 transition hover:bg-signal-400/20"
                  >
                    Markdown
                  </a>
                  <a
                    href={`/api/reports/${encodeURIComponent(
                      detail.id,
                    )}/export?format=json`}
                    download
                    className="rounded border border-ink-700 px-2 py-1 text-xs text-mist-400 transition hover:border-signal-400/40 hover:text-white"
                  >
                    JSON
                  </a>
                </div>
              </div>

              <div className="space-y-4 p-4">
                {detail.incident ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-mist-400">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-medium ${severityBadge(
                        detail.incident.severity,
                      )}`}
                    >
                      {detail.incident.severity}
                    </span>
                    <span className="rounded border border-ink-700 bg-ink-800/60 px-1.5 py-0.5">
                      {detail.incident.status}
                    </span>
                    <span>
                      {detail.incident.serviceName ?? detail.incident.serviceId}
                    </span>
                    <span>{formatDate(detail.incident.startedAt)}</span>
                  </div>
                ) : null}

                {detail.analysis ? (
                  <div className="rounded-lg border border-ink-700/70 bg-ink-950/40 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-medium text-mist-400">
                        AI summary
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-mist-400">
                        <span className="font-mono">
                          {detail.analysis.provider}
                        </span>
                        <span>{detail.analysis.model}</span>
                        <span>
                          confidence{" "}
                          {(detail.analysis.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-mist-200">
                      {detail.analysis.result.summary}
                    </p>
                    <p className="mt-2 text-xs leading-relaxed text-mist-400">
                      {detail.analysis.result.rootCauseHypothesis}
                    </p>
                  </div>
                ) : null}

                <div className="rounded-lg border border-ink-700/70 bg-ink-950/30 p-4">
                  <MarkdownPreview markdown={detail.body} />
                </div>
              </div>
            </>
          ) : (
            <div className="px-4 py-12 text-center text-sm text-mist-400">
              レポートを選択してください。
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
