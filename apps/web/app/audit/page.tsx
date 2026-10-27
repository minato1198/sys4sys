"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface AuditLog {
  id: string;
  actorUserId: string | null;
  actorLabel: string;
  action: string;
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  ip: string | null;
  ts: string;
}

interface AuditList {
  items: AuditLog[];
  total: number;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function formatJson(value: Record<string, unknown> | null): string {
  if (!value || Object.keys(value).length === 0) return "—";
  return JSON.stringify(value, null, 2);
}

function actionTone(action: string): string {
  if (action.includes("backup")) return "text-signal-400";
  if (action.includes("update") || action.includes("create"))
    return "text-sky-300";
  if (action.includes("delete") || action.includes("kill"))
    return "text-danger-400";
  return "text-mist-200";
}

export default function AuditPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [items, setItems] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("");
  const [target, setTarget] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (action.trim()) params.set("action", action.trim());
    if (target.trim()) params.set("target", target.trim());
    if (actor.trim()) params.set("actor", actor.trim());
    if (from) params.set("from", new Date(from).toISOString());
    if (to) params.set("to", new Date(to).toISOString());
    const response = await fetch(`/api/audit-logs?${params.toString()}`, {
      cache: "no-store",
    });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (response.status === 403) {
      setError("監査ログの表示には admin 権限が必要です");
      setItems([]);
      setTotal(0);
      return;
    }
    if (!response.ok) throw new Error(`audit logs ${response.status}`);
    const body = (await response.json()) as AuditList;
    setItems(body.items);
    setTotal(body.total);
    setError(null);
  }, [action, actor, from, target, to]);

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
  }, []);

  useEffect(() => {
    if (!user) return;
    void load().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [user]); // load はフィルタ変更時に「更新」または自動更新で実行する

  useEffect(() => {
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const summary = useMemo(
    () => ({
      total,
      backups: items.filter((item) => item.action.includes("backup")).length,
      settings: items.filter((item) => item.action.startsWith("settings."))
        .length,
    }),
    [items, total],
  );

  return (
    <AppShell
      title="Audit log"
      description="設定変更、承認、再起動、バックアップなどの操作履歴を確認します。"
      user={user}
    >
      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          {error}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-3 gap-3">
        {[
          { label: "Entries", value: summary.total, tone: "text-white" },
          {
            label: "Settings changes",
            value: summary.settings,
            tone: "text-warn-400",
          },
          {
            label: "Backups",
            value: summary.backups,
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
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">操作履歴</h2>
            <p className="text-xs text-mist-400">
              最新 200 件を表示します。20 秒ごとに自動更新します。
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block text-xs text-mist-400">Action</span>
              <input
                value={action}
                onChange={(event) => setAction(event.target.value)}
                placeholder="settings.ai.update"
                className="mt-1 w-44 rounded-md border border-ink-700 bg-ink-800/80 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-mist-400">Target</span>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="incident:..."
                className="mt-1 w-40 rounded-md border border-ink-700 bg-ink-800/80 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-mist-400">Actor</span>
              <input
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                placeholder="admin@..."
                className="mt-1 w-40 rounded-md border border-ink-700 bg-ink-800/80 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-mist-400">From</span>
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 rounded-md border border-ink-700 bg-ink-800/80 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-mist-400">To</span>
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1 rounded-md border border-ink-700 bg-ink-800/80 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/50"
              />
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white"
            >
              更新
            </button>
            <button
              type="button"
              onClick={() => {
                setAction("");
                setTarget("");
                setActor("");
                setFrom("");
                setTo("");
              }}
              className="rounded-md border border-ink-700 px-3 py-1.5 text-xs text-mist-400 transition hover:border-signal-400/40 hover:text-white"
            >
              クリア
            </button>
          </div>
        </div>

        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-700/70 bg-ink-950/40 text-xs text-mist-400">
                <th scope="col" className="px-4 py-2 font-medium">
                  Time
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Target
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Reason
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  IP
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
                    条件に一致する監査ログはありません
                  </td>
                </tr>
              ) : (
                items.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-mist-200">
                      {formatDate(entry.ts)}
                    </td>
                    <td className="px-4 py-2 text-xs text-mist-200">
                      {entry.actorLabel}
                      {entry.actorUserId ? (
                        <div className="font-mono text-xs text-mist-400">
                          {entry.actorUserId}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`font-mono text-xs ${actionTone(entry.action)}`}
                      >
                        {entry.action}
                      </span>
                    </td>
                    <td className="max-w-64 break-all px-4 py-2 font-mono text-xs text-mist-200">
                      {entry.target}
                    </td>
                    <td className="max-w-56 break-words px-4 py-2 text-xs text-mist-400">
                      {entry.reason ?? "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-mist-400">
                      {entry.ip ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {items.length > 0 ? (
          <details className="border-t border-ink-700/70 px-4 py-3">
            <summary className="cursor-pointer text-xs text-mist-400">
              変更前後の JSON を表示
            </summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {items.slice(0, 20).map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border border-ink-700/60 bg-ink-950/40 p-2"
                >
                  <div className="font-mono text-xs text-mist-400">
                    {entry.action} · {formatDate(entry.ts)}
                  </div>
                  <div className="mt-2 grid gap-2">
                    <div>
                      <div className="text-xs text-mist-400">before</div>
                      <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-mist-400">
                        {formatJson(entry.before)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs text-mist-400">after</div>
                      <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-mist-400">
                        {formatJson(entry.after)}
                      </pre>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </AppShell>
  );
}
