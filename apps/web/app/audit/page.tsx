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
  if (action.includes("backup")) return "text-success";
  if (action.includes("update") || action.includes("create"))
    return "text-info";
  if (action.includes("delete") || action.includes("kill"))
    return "text-danger";
  return "text-fg";
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
      title="監査ログ"
      description="設定変更、承認、再起動、バックアップなどの操作履歴を確認します。"
      user={user}
    >
      {error ? (
        <div className="mt-6 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-3 gap-3">
        {[
          { label: "Entries", value: summary.total, tone: "text-fg" },
          {
            label: "Settings changes",
            value: summary.settings,
            tone: "text-warning",
          },
          {
            label: "Backups",
            value: summary.backups,
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
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">操作履歴</h2>
            <p className="text-xs text-fg-muted">
              最新 200 件を表示します。20 秒ごとに自動更新します。
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="block text-xs text-fg-muted">Action</span>
              <input
                value={action}
                onChange={(event) => setAction(event.target.value)}
                placeholder="settings.ai.update"
                className="mt-1 w-44 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs text-fg focus:border-success/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted">Target</span>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                placeholder="incident:..."
                className="mt-1 w-40 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs text-fg focus:border-success/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted">Actor</span>
              <input
                value={actor}
                onChange={(event) => setActor(event.target.value)}
                placeholder="admin@..."
                className="mt-1 w-40 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs text-fg focus:border-success/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted">From</span>
              <input
                type="datetime-local"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="mt-1 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs text-fg focus:border-success/50"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-fg-muted">To</span>
              <input
                type="datetime-local"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="mt-1 rounded-md border border-border bg-surface-muted px-2 py-1.5 text-xs text-fg focus:border-success/50"
              />
            </label>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg"
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
              className="rounded-md border border-border px-3 py-1.5 text-xs text-fg-muted transition hover:border-success/40 hover:text-fg"
            >
              クリア
            </button>
          </div>
        </div>

        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
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
                    条件に一致する監査ログはありません
                  </td>
                </tr>
              ) : (
                items.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-fg">
                      {formatDate(entry.ts)}
                    </td>
                    <td className="px-4 py-2 text-xs text-fg">
                      {entry.actorLabel}
                      {entry.actorUserId ? (
                        <div className="font-mono text-xs text-fg-muted">
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
                    <td className="max-w-64 break-all px-4 py-2 font-mono text-xs text-fg">
                      {entry.target}
                    </td>
                    <td className="max-w-56 break-words px-4 py-2 text-xs text-fg-muted">
                      {entry.reason ?? "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                      {entry.ip ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {items.length > 0 ? (
          <details className="border-t border-border px-4 py-3">
            <summary className="cursor-pointer text-xs text-fg-muted">
              変更前後の JSON を表示
            </summary>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {items.slice(0, 20).map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-lg border border-border bg-surface-muted p-2"
                >
                  <div className="font-mono text-xs text-fg-muted">
                    {entry.action} · {formatDate(entry.ts)}
                  </div>
                  <div className="mt-2 grid gap-2">
                    <div>
                      <div className="text-xs text-fg-muted">before</div>
                      <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-muted">
                        {formatJson(entry.before)}
                      </pre>
                    </div>
                    <div>
                      <div className="text-xs text-fg-muted">after</div>
                      <pre className="scrollbar-thin mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-fg-muted">
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
