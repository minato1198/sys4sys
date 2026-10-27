"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { AppShell } from "../components/AppShell";
import { useConfirmDialog } from "../components/ui/useConfirmDialog";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface Host {
  id: string;
  kind: "windows" | "wsl";
  name: string;
  distro: string | null;
  enabled: boolean;
}

interface Service {
  id: string;
  name: string;
  hostId: string;
  status: string;
}

interface LogEvent {
  id: string;
  hostId: string;
  serviceId: string;
  ts: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  stream: "stdout" | "stderr" | "file" | "eventlog";
  message: string;
  fields: Record<string, unknown> | null;
  fingerprint: string;
}

interface LogPage {
  items: LogEvent[];
  nextCursor: string | null;
}

interface LogSource {
  id: string;
  hostId: string;
  serviceId: string | null;
  type: "file" | "stdout" | "wsl_file" | "eventlog";
  config: { path?: string } & Record<string, unknown>;
  enabled: boolean;
  hostName: string | null;
  hostKind: "windows" | "wsl" | null;
  serviceName: string | null;
}

interface Problem {
  detail?: string;
}

interface Filters {
  hostId: string;
  serviceId: string;
  level: string;
  q: string;
}

const EMPTY_FILTERS: Filters = {
  hostId: "",
  serviceId: "",
  level: "",
  q: "",
};

const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("ja-JP", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("ja-JP", { hour12: false });
}

function levelTone(level: LogEvent["level"]): string {
  if (level === "fatal") return "bg-danger/20 text-danger";
  if (level === "error") return "text-danger";
  if (level === "warn") return "text-warning";
  if (level === "debug") return "text-fg-muted";
  return "text-info";
}

