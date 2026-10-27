"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { AppShell } from "./components/AppShell";
import { StatusRail } from "./components/StatusRail";
import { PortLedger } from "./components/ports/PortLedger";
import { formatDate, portOwnerKey } from "./components/ports/port-utils";
import type {
  PortItem,
  PortOwner,
  ReservationView,
} from "./components/ports/types";
import { ConfirmDialog } from "./components/ui/ConfirmDialog";
import { EmptyState } from "./components/ui/EmptyState";
import { StatusBanner } from "./components/ui/StatusBanner";

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

type ConfirmAction =
  | { kind: "reservation"; reservation: ReservationView }
  | { kind: "kill"; endpoint: PortItem; owner: PortOwner };

const EMPTY_FORM = {
  scope: "windows" as "windows" | "wsl",
  protocol: "tcp" as "tcp" | "udp",
  port: "",
  serviceId: "",
  note: "",
};

export default function DashboardPage() {
  const [data, setData] = useState<PortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [reservationError, setReservationError] = useState<string | null>(null);
  const [submittingReservation, setSubmittingReservation] = useState(false);
  const [busyReservationId, setBusyReservationId] = useState<string | null>(
    null,
  );
  const [killBusyKey, setKillBusyKey] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<PortItem | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [ops, setOps] = useState<OpsSummary>({
    openIncidents: 0,
    pendingApprovals: 0,
    incidents: [],
  });

  const load = useCallback(async (showProgress = false) => {
    if (showProgress) setRefreshing(true);
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
      if (showProgress) setRefreshing(false);
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

  async function createReservation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setReservationError(null);
    setMessage(null);
    setActionError(null);
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

  async function deleteReservation(
    reservation: ReservationView,
  ): Promise<string | null> {
    setBusyReservationId(reservation.id);
    setMessage(null);
    setActionError(null);
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
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setActionError(text);
      return text;
    } finally {
      setBusyReservationId(null);
    }
  }

  async function openHistory(item: PortItem) {
    setHistoryFor(item);
    setHistoryLoading(true);
    setHistory([]);
    setActionError(null);
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
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setHistoryLoading(false);
    }
  }

  async function killOwner(
    endpoint: PortItem,
    owner: PortOwner,
  ): Promise<string | null> {
    const pid = owner.pid ?? endpoint.pid;
    if (pid === null || pid <= 4 || killBusyKey) return null;

    const pidScope = owner.pidScope ?? endpoint.pidScope;
    const processName = owner.process ?? endpoint.process ?? "unknown";
    const busyKey = portOwnerKey(endpoint, owner);
    setKillBusyKey(busyKey);
    setMessage(null);
    setActionError(null);
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
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setActionError(text);
      return text;
    } finally {
      setKillBusyKey(null);
    }
  }

  function requestDeleteReservation(reservation: ReservationView) {
    setConfirmError(null);
    setConfirmAction({ kind: "reservation", reservation });
  }

  function requestKillOwner(endpoint: PortItem, owner: PortOwner) {
    setConfirmError(null);
    setConfirmAction({ kind: "kill", endpoint, owner });
  }

  async function confirmDestructiveAction() {
    if (!confirmAction) return;
    setConfirmBusy(true);
    setConfirmError(null);

    const error =
      confirmAction.kind === "reservation"
        ? await deleteReservation(confirmAction.reservation)
        : await killOwner(confirmAction.endpoint, confirmAction.owner);

    setConfirmBusy(false);
    if (error) {
      setConfirmError(error);
      return;
    }
    setConfirmAction(null);
  }

  const canOperate = user?.role === "admin" || user?.role === "operator";

  const relayCount =
    data?.items.filter((item) => item.likelyWslForward).length ?? 0;
  const reservationCount = data?.reservations.length ?? 0;
  const conflictCount = data?.conflicts.length ?? 0;
  const scannedAt = data
    ? new Date(data.scannedAt).toLocaleTimeString("ja-JP", { hour12: false })
    : "—";

  const confirmReservation =
    confirmAction?.kind === "reservation" ? confirmAction.reservation : null;
  const confirmKill = confirmAction?.kind === "kill" ? confirmAction : null;
  const confirmKillPid = confirmKill
    ? (confirmKill.owner.pid ?? confirmKill.endpoint.pid)
    : null;
  const confirmKillProcess = confirmKill
    ? (confirmKill.owner.process ?? confirmKill.endpoint.process ?? "unknown")
    : "";

  function focusReservationForm() {
    document
      .getElementById("reservation-form")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("reservation-port")?.focus();
  }

  return (
    <AppShell
      title="Ports"
      description="Windows / WSL の待受ポートと予約"
      user={user}
      actions={
        <button
          type="button"
          onClick={() => void load(true)}
          disabled={refreshing}
          aria-busy={refreshing}
          className="min-h-11 rounded-md border border-border bg-surface px-3 text-sm font-medium text-fg transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? "スキャン中…" : "再スキャン"}
        </button>
      }
    >
      {error ? (
        <StatusBanner
          tone="error"
          title="API に接続できません"
          className="mt-6"
        >
          {error}。再試行してください。
        </StatusBanner>
      ) : null}

      {actionError ? (
        <StatusBanner tone="error" title="操作に失敗しました" className="mt-6">
          {actionError}
        </StatusBanner>
      ) : null}

      {message ? (
        <StatusBanner tone="success" className="mt-6">
          {message}
        </StatusBanner>
      ) : null}

      <StatusRail
        error={error}
        scannedAt={scannedAt}
        listeningCount={data?.items.length ?? "—"}
        reservationCount={reservationCount}
        conflictCount={conflictCount}
        relayCount={relayCount}
        canOperate={canOperate}
        onAddReservation={focusReservationForm}
      />

      {conflictCount > 0 ? (
        <section className="mt-6 rounded-lg border-2 border-danger/30 bg-danger/10 px-4 py-3">
          <div className="text-sm font-semibold text-danger">
            ポート接続不良を検出しました
          </div>
          <ul className="mt-2 space-y-1 text-sm text-danger">
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

      <PortLedger
        items={data?.items ?? []}
        loading={loading}
        refreshing={refreshing}
        canOperate={canOperate}
        killBusyKey={killBusyKey}
        onRescan={() => void load(true)}
        onHistory={(item) => void openHistory(item)}
        onKillOwner={requestKillOwner}
      />
      <p className="mt-2 text-sm text-fg-muted">
        {data?.skipped.length
          ? `スキップ: ${data.skipped.map((s) => s.distro).join(", ")}`
          : "WSL 3.x の共有ネットワークを考慮してマージ済み"}
      </p>

      {historyFor ? (
        <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                ポート履歴 — {historyFor.scope.toUpperCase()} /{" "}
                {historyFor.protocol.toUpperCase()} {historyFor.port}
              </h2>
              <p className="text-xs text-fg-muted">
                観測された opened / closed
                の履歴。停止操作を行った場合は実行者も記録されます。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHistoryFor(null)}
              className="rounded border border-border px-2 py-1 text-xs text-fg-muted transition hover:text-fg"
            >
              閉じる
            </button>
          </div>
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[780px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Opened
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Closed
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Process
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    PID
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Released by
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {historyLoading ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-8 text-center text-sm text-fg-muted"
                    >
                      読み込み中…
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState
                        compact
                        title="履歴はまだありません"
                        description="このポートが開閉されると、ここに履歴が表示されます。"
                      />
                    </td>
                  </tr>
                ) : (
                  history.map((entry) => (
                    <tr key={entry.id} className="hover:bg-surface-muted">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-fg">
                        {formatDate(entry.openedAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-fg-muted">
                        {entry.closedAt ? formatDate(entry.closedAt) : "open"}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg">
                        {entry.process ?? "—"}
                        <div
                          className="max-w-[360px] truncate font-mono text-xs text-fg-muted"
                          title={entry.commandLine ?? ""}
                        >
                          {entry.commandLine ?? ""}
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg-muted">
                        {entry.pid ?? "—"} / {entry.ppid ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-xs text-fg-muted">
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

      <section className="mt-6 grid gap-4 lg:grid-cols-[380px_1fr]">
        <form
          id="reservation-form"
          onSubmit={createReservation}
          className="rounded-xl border border-border bg-surface p-4"
        >
          <h2 className="text-sm font-semibold text-fg">ポート予約</h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Windows と WSL はネットワークを共有するため、同じ protocol + port は
            1 つだけ予約できます。予約後に別プロセスが listen
            すると競合として表示されます。
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">Scope</span>
              <select
                value={form.scope}
                onChange={(event) =>
                  setForm({
                    ...form,
                    scope: event.target.value as "windows" | "wsl",
                  })
                }
                disabled={!canOperate}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
              >
                <option value="windows">windows</option>
                <option value="wsl">wsl</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">Protocol</span>
              <select
                value={form.protocol}
                onChange={(event) =>
                  setForm({
                    ...form,
                    protocol: event.target.value as "tcp" | "udp",
                  })
                }
                disabled={!canOperate}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
              >
                <option value="tcp">tcp</option>
                <option value="udp">udp</option>
              </select>
            </label>
          </div>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-fg-muted">Port</span>
            <input
              id="reservation-port"
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
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-fg-muted">Service ID</span>
            <input
              type="text"
              required
              value={form.serviceId}
              onChange={(event) =>
                setForm({ ...form, serviceId: event.target.value })
              }
              disabled={!canOperate}
              placeholder="my-api"
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
            />
          </label>
          <label className="mt-3 block">
            <span className="mb-1 block text-xs text-fg-muted">Note</span>
            <input
              type="text"
              value={form.note}
              onChange={(event) =>
                setForm({ ...form, note: event.target.value })
              }
              disabled={!canOperate}
              placeholder="用途・担当など"
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
            />
          </label>
          {reservationError ? (
            <div className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs text-danger">
              {reservationError}
            </div>
          ) : null}
          <button
            type="submit"
            disabled={!canOperate || submittingReservation}
            className="mt-4 w-full rounded-md bg-success px-3 py-2 text-xs font-semibold text-success-fg transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submittingReservation ? "予約中…" : "予約する"}
          </button>
          {!canOperate ? (
            <p className="mt-2 text-xs text-fg-muted">
              予約には operator 以上の権限が必要です。
            </p>
          ) : null}
        </form>

        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold text-fg">予約一覧</h2>
            <p className="text-xs text-fg-muted">
              起動前チェック用の予約。競合は赤で表示されます。
            </p>
          </div>
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-left">
              <thead>
                <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                  <th scope="col" className="px-4 py-2 font-medium">
                    Endpoint
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Service
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Note
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(data?.reservations.length ?? 0) === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <EmptyState
                        compact
                        title="予約はまだありません"
                        description="起動前にポートを予約すると、競合を事前に検出できます。"
                        action={
                          canOperate ? (
                            <button
                              type="button"
                              onClick={() => {
                                document
                                  .getElementById("reservation-form")
                                  ?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "start",
                                  });
                                document
                                  .getElementById("reservation-port")
                                  ?.focus();
                              }}
                              className="min-h-9 rounded-md border border-border px-3 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg"
                            >
                              予約を追加
                            </button>
                          ) : null
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  data?.reservations.map((reservation) => (
                    <tr key={reservation.id} className="hover:bg-surface-muted">
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-fg">
                        {reservation.scope.toUpperCase()} /{" "}
                        {reservation.protocol.toUpperCase()} {reservation.port}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-fg">
                        {reservation.serviceId}
                      </td>
                      <td className="max-w-[220px] px-4 py-2 text-xs text-fg-muted">
                        <span
                          className="line-clamp-1"
                          title={reservation.note ?? ""}
                        >
                          {reservation.note || "—"}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                            reservation.status === "conflict"
                              ? "bg-danger/15 text-danger"
                              : "bg-success/15 text-success"
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
                          onClick={() => requestDeleteReservation(reservation)}
                          disabled={
                            !canOperate || busyReservationId === reservation.id
                          }
                          aria-label={`${reservation.protocol.toUpperCase()} ${reservation.port} (${reservation.serviceId}) の予約を解除`}
                          className="min-h-9 rounded border border-border px-2.5 py-1 text-xs text-fg-muted transition hover:border-danger/40 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
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

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">Open incidents</h2>
              <p className="text-xs text-fg-muted">未解決の監視インシデント</p>
            </div>
            <Link
              href="/incidents"
              className="rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg"
            >
              開く
            </Link>
          </div>
          <div
            className={`mt-3 font-mono text-3xl tabular-nums ${
              ops.openIncidents > 0 ? "text-danger" : "text-success"
            }`}
          >
            {ops.openIncidents}
          </div>
          {ops.incidents.length === 0 ? (
            <p className="mt-2 text-xs text-fg-muted">
              アクティブなインシデントはありません。
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {ops.incidents.slice(0, 3).map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/incidents?focus=${encodeURIComponent(incident.id)}`}
                    className="flex items-start justify-between gap-3 rounded border border-border bg-surface-muted px-2.5 py-2 transition hover:border-danger/30"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs text-fg">
                        {incident.title}
                      </span>
                      <span className="mt-0.5 block text-xs text-fg-muted">
                        {incident.service?.name ?? "—"} /{" "}
                        {formatDate(incident.startedAt)}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 text-xs font-medium ${
                        incident.severity === "critical" ||
                        incident.severity === "error"
                          ? "text-danger"
                          : incident.severity === "warning"
                            ? "text-warning"
                            : "text-fg-muted"
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

        <div className="rounded-xl border border-border bg-surface p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                Pending approvals
              </h2>
              <p className="text-xs text-fg-muted">
                承認待ちの再起動リクエスト
              </p>
            </div>
            <Link
              href="/approvals"
              className="rounded-md border border-border bg-surface-muted px-2.5 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg"
            >
              開く
            </Link>
          </div>
          <div
            className={`mt-3 font-mono text-3xl tabular-nums ${
              ops.pendingApprovals > 0 ? "text-warning" : "text-success"
            }`}
          >
            {ops.pendingApprovals}
          </div>
          <p className="mt-2 text-xs text-fg-muted">
            {ops.pendingApprovals > 0
              ? "operator 以上が承認すると再起動と復旧確認を実行します。"
              : "承認待ちはありません。"}
          </p>
        </div>
      </section>

      {confirmAction ? (
        <ConfirmDialog
          open
          title={
            confirmReservation
              ? "予約を解除しますか？"
              : "プロセスを停止しますか？"
          }
          description={
            confirmReservation
              ? "この予約を解除すると、起動前の競合チェックから外れます。"
              : "この PID に KILL シグナルを送信します。対象プロセスは即座に終了します。"
          }
          target={
            confirmReservation ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-fg-muted">Endpoint</dt>
                <dd className="font-mono">
                  {confirmReservation.scope.toUpperCase()} /{" "}
                  {confirmReservation.protocol.toUpperCase()}{" "}
                  {confirmReservation.port}
                </dd>
                <dt className="text-fg-muted">Service</dt>
                <dd className="font-mono">{confirmReservation.serviceId}</dd>
                <dt className="text-fg-muted">Note</dt>
                <dd>{confirmReservation.note || "—"}</dd>
              </dl>
            ) : confirmKill ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                <dt className="text-fg-muted">PID</dt>
                <dd className="font-mono">{confirmKillPid ?? "—"}</dd>
                <dt className="text-fg-muted">Process</dt>
                <dd className="font-mono">{confirmKillProcess}</dd>
                <dt className="text-fg-muted">Endpoint</dt>
                <dd className="font-mono">
                  {confirmKill.endpoint.scope.toUpperCase()} /{" "}
                  {confirmKill.endpoint.protocol.toUpperCase()}{" "}
                  {confirmKill.endpoint.port}
                </dd>
              </dl>
            ) : null
          }
          impact={
            confirmReservation
              ? "解除しても、実際に listen しているプロセスは停止されません。"
              : "保存されていない作業は失われる可能性があります。PID とプロセス名を確認してください。"
          }
          confirmLabel={confirmReservation ? "予約を解除" : "停止する"}
          busy={confirmBusy}
          error={confirmError}
          onConfirm={() => void confirmDestructiveAction()}
          onCancel={() => {
            if (!confirmBusy) {
              setConfirmAction(null);
              setConfirmError(null);
            }
          }}
        />
      ) : null}
    </AppShell>
  );
}
