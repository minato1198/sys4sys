"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { NavLinks } from "./components/NavLinks";

interface ReservationView {
  id: string;
  scope: "windows" | "wsl";
  protocol: "tcp" | "udp";
  port: number;
  serviceId: string;
  note: string | null;
  createdAt: string;
  status: "reserved" | "conflict";
  inUse: boolean;
}

interface PortOwner {
  pid: number | null;
  pidScope: string | null;
  ppid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  startedAt: string | null;
  likelyWslForward: boolean;
}

interface PortItem {
  id: string;
  scope: "windows" | "wsl";
  pidScope: string | null;
  seenIn: string[];
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number | null;
  ppid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  startedAt: string | null;
  likelyWslForward: boolean;
  owners?: PortOwner[];
  ownerCount?: number;
  serviceId: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  reservation: ReservationView | null;
  conflict: boolean;
  status: "in_use" | "conflict";
}

interface PortsResponse {
  scannedAt: string;
  items: PortItem[];
  reservations: ReservationView[];
  conflicts: ReservationView[];
  skipped: Array<{ distro: string; error: string }>;
  distros: Array<{
    name: string;
    state: string;
    version: number;
    isDefault: boolean;
  }>;
}

interface HistoryEntry {
  id: string;
  scope: "windows" | "wsl";
  pidScope: string | null;
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number | null;
  ppid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  startedAt: string | null;
  serviceId: string | null;
  openedAt: string;
  closedAt: string | null;
  releasedBy: string | null;
}

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

interface OpsIncident {
  id: string;
  title: string;
  severity: "info" | "warning" | "error" | "critical";
  status: string;
  startedAt: string;
  service: { name: string } | null;
}

interface OpsSummary {
  openIncidents: number;
  pendingApprovals: number;
  incidents: OpsIncident[];
}

interface Problem {
  detail?: string;
}

const EMPTY_FORM = {
  scope: "windows" as "windows" | "wsl",
  protocol: "tcp" as "tcp" | "udp",
  port: "",
  serviceId: "",
  note: "",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint: string;
  tone?: "default" | "good" | "warn" | "danger";
}) {
  const valueTone =
    tone === "good"
      ? "text-signal-400"
      : tone === "warn"
        ? "text-warn-400"
        : tone === "danger"
          ? "text-danger-400"
          : "text-white";
  return (
    <div className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-mist-400">
        {label}
      </div>
      <div className={`mt-2 font-mono text-2xl tabular-nums ${valueTone}`}>
        {value}
      </div>
      <div className="mt-1 text-xs text-mist-400">{hint}</div>
    </div>
  );
}