function buildQuery(filters: Filters, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (filters.hostId) params.set("hostId", filters.hostId);
  if (filters.serviceId) params.set("serviceId", filters.serviceId);
  if (filters.level) params.set("level", filters.level);
  if (filters.q.trim()) params.set("q", filters.q.trim());
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

export default function LogsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [live, setLive] = useState(true);
  const [connected, setConnected] = useState<"off" | "connecting" | "on">(
    "off",
  );
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [sources, setSources] = useState<LogSource[]>([]);
  const [sourceForm, setSourceForm] = useState({
    hostId: "",
    serviceId: "",
    type: "file" as "file" | "wsl_file",
    path: "",
  });
  const [sourceBusy, setSourceBusy] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  const initialUrlApplied = useRef(false);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const isAdmin = user?.role === "admin";

  const serviceMap = useMemo(
    () => new Map(services.map((service) => [service.id, service])),
    [services],
  );
  const hostMap = useMemo(
    () => new Map(hosts.map((host) => [host.id, host])),
    [hosts],
  );

  const serviceLabel = useCallback(
    (serviceId: string): string => {
      const service = serviceMap.get(serviceId);
      if (service) return service.name;
      if (serviceId.startsWith("host:")) return "host";
      return serviceId.slice(0, 8);
    },
    [serviceMap],
  );

  const loadMeta = useCallback(async () => {
    try {
      const [meResponse, hostsResponse, servicesResponse] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/hosts", { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
      ]);
      if (
        meResponse.status === 401 ||
        hostsResponse.status === 401 ||
        servicesResponse.status === 401
      ) {
        window.location.href = "/login";
        return;
      }
      if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
      if (!hostsResponse.ok) throw new Error(`hosts ${hostsResponse.status}`);
      if (!servicesResponse.ok) {
        throw new Error(`services ${servicesResponse.status}`);
      }

      const me = (await meResponse.json()) as AuthUser;
      const hostList = (await hostsResponse.json()) as Host[];
      const serviceList = (await servicesResponse.json()) as Service[];
      setUser(me);
      setHosts(hostList);
      setServices(serviceList);
      setSourceForm((current) => {
        if (current.hostId) return current;
        const candidate =
          hostList.find((host) => host.enabled && host.kind === "windows") ??
          hostList.find((host) => host.enabled) ??
          hostList[0];
        return candidate
          ? {
              ...current,
              hostId: candidate.id,
              type: candidate.kind === "wsl" ? "wsl_file" : "file",
            }
          : current;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const loadSources = useCallback(async () => {
    try {
      const response = await fetch("/api/logs/sources", {
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) return;
      setSources((await response.json()) as LogSource[]);
    } catch {
      // ソース一覧は補助情報
    }
  }, []);

  useEffect(() => {
    void loadMeta();
    void loadSources();
  }, [loadMeta, loadSources]);

  useEffect(() => {
    if (initialUrlApplied.current) return;
    initialUrlApplied.current = true;
    const params = new URLSearchParams(window.location.search);
    const next: Filters = {
      hostId: params.get("hostId") ?? "",
      serviceId: params.get("serviceId") ?? "",
      level: params.get("level") ?? "",
      q: params.get("q") ?? "",
    };
    if (next.hostId || next.serviceId || next.level || next.q) {
      setDraft(next);
      setApplied(next);
    }
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = buildQuery(applied, { limit: "200" });
      const response = await fetch(`/api/logs?${query}`, {
        cache: "no-store",
      });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `ログの取得に失敗しました (${response.status})`,
        );
      }
      const page = (await response.json()) as LogPage;
      seenIds.current = new Set(page.items.map((item) => item.id));
      setLogs(page.items);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [applied]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const query = buildQuery(applied, {
        limit: "200",
        cursor: nextCursor,
      });
      const response = await fetch(`/api/logs?${query}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`logs ${response.status}`);
      const page = (await response.json()) as LogPage;
      const fresh = page.items.filter((item) => !seenIds.current.has(item.id));
      for (const item of fresh) seenIds.current.add(item.id);
      setLogs((current) => [...current, ...fresh]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  }, [applied, loadingMore, nextCursor]);

  useEffect(() => {
    if (!live) {
      setConnected("off");
      return;
    }
    const query = buildQuery(applied);
    setConnected("connecting");
    const source = new EventSource(
      `/api/logs/stream${query ? `?${query}` : ""}`,
    );

    source.onopen = () => setConnected("on");
    source.onerror = () => setConnected("connecting");
    source.addEventListener("log", (event) => {
      try {
        const log = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as LogEvent;
        if (seenIds.current.has(log.id)) return;
        seenIds.current.add(log.id);
        setLogs((current) => [log, ...current].slice(0, 500));
      } catch {
        // 壊れたイベントは無視する
      }
    });

    return () => {
      source.close();
      setConnected("off");
    };
  }, [applied, live]);

  function applyFilters(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setApplied({
      hostId: draft.hostId,
      serviceId: draft.serviceId,
      level: draft.level,
      q: draft.q.trim(),
    });
  }

  function clearFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    seenIds.current = new Set();
    setLogs([]);
    setNextCursor(null);
  }

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSourceBusy(true);
    setMessage(null);
    try {
      if (!sourceForm.hostId) throw new Error("ホストを選択してください");
      if (!sourceForm.path.trim()) {
        throw new Error("ログファイルのパスを入力してください");
      }
      const response = await fetch("/api/logs/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hostId: sourceForm.hostId,
          serviceId: sourceForm.serviceId || undefined,
          type: sourceForm.type,
          config: { path: sourceForm.path.trim() },
          enabled: true,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `登録に失敗しました (${response.status})`,
        );
      }
      setMessage("ログソースを登録しました。末尾から tail を開始します");
      setSourceForm((current) => ({ ...current, path: "" }));
      await loadSources();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSourceBusy(false);
    }
  }

  async function toggleSource(source: LogSource) {
    setSourceBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/logs/sources/${encodeURIComponent(source.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: !source.enabled }),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `更新に失敗しました (${response.status})`,
        );
      }
      await loadSources();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSourceBusy(false);
    }
  }

  async function deleteSource(source: LogSource): Promise<string | null> {
    setSourceBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/logs/sources/${encodeURIComponent(source.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `削除に失敗しました (${response.status})`,
        );
      }
      await loadSources();
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(text);
      return text;
    } finally {
      setSourceBusy(false);
    }
  }

  function onSourceHostChange(hostId: string) {
    const host = hostMap.get(hostId);
    setSourceForm((current) => ({
      ...current,
      hostId,
      type: host?.kind === "wsl" ? "wsl_file" : "file",
    }));
  }

  return (
    <AppShell
      title="Logs"
      description="stdout / stderr / ファイル / WSL ファイルを横断して検索・tail します。"
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

      <form
        onSubmit={applyFilters}
        className="mt-6 rounded-xl border border-border bg-surface p-4"
      >
        <div className="grid gap-3 md:grid-cols-5">
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">Host</span>
            <select
              value={draft.hostId}
              onChange={(event) =>
                setDraft({ ...draft, hostId: event.target.value })
              }
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
            >
              <option value="">すべて</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.kind.toUpperCase()} / {host.name}
                  {host.distro ? ` (${host.distro})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">Service</span>
            <select
              value={draft.serviceId}
              onChange={(event) =>
                setDraft({ ...draft, serviceId: event.target.value })
              }
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
            >
              <option value="">すべて</option>
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-fg-muted">Level</span>
            <select
              value={draft.level}
              onChange={(event) =>
                setDraft({ ...draft, level: event.target.value })
              }
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
            >
              <option value="">すべて</option>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-xs text-fg-muted">Search</span>
            <input
              value={draft.q}
              onChange={(event) =>
                setDraft({ ...draft, q: event.target.value })
              }
              placeholder="message を部分一致で検索"
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
            />
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-success-fg transition hover:bg-success/90"
          >
            適用
          </button>
          <button
            type="button"
            onClick={clearFilters}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-fg transition hover:border-success/40 hover:text-fg"
          >
            クリア
          </button>
          <label className="ml-2 flex items-center gap-2 text-xs text-fg">
            <input
              type="checkbox"
              checked={live}
              onChange={(event) => setLive(event.target.checked)}
              className="accent-success"
            />
            Live tail (SSE)
          </label>
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
              connected === "on"
                ? "border-success/30 bg-success/10 text-success"
                : connected === "connecting"
                  ? "border-warning/30 bg-warning/10 text-warning"
                  : "border-border bg-surface-muted text-fg-muted"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                connected === "on"
                  ? "bg-success"
                  : connected === "connecting"
                    ? "bg-warning"
                    : "bg-mist-400"
              }`}
            />
            {connected === "on"
              ? "live"
              : connected === "connecting"
                ? "reconnecting"
                : "paused"}
          </span>
        </div>
      </form>

      <section className="mt-4 overflow-hidden rounded-xl border border-border bg-surface-muted">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-fg">Stream</h2>
            <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-xs text-fg-muted">
              {logs.length}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {loading ? (
              <span className="text-xs text-fg-muted">読み込み中…</span>
            ) : null}
            <button
              type="button"
              onClick={() => {
                seenIds.current = new Set();
                setLogs([]);
              }}
              className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              表示をクリア
            </button>
          </div>
        </div>

        <div className="scrollbar-thin max-h-[52vh] min-h-72 overflow-y-auto">
          {logs.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-fg-muted">
              {loading
                ? "ログを読み込んでいます…"
                : "条件に一致するログはありません"}
            </div>
          ) : (
            logs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-3 border-b border-border px-3 py-1.5 font-mono text-xs last:border-b-0 hover:bg-surface"
              >
                <span
                  className="w-14 shrink-0 pt-0.5 text-xs text-fg-muted"
                  title={formatFullTime(log.ts)}
                >
                  {formatTime(log.ts)}
                </span>
                <span
                  className={`w-11 shrink-0 pt-0.5 text-xs font-semibold ${levelTone(log.level)}`}
                >
                  {log.level}
                </span>
                <span className="hidden w-24 shrink-0 truncate pt-0.5 text-xs text-fg-muted sm:block">
                  {serviceLabel(log.serviceId)}
                </span>
                <span className="hidden w-12 shrink-0 pt-0.5 text-xs text-fg-muted md:block">
                  {log.stream}
                </span>
                <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-0.5 text-fg">
                  {log.message}
                </pre>
              </div>
            ))
          )}
        </div>

        {nextCursor ? (
          <div className="border-t border-border px-4 py-2 text-center">
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              className="rounded border border-border px-3 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg disabled:opacity-50"
            >
              {loadingMore ? "読み込み中…" : "さらに古いログを読み込む"}
            </button>
          </div>
        ) : null}
      </section>

      <details className="group mt-6 rounded-xl border border-border bg-surface">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">ログソース</h2>
            <p className="mt-0.5 text-xs text-fg-muted">
              ファイル / WSL ファイルを tail して取り込みます。stdout / stderr
              はサービス起動時に自動収集されます。
            </p>
          </div>
          <span className="rounded bg-surface-muted px-2 py-0.5 font-mono text-xs text-fg-muted">
            {sources.length}
          </span>
        </summary>

        <div className="border-t border-border p-4">
          <div className="space-y-1.5">
            {sources.length === 0 ? (
              <p className="text-xs text-fg-muted">
                登録されたファイルログソースはありません。
              </p>
            ) : (
              sources.map((source) => (
                <div
                  key={source.id}
                  className="flex flex-wrap items-center gap-2 rounded border border-border bg-surface-muted px-2.5 py-2 text-xs"
                >
                  <span className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-fg-muted">
                    {source.type}
                  </span>
                  <span className="text-fg">
                    {source.hostName ?? source.hostId}
                  </span>
                  <span className="text-fg-muted">
                    {source.serviceName ?? "host level"}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-fg-muted">
                    {String(source.config.path ?? "")}
                  </code>
                  <span
                    className={`text-xs ${
                      source.enabled ? "text-success" : "text-fg-muted"
                    }`}
                  >
                    {source.enabled ? "enabled" : "disabled"}
                  </span>
                  {isAdmin ? (
                    <>
                      <button
                        type="button"
                        disabled={sourceBusy}
                        onClick={() => void toggleSource(source)}
                        className="rounded border border-border px-2 py-0.5 text-xs text-fg hover:border-success/40 hover:text-fg disabled:opacity-50"
                      >
                        {source.enabled ? "停止" : "有効化"}
                      </button>
                      <button
                        type="button"
                        disabled={sourceBusy}
                        onClick={() =>
                          requestConfirm(
                            {
                              title: "ログソースを削除しますか？",
                              description:
                                "監視対象からログソースを外します。設定は失われます。",
                              target: (
                                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                  <dt className="text-fg-muted">Host</dt>
                                  <dd>{source.hostName ?? "—"}</dd>
                                  <dt className="text-fg-muted">Service</dt>
                                  <dd>{source.serviceName ?? "—"}</dd>
                                  <dt className="text-fg-muted">Type</dt>
                                  <dd>{source.type}</dd>
                                  <dt className="text-fg-muted">Path</dt>
                                  <dd className="break-all font-mono">
                                    {String(source.config.path ?? "—")}
                                  </dd>
                                </dl>
                              ),
                              impact:
                                "すでに取得済みのログ履歴には影響しませんが、以後このソースは収集されません。",
                              confirmLabel: "削除",
                            },
                            () => deleteSource(source),
                          )
                        }
                        className="min-h-9 rounded border border-danger/20 px-2.5 py-1 text-xs text-danger hover:border-danger/50 hover:text-danger disabled:opacity-50"
                      >
                        削除
                      </button>
                    </>
                  ) : null}
                </div>
              ))
            )}
          </div>

          {isAdmin ? (
            <form
              onSubmit={submitSource}
              className="mt-4 grid gap-2 rounded-lg border border-border bg-surface-muted p-3 md:grid-cols-6"
            >
              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-fg-muted">Host</span>
                <select
                  value={sourceForm.hostId}
                  onChange={(event) => onSourceHostChange(event.target.value)}
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
                >
                  <option value="">選択</option>
                  {hosts.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.kind.toUpperCase()} / {host.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-fg-muted">
                  Service (optional)
                </span>
                <select
                  value={sourceForm.serviceId}
                  onChange={(event) =>
                    setSourceForm({
                      ...sourceForm,
                      serviceId: event.target.value,
                    })
                  }
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
                >
                  <option value="">host level</option>
                  {services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">Type</span>
                <select
                  value={sourceForm.type}
                  onChange={(event) =>
                    setSourceForm({
                      ...sourceForm,
                      type: event.target.value as "file" | "wsl_file",
                    })
                  }
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
                >
                  <option value="file">file</option>
                  <option value="wsl_file">wsl_file</option>
                </select>
              </label>
              <label className="block md:col-span-4">
                <span className="mb-1 block text-xs text-fg-muted">Path</span>
                <input
                  value={sourceForm.path}
                  onChange={(event) =>
                    setSourceForm({ ...sourceForm, path: event.target.value })
                  }
                  placeholder="C:\dev\app\logs\app.log / /home/me/app/app.log"
                  className="w-full rounded border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <div className="flex items-end md:col-span-2">
                <button
                  type="submit"
                  disabled={sourceBusy}
                  className="w-full rounded-md bg-success px-3 py-1.5 text-xs font-semibold text-success-fg transition hover:bg-success/90 disabled:opacity-50"
                >
                  {sourceBusy ? "処理中…" : "ソースを追加"}
                </button>
              </div>
            </form>
          ) : (
            <p className="mt-3 text-xs text-fg-muted">
              ログソースの追加・変更は管理者のみ実行できます。
            </p>
          )}
        </div>
      </details>

      {confirmDialog}
    </AppShell>
  );
}