function ScopeBadge({ item }: { item: PortItem }) {
  if (item.scope === "windows") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
        WIN
        {item.likelyWslForward ? (
          <span className="rounded bg-warn-400/15 px-1 text-[10px] text-warn-400">
            WSL relay
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-signal-400/20 bg-signal-400/10 px-2 py-0.5 text-[11px] font-medium text-signal-400">
      WSL
      {item.pidScope ? (
        <span className="text-[10px] text-mist-400">{item.pidScope}</span>
      ) : null}
    </span>
  );
}

function ReservationBadge({
  reservation,
}: {
  reservation: ReservationView | null;
}) {
  if (!reservation) {
    return <span className="text-[11px] text-mist-400">—</span>;
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="font-mono text-[11px] text-mist-200">
        {reservation.serviceId}
      </span>
      <span
        className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-medium ${
          reservation.status === "conflict"
            ? "bg-danger-400/15 text-danger-400"
            : "bg-signal-400/15 text-signal-400"
        }`}
      >
        {reservation.status === "conflict" ? "競合" : "予約済み"}
      </span>
    </span>
  );
}

function fallbackPortOwner(item: PortItem): PortOwner {
  return {
    pid: item.pid,
    pidScope: item.pidScope,
    ppid: item.ppid,
    process: item.process,
    processPath: item.processPath,
    commandLine: item.commandLine,
    startedAt: item.startedAt,
    likelyWslForward: item.likelyWslForward,
  };
}

function portOwnersForItem(item: PortItem): PortOwner[] {
  if (item.owners?.length) return item.owners;
  return [fallbackPortOwner(item)];
}

function primaryPortOwner(item: PortItem): PortOwner {
  return portOwnersForItem(item)[0] ?? fallbackPortOwner(item);
}

function killablePortOwners(item: PortItem): PortOwner[] {
  return portOwnersForItem(item).filter(
    (owner) => owner.pid !== null && owner.pid > 4,
  );
}

function portOwnerKey(item: PortItem, owner: PortOwner): string {
  return [
    item.id,
    owner.pidScope ?? "-",
    owner.pid ?? "-",
    owner.process ?? "-",
    owner.processPath ?? "-",
    owner.commandLine ?? "-",
    owner.startedAt ?? "-",
  ].join("|");
}

export default function DashboardPage() {
  const [data, setData] = useState<PortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [reservationError, setReservationError] = useState<string | null>(null);
  const [submittingReservation, setSubmittingReservation] = useState(false);
  const [busyReservationId, setBusyReservationId] = useState<string | null>(
    null,
  );
  const [killBusyKey, setKillBusyKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [historyFor, setHistoryFor] = useState<PortItem | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [ops, setOps] = useState<OpsSummary>({
    openIncidents: 0,
    pendingApprovals: 0,
    incidents: [],
  });

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ports", { cache: "no-store" });
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) throw new Error(`API ${response.status}`);
      const json = (await response.json()) as PortsResponse;
      setData(json);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.href = "/login";
          return null;
        }
        if (!response.ok) throw new Error(`auth ${response.status}`);
        return (await response.json()) as AuthUser;
      })
      .then((me) => {
        if (!cancelled && me) setUser(me);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const loadOps = useCallback(async () => {
    try {
      const [incidentResponse, approvalResponse] = await Promise.all([
        fetch("/api/incidents?status=open&limit=5", { cache: "no-store" }),
        fetch("/api/approvals?status=pending&limit=1", { cache: "no-store" }),
      ]);
      if (incidentResponse.status === 401 || approvalResponse.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!incidentResponse.ok || !approvalResponse.ok) return;
      const incidents = (await incidentResponse.json()) as {
        items: OpsIncident[];
        total: number;
      };
      const approvals = (await approvalResponse.json()) as { total: number };
      setOps({
        openIncidents: incidents.total,
        pendingApprovals: approvals.total,
        incidents: incidents.items,
      });
    } catch {
      // ポート画面の主要エラーとは分離する。
    }
  }, []);

  useEffect(() => {
    void load();
    void loadOps();
    const timer = setInterval(() => {
      void load();
      void loadOps();
    }, 10_000);
    return () => clearInterval(timer);
  }, [load, loadOps]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function createReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReservationError(null);
    setMessage(null);
    setSubmittingReservation(true);

    try {
      const port = Number(form.port);
      const response = await fetch("/api/ports/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: form.scope,
          protocol: form.protocol,
          port,
          serviceId: form.serviceId.trim(),
          note: form.note.trim() || undefined,
        }),
      });
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `予約に失敗しました (${response.status})`,
        );
      }
      const reservation = (await response.json()) as ReservationView;
      setMessage(
        `${reservation.protocol.toUpperCase()} ${reservation.port} を ${reservation.serviceId} 用に予約しました`,
      );
      setForm(EMPTY_FORM);
      await load();
    } catch (cause) {
      setReservationError(
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      setSubmittingReservation(false);
    }
  }

  async function deleteReservation(reservation: ReservationView) {
    if (
      !window.confirm(
        `${reservation.protocol.toUpperCase()} ${reservation.port} (${reservation.serviceId}) の予約を解除しますか？`,
      )
    ) {
      return;
    }
    setBusyReservationId(reservation.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/ports/reserve/${encodeURIComponent(reservation.id)}`,
        { method: "DELETE" },
      );
      if (!response.ok && response.status !== 204) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `予約解除に失敗しました (${response.status})`,
        );
      }
      setMessage(
        `${reservation.protocol.toUpperCase()} ${reservation.port} の予約を解除しました`,
      );
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyReservationId(null);
    }
  }

  async function openHistory(item: PortItem) {
    setHistoryFor(item);
    setHistoryLoading(true);
    setHistory([]);
    try {
      const params = new URLSearchParams({
        scope: item.scope,
        port: String(item.port),
        protocol: item.protocol,
      });
      const response = await fetch(`/api/ports/history?${params}`, {
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(`履歴の取得に失敗しました (${response.status})`);
      setHistory((await response.json()) as HistoryEntry[]);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function killOwner(endpoint: PortItem, owner: PortOwner) {
    const pid = owner.pid ?? endpoint.pid;
    if (pid === null || pid <= 4 || killBusyKey) return;

    const pidScope = owner.pidScope ?? endpoint.pidScope;
    const processName = owner.process ?? endpoint.process ?? "unknown";
    if (
      !window.confirm(
        `PID ${pid} (${processName}) を停止しますか？\n対象: ${endpoint.protocol.toUpperCase()} ${endpoint.port}`,
      )
    ) {
      return;
    }

    const busyKey = portOwnerKey(endpoint, owner);
    setKillBusyKey(busyKey);
    setMessage(null);
    try {
      const tokenParams = new URLSearchParams({
        scope: endpoint.scope,
        pid: String(pid),
      });
      if (pidScope) tokenParams.set("pidScope", pidScope);

      const tokenResponse = await fetch(
        `/api/ports/${endpoint.port}/kill-token?${tokenParams}`,
        { cache: "no-store" },
      );
      if (!tokenResponse.ok) {
        const problem = (await tokenResponse
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ??
            `確認トークンを取得できませんでした (${tokenResponse.status})`,
        );
      }
      const token = (await tokenResponse.json()) as {
        token: string;
      };

      const response = await fetch(`/api/ports/${endpoint.port}/kill`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scope: endpoint.scope,
          pidScope: pidScope,
          confirmToken: token.token,
          signal: "KILL",
          force: true,
        }),
      });
      if (response.status !== 202) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `停止に失敗しました (${response.status})`,
        );
      }
      setMessage(`PID ${pid} (${processName}) に停止シグナルを送信しました`);
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setKillBusyKey(null);
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canOperate = user?.role === "admin" || user?.role === "operator";

  const items = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!data) return [];
    if (!needle) return data.items;
    return data.items.filter((item) => {
      const values = [
        item.process,
        item.commandLine,
        item.address,
        String(item.port),
        item.pidScope,
        item.reservation?.serviceId,
        ...portOwnersForItem(item).flatMap((owner) => [
          owner.process,
          owner.commandLine,
          owner.pidScope,
        ]),
      ];
      return values
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle));
    });
  }, [data, filter]);

  const wslCount =
    data?.items.filter((item) => item.scope === "wsl").length ?? 0;
  const relayCount =
    data?.items.filter((item) => item.likelyWslForward).length ?? 0;
  const reservationCount = data?.reservations.length ?? 0;
  const conflictCount = data?.conflicts.length ?? 0;
  const scannedAt = data
    ? new Date(data.scannedAt).toLocaleTimeString("ja-JP", { hour12: false })
    : "—";

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
              sys4sys
            </h1>
            <p className="text-xs text-mist-400">
              backend operations / ports · services · incidents
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <NavLinks role={user?.role} />
          <span className="flex items-center gap-2 text-xs text-mist-400">
            <span
              className={`size-1.5 rounded-full ${error ? "bg-danger-400" : "bg-signal-400"} ${
                error ? "" : "animate-pulse"
              }`}
            />
            {error ? "API 接続エラー" : `最終スキャン ${scannedAt}`}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-mist-400/40 hover:text-white"
          >
            再スキャン
          </button>
          <div className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-800/60 px-3 py-1.5">
            <div className="text-right">
              <div className="text-xs text-mist-200">
                {user?.email ?? "認証確認中…"}
              </div>
              <div className="text-[9px] font-medium uppercase tracking-[0.14em] text-mist-400">
                {user?.role ?? ""}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded border border-ink-700 px-2 py-1 text-[11px] text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400"
            >
              ログアウト
            </button>
          </div>
        </div>
      </header>

      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          API に接続できません（{error}）。`pnpm dev:api`
          が起動しているか確認してください。
        </div>
      ) : null}

      {message ? (
        <div className="mt-6 rounded-lg border border-signal-400/30 bg-signal-400/10 px-4 py-3 text-sm text-signal-400">
          {message}
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Listening ports"
          value={data?.items.length ?? "—"}
          hint="TCP + UDP / 全ホスト"
        />
        <StatCard
          label="Reservations"
          value={reservationCount}
          hint="予約済みエンドポイント"
          tone="good"
        />
        <StatCard
          label="Conflicts"
          value={conflictCount}
          hint="予約と実リスナーの競合"
          tone={conflictCount > 0 ? "danger" : "default"}
        />
        <StatCard
          label="WSL relay"
          value={relayCount}
          hint={`WSL ${wslCount} ports / 10s polling`}
          tone="warn"
        />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Open incidents
              </h2>
              <p className="text-[11px] text-mist-400">
                未解決の監視インシデント
              </p>
            </div>
            <Link
              href="/incidents"
              className="rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-1 text-[11px] text-mist-200 transition hover:border-signal-400/40 hover:text-white"
            >
              開く
            </Link>
          </div>
          <div
            className={`mt-3 font-mono text-3xl tabular-nums ${
              ops.openIncidents > 0 ? "text-danger-400" : "text-signal-400"
            }`}
          >
            {ops.openIncidents}
          </div>
          {ops.incidents.length === 0 ? (
            <p className="mt-2 text-xs text-mist-400">
              アクティブなインシデントはありません。
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {ops.incidents.slice(0, 3).map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/incidents?focus=${encodeURIComponent(incident.id)}`}
                    className="flex items-start justify-between gap-3 rounded border border-ink-700/60 bg-ink-950/30 px-2.5 py-2 transition hover:border-danger-400/30"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-mist-200">
                        {incident.title}
                      </span>
                      <span className="mt-0.5 block text-[10px] text-mist-400">
                        {incident.service?.name ?? "—"} /{" "}
                        {formatDate(incident.startedAt)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-[10px] font-medium uppercase ${
                        incident.severity === "critical" ||
                        incident.severity === "error"
                          ? "text-danger-400"
                          : incident.severity === "warning"
                            ? "text-warn-400"
                            : "text-mist-400"
                      }`}
                    >
                      {incident.severity}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                Pending approvals
              </h2>
              <p className="text-[11px] text-mist-400">
                承認待ちの再起動リクエスト
              </p>
            </div>
            <Link
              href="/approvals"
              className="rounded-md border border-ink-700 bg-ink-800/80 px-2.5 py-1 text-[11px] text-mist-200 transition hover:border-signal-400/40 hover:text-white"
            >
              開く
            </Link>
          </div>
          <div
            className={`mt-3 font-mono text-3xl tabular-nums ${
              ops.pendingApprovals > 0 ? "text-warn-400" : "text-signal-400"
            }`}
          >
            {ops.pendingApprovals}
          </div>
          <p className="mt-2 text-xs text-mist-400">
            {ops.pendingApprovals > 0
              ? "operator 以上が承認すると再起動と復旧確認を実行します。"
              : "承認待ちはありません。"}
          </p>
        </div>
      </section>

      {conflictCount > 0 ? (
        <section className="mt-6 rounded-xl border border-danger-400/30 bg-danger-400/10 px-4 py-3">
          <div className="text-sm font-semibold text-danger-400">
            ポート競合を検出しました
          </div>
          <ul className="mt-2 space-y-1 text-xs text-danger-400/90">
            {data?.conflicts.map((conflict) => (
              <li key={conflict.id}>
                <span className="font-mono">
                  {conflict.scope.toUpperCase()} /{" "}
                  {conflict.protocol.toUpperCase()} {conflict.port}
                </span>{" "}
                は {conflict.serviceId}{" "}
                用に予約されていますが、現在別のプロセスが使用中です。
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-6 grid gap-4 lg:grid-cols-[380px_1fr]">
        <form
          onSubmit={createReservation}
          className="rounded-xl border border-ink-700/70 bg-ink-900/50 p-4"
        >
          <h2 className="text-sm font-semibold text-white">ポート予約</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-mist-400">
            Windows と WSL はネットワークを共有するため、同じ protocol + port は
            1 つだけ予約できます。予約後に別プロセスが listen
            すると競合として表示されます。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Scope
              </span>
              <select
                value={form.scope}
                onChange={(event) =>
                  setForm({
                    ...form,
                    scope: event.target.value as "windows" | "wsl",
                  })
                }
                disabled={!canOperate}
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              >
                <option value="windows">windows</option>
                <option value="wsl">wsl</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Protocol
              </span>
              <select
                value={form.protocol}
                onChange={(event) =>
                  setForm({
                    ...form,
                    protocol: event.target.value as "tcp" | "udp",
                  })
                }
                disabled={!canOperate}
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
              Port
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              required
              value={form.port}
              onChange={(event) =>
                setForm({ ...form, port: event.target.value })
              }
              disabled={!canOperate}
              placeholder="34567"
              className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
              Service ID
            </span>
            <input
              type="text"
              required
              value={form.serviceId}
              onChange={(event) =>
                setForm({ ...form, serviceId: event.target.value })
              }
              disabled={!canOperate}
              placeholder="my-api"
              className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
              Note
            </span>
            <input
              type="text"
              value={form.note}
              onChange={(event) =>
                setForm({ ...form, note: event.target.value })
              }
              disabled={!canOperate}
              placeholder="用途・担当など"
              className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
            />
          </label>
          {reservationError ? (
            <div className="mt-3 rounded-md border border-danger-400/30 bg-danger-400/10 px-2 py-1.5 text-[11px] text-danger-400">
              {reservationError}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={!canOperate || submittingReservation}
            className="mt-4 w-full rounded-md bg-signal-400 px-3 py-2 text-xs font-semibold text-ink-950 transition hover:bg-signal-400/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submittingReservation ? "予約中…" : "予約する"}
          </button>
          {!canOperate ? (
            <p className="mt-2 text-[10px] text-mist-400">
              予約には operator 以上の権限が必要です。
            </p>
          ) : null}
        </form>

        <div className="overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
          <div className="border-b border-ink-700/70 px-4 py-3">
            <h2 className="text-sm font-semibold text-white">予約一覧</h2>
            <p className="text-[11px] text-mist-400">
              起動前チェック用の予約。競合は赤で表示されます。
            </p>
          </div>
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink-700/70 bg-ink-950/40 text-[10px] uppercase tracking-[0.12em] text-mist-400">
                  <th className="px-4 py-2 font-medium">Endpoint</th>
                  <th className="px-4 py-2 font-medium">Service</th>
                  <th className="px-4 py-2 font-medium">Note</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/40">
                {(data?.reservations.length ?? 0) === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-mist-400"
                    >
                      予約はまだありません
                    </td>
                  </tr>
                ) : (
                  data?.reservations.map((reservation) => (
                    <tr key={reservation.id} className="hover:bg-ink-800/40">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-white">
                        {reservation.scope.toUpperCase()} /{" "}
                        {reservation.protocol.toUpperCase()} {reservation.port}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-mist-200">
                        {reservation.serviceId}
                      </td>
                      <td className="max-w-[220px] px-4 py-2 text-xs text-mist-400">
                        <span
                          className="line-clamp-1"
                          title={reservation.note ?? ""}
                        >
                          {reservation.note || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            reservation.status === "conflict"
                              ? "bg-danger-400/15 text-danger-400"
                              : "bg-signal-400/15 text-signal-400"
                          }`}
                        >
                          {reservation.status === "conflict"
                            ? "競合"
                            : "予約済み"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <button
                          type="button"
                          onClick={() => void deleteReservation(reservation)}
                          disabled={
                            !canOperate || busyReservationId === reservation.id
                          }
                          className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {busyReservationId === reservation.id
                            ? "解除中…"
                            : "解除"}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">待受ポート</h2>
            <p className="text-[11px] text-mist-400">
              Windows と WSL を 1 つのビューに統合。WSL は distro
              間でネットワークを共有します。
            </p>
          </div>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="プロセス / ポート / コマンド / 予約で絞り込み"
            className="w-full max-w-xs rounded-md border border-ink-700 bg-ink-950/70 px-3 py-1.5 text-xs text-mist-200 placeholder:text-mist-400/60 focus:border-signal-400/40 focus:outline-none"
          />
        </div>

        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[1050px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-700/70 bg-ink-950/40 text-[10px] uppercase tracking-[0.12em] text-mist-400">
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Port</th>
                <th className="px-4 py-2 font-medium">Bind</th>
                <th className="px-4 py-2 font-medium">Process</th>
                <th className="px-4 py-2 font-medium">PID / PPID</th>
                <th className="px-4 py-2 font-medium">Reservation</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/40">
              {loading && !data ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm text-mist-400"
                  >
                    スキャン中…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-10 text-center text-sm text-mist-400"
                  >
                    該当するポートがありません
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <FragmentRow
                    key={item.id}
                    item={item}
                    expanded={expanded.has(item.id)}
                    canOperate={canOperate}
                    killBusyKey={killBusyKey}
                    onToggle={() => toggleExpanded(item.id)}
                    onHistory={() => void openHistory(item)}
                    onKillOwner={(owner) => void killOwner(item, owner)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/70 px-4 py-2 text-[10px] text-mist-400">
          <span>
            {items.length} / {data?.items.length ?? 0} 行を表示
          </span>
          <span>
            {data?.skipped.length
              ? `スキップ: ${data.skipped.map((s) => s.distro).join(", ")}`
              : "WSL 3.x の共有ネットワークを考慮してマージ済み"}
          </span>
        </div>
      </section>

      {historyFor ? (
        <section className="mt-6 overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
          <div className="flex items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                ポート履歴 — {historyFor.scope.toUpperCase()} /{" "}
                {historyFor.protocol.toUpperCase()} {historyFor.port}
              </h2>
              <p className="text-[11px] text-mist-400">
                観測された opened / closed
                の履歴。停止操作を行った場合は実行者も記録されます。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryFor(null)}
              className="rounded border border-ink-700 px-2 py-1 text-[11px] text-mist-400 transition hover:text-white"
            >
              閉じる
            </button>
          </div>
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[780px] border-collapse text-left">
              <thead>
                <tr className="border-b border-ink-700/70 bg-ink-950/40 text-[10px] uppercase tracking-[0.12em] text-mist-400">
                  <th className="px-4 py-2 font-medium">Opened</th>
                  <th className="px-4 py-2 font-medium">Closed</th>
                  <th className="px-4 py-2 font-medium">Process</th>
                  <th className="px-4 py-2 font-medium">PID</th>
                  <th className="px-4 py-2 font-medium">Released by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-700/40">
                {historyLoading ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-mist-400"
                    >
                      読み込み中…
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-mist-400"
                    >
                      履歴はまだありません
                    </td>
                  </tr>
                ) : (
                  history.map((entry) => (
                    <tr key={entry.id} className="hover:bg-ink-800/40">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-mist-200">
                        {formatDate(entry.openedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-[11px] text-mist-400">
                        {entry.closedAt ? formatDate(entry.closedAt) : "open"}
                      </td>
                      <td className="px-4 py-2 text-xs text-mist-200">
                        {entry.process ?? "—"}
                        <div
                          className="max-w-[360px] truncate font-mono text-[10px] text-mist-400"
                          title={entry.commandLine ?? ""}
                        >
                          {entry.commandLine ?? ""}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-mist-400">
                        {entry.pid ?? "—"} / {entry.ppid ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-mist-400">
                        {entry.releasedBy ?? "—"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mist-400">
        <span>sys4sys v0.1 — ports / logs / incidents / AI reports</span>
        <span className="font-mono">
          M1: auth + reservations + history + kill
        </span>
      </footer>
    </main>
  );
}

function FragmentRow({
  item,
  expanded,
  canOperate,
  killBusyKey,
  onToggle,
  onHistory,
  onKillOwner,
}: {
  item: PortItem;
  expanded: boolean;
  canOperate: boolean;
  killBusyKey: string | null;
  onToggle: () => void;
  onHistory: () => void;
  onKillOwner: (owner: PortOwner) => void;
}) {
  const owners = portOwnersForItem(item);
  const primary = primaryPortOwner(item);
  const killable = killablePortOwners(item);
  const rowKillOwner =
    killable.length === 1 ? (killable[0] ?? primary) : primary;
  const rowKillKey = portOwnerKey(item, rowKillOwner);
  const canRowKill =
    canOperate &&
    rowKillOwner.pid !== null &&
    rowKillOwner.pid > 4 &&
    killable.length <= 1;
  const ownerExtraCount = owners.length > 1 ? owners.length - 1 : 0;

  return (
    <>
      <tr
        className={`group transition hover:bg-ink-800/40 ${
          item.conflict ? "bg-danger-400/[0.04]" : ""
        }`}
      >
        <td className="whitespace-nowrap px-4 py-2">
          <ScopeBadge item={item} />
        </td>
        <td className="whitespace-nowrap px-4 py-2 font-mono text-sm tabular-nums text-white">
          {item.port}
          <span className="ml-2 text-[10px] uppercase text-mist-400">
            {item.protocol}
          </span>
        </td>
        <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-mist-400">
          {item.address || "*"}
        </td>
        <td className="whitespace-nowrap px-4 py-2 text-sm text-mist-200">
          {primary.process ?? <span className="text-mist-400">—</span>}
          {ownerExtraCount > 0 ? (
            <span
              className="ml-1 rounded bg-warn-400/15 px-1 text-[10px] text-warn-400"
              title="同じ endpoint に複数のオーナーがあります"
            >
              +{ownerExtraCount}
            </span>
          ) : null}
        </td>
        <td className="whitespace-nowrap px-4 py-2 font-mono text-xs tabular-nums text-mist-400">
          {primary.pid ?? "—"} / {primary.ppid ?? "—"}
          {ownerExtraCount > 0 ? (
            <span className="text-warn-400"> (+{ownerExtraCount})</span>
          ) : null}
        </td>
        <td className="whitespace-nowrap px-4 py-2">
          <ReservationBadge reservation={item.reservation} />
        </td>
        <td className="whitespace-nowrap px-4 py-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggle}
              className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 transition hover:border-mist-400/40 hover:text-white"
            >
              {expanded ? "閉じる" : "詳細"}
            </button>
            <button
              type="button"
              onClick={onHistory}
              className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 transition hover:border-sky-400/40 hover:text-sky-300"
            >
              履歴
            </button>
            {canRowKill ? (
              <button
                type="button"
                onClick={() => onKillOwner(rowKillOwner)}
                disabled={killBusyKey !== null}
                className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {killBusyKey === rowKillKey ? "停止中…" : "停止"}
              </button>
            ) : killable.length > 1 ? (
              <span
                className="rounded border border-warn-400/20 bg-warn-400/10 px-2 py-1 text-[10px] text-warn-400"
                title="複数プロセスがあります。詳細を開いて PID を選んで停止してください"
              >
                複数
              </span>
            ) : null}
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="bg-ink-950/40">
          <td colSpan={7} className="px-4 py-3">
            <dl className="grid gap-x-6 gap-y-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-mist-400">Primary PID / PPID</dt>
                <dd className="font-mono text-mist-200">
                  {primary.pid ?? "—"} / {primary.ppid ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-mist-400">Process started</dt>
                <dd className="font-mono text-mist-200">
                  {formatDate(primary.startedAt ?? item.startedAt)}
                </dd>
              </div>
              <div>
                <dt className="text-mist-400">First seen</dt>
                <dd className="font-mono text-mist-200">
                  {formatDate(item.firstSeen)}
                </dd>
              </div>
              <div>
                <dt className="text-mist-400">Last seen</dt>
                <dd className="font-mono text-mist-200">
                  {formatDate(item.lastSeen)}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-mist-400">Executable</dt>
                <dd className="break-all font-mono text-mist-200">
                  {primary.processPath ?? item.processPath ?? "—"}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-mist-400">Seen in</dt>
                <dd className="font-mono text-mist-200">
                  {item.seenIn.length ? item.seenIn.join(", ") : "—"}
                </dd>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <dt className="text-mist-400">Primary command line</dt>
                <dd className="break-all font-mono text-mist-200">
                  {primary.commandLine ?? item.commandLine ?? "—"}
                </dd>
              </div>
              {owners.length > 1 ? (
                <div className="sm:col-span-2 lg:col-span-4">
                  <dt className="text-mist-400">Owners ({owners.length})</dt>
                  <dd className="space-y-2">
                    {owners.map((owner) => {
                      const ownerKey = portOwnerKey(item, owner);
                      const ownerKillable = owner.pid !== null && owner.pid > 4;
                      const ownerBusy = killBusyKey === ownerKey;
                      return (
                        <div
                          key={ownerKey}
                          className="flex flex-wrap items-start gap-2 rounded-md border border-ink-700/60 bg-ink-950/30 px-2 py-2"
                        >
                          <div className="min-w-[220px] flex-1">
                            <div className="font-mono text-[11px] text-mist-200">
                              PID {owner.pid ?? "—"} / PPID {owner.ppid ?? "—"}{" "}
                              · {owner.process ?? "—"}
                            </div>
                            <div className="max-w-[520px] break-all font-mono text-[10px] text-mist-400">
                              {owner.commandLine ?? "—"}
                            </div>
                            <div className="font-mono text-[10px] text-mist-400">
                              {owner.pidScope ?? "—"} ·{" "}
                              {formatDate(owner.startedAt ?? item.startedAt)}
                              {owner.likelyWslForward ? " · WSL relay" : ""}
                            </div>
                          </div>
                          {ownerKillable ? (
                            <button
                              type="button"
                              onClick={() => onKillOwner(owner)}
                              disabled={!canOperate || killBusyKey !== null}
                              className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 transition hover:border-danger-400/40 hover:text-danger-400 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {ownerBusy ? "停止中…" : "停止"}
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </dd>
                </div>
              ) : null}
              {item.reservation ? (
                <div className="sm:col-span-2 lg:col-span-4">
                  <dt className="text-mist-400">Reservation</dt>
                  <dd className="font-mono text-mist-200">
                    {item.reservation.serviceId} · {item.reservation.status} ·{" "}
                    {item.reservation.note ?? "no note"}
                  </dd>
                </div>
              ) : null}
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}
