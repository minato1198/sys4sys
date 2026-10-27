"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AppShell } from "../components/AppShell";
import { useConfirmDialog } from "../components/ui/useConfirmDialog";

interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "operator" | "viewer";
}

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

interface ApprovalView {
  id: string;
  incidentId: string;
  requestedAction: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  incident: {
    id: string;
    serviceId: string;
    title: string;
    severity: "info" | "warning" | "error" | "critical";
    status: string;
    summary: string | null;
    startedAt: string;
  } | null;
  service: {
    id: string;
    hostId: string;
    name: string;
    status: string;
    autoRestartPhase: "observe" | "approve" | "auto";
  } | null;
  host: {
    id: string;
    kind: "windows" | "wsl";
    name: string;
    distro: string | null;
  } | null;
}

interface ApprovalList {
  items: ApprovalView[];
  total: number;
}

interface Problem {
  detail?: string;
}

const TABS: Array<{ value: ApprovalStatus; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
];

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function severityBadge(severity: string): string {
  if (severity === "critical" || severity === "error")
    return "border-danger/30 bg-danger/10 text-danger";
  if (severity === "warning")
    return "border-warning/30 bg-warning/10 text-warning";
  return "border-border bg-surface-muted text-fg";
}

function approvalBadge(status: ApprovalStatus): string {
  if (status === "pending")
    return "border-warning/40 bg-warning/10 text-warning";
  if (status === "approved")
    return "border-success/40 bg-success/10 text-success";
  if (status === "rejected") return "border-danger/40 bg-danger/10 text-danger";
  return "border-border bg-surface-muted text-fg-muted";
}

function requestedReason(value: Record<string, unknown>): string {
  const reason = value.reason;
  return typeof reason === "string" ? reason : "";
}

export default function ApprovalsPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<ApprovalStatus>("pending");
  const [items, setItems] = useState<ApprovalView[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

  const load = useCallback(async () => {
    const response = await fetch(
      `/api/approvals?status=${encodeURIComponent(status)}&limit=100`,
      { cache: "no-store" },
    );
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`approvals ${response.status}`);
    const body = (await response.json()) as ApprovalList;
    setItems(body.items);
    setTotal(body.total);
    setSelectedId((current) => {
      if (current && body.items.some((item) => item.id === current)) {
        return current;
      }
      return body.items[0]?.id ?? null;
    });
  }, [status]);

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
        await load();
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
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function decide(
    approval: ApprovalView,
    decision: "approve" | "reject",
  ): Promise<string | null> {
    setBusyId(approval.id);
    setMessage(null);
    setError(null);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(approval.id)}/${decision}`,
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
          problem?.detail ??
            `${decision === "approve" ? "承認" : "却下"}に失敗しました (${response.status})`,
        );
      }
      setNote("");
      setMessage(
        decision === "approve"
          ? "承認しました。再起動と復旧確認を実行しています。"
          : "却下しました。",
      );
      await load();
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setError(text);
      return text;
    } finally {
      setBusyId(null);
    }
  }

  const canOperate = user?.role === "admin" || user?.role === "operator";
  const selected = items.find((item) => item.id === selectedId) ?? null;

  return (
    <AppShell
      title="承認"
      description="承認待ちの再起動を確認し、実行または却下します。"
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
        {TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setStatus(tab.value)}
            className={`rounded-xl border p-4 text-left transition ${
              status === tab.value
                ? "border-success/40 bg-success/10"
                : "border-border bg-surface hover:border-success/30"
            }`}
          >
            <div className="text-xs font-medium text-fg-muted">{tab.label}</div>
            <div
              className={`mt-2 font-mono text-2xl tabular-nums ${
                tab.value === "pending"
                  ? "text-warning"
                  : tab.value === "approved"
                    ? "text-success"
                    : tab.value === "rejected"
                      ? "text-danger"
                      : "text-fg"
              }`}
            >
              {status === tab.value ? total : "—"}
            </div>
          </button>
        ))}
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-fg">承認キュー</h2>
            <p className="text-xs text-fg-muted">
              5
              秒ごとに自動更新します。承認後は再起動と復旧確認が非同期で実行されます。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg"
          >
            更新
          </button>
        </div>

        <div className="border-b border-border px-4 py-3">
          <label className="text-xs font-medium text-fg-muted">
            判断メモ（任意）
          </label>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            placeholder="承認・却下の理由など"
            className="mt-1 w-full rounded-md border border-border bg-surface-muted px-2.5 py-2 text-xs text-fg focus:border-success/50"
          />
        </div>

        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[1020px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Service
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Incident
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Severity
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Requested
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Decision
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
                    承認はありません
                  </td>
                </tr>
              ) : (
                items.map((approval) => {
                  const busy = busyId === approval.id;
                  return (
                    <tr
                      key={approval.id}
                      onClick={() => setSelectedId(approval.id)}
                      className={`cursor-pointer align-top transition ${
                        selectedId === approval.id
                          ? "bg-surface-muted"
                          : "hover:bg-surface-muted"
                      }`}
                    >
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${approvalBadge(
                            approval.status,
                          )}`}
                        >
                          {approval.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-fg">
                          {approval.service?.name ?? "—"}
                        </div>
                        <div className="mt-0.5 text-xs text-fg-muted">
                          {approval.host?.kind?.toUpperCase() ?? "?"}{" "}
                          {approval.host?.distro ?? approval.host?.name ?? ""}
                          {approval.service
                            ? ` / ${approval.service.autoRestartPhase}`
                            : ""}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/incidents?focus=${encodeURIComponent(
                            approval.incidentId,
                          )}`}
                          className="text-xs text-fg hover:text-success"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {approval.incident?.title ?? approval.incidentId}
                        </Link>
                        <div className="mt-0.5 max-w-96 truncate text-xs text-fg-muted">
                          {requestedReason(approval.requestedAction) ||
                            approval.incident?.summary ||
                            "—"}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${severityBadge(
                            approval.incident?.severity ?? "info",
                          )}`}
                        >
                          {approval.incident?.severity ?? "—"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-fg">
                        {formatDate(approval.requestedAt)}
                      </td>
                      <td className="px-4 py-3">
                        {approval.status === "pending" && canOperate ? (
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                void decide(approval, "approve");
                              }}
                              className="min-h-9 rounded border border-success/40 bg-success/10 px-2.5 py-1 text-xs font-medium text-success transition hover:bg-success/20 disabled:opacity-50"
                            >
                              承認
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={(event) => {
                                event.stopPropagation();
                                requestConfirm(
                                  {
                                    title: "再起動リクエストを却下しますか？",
                                    description:
                                      "この承認要求を却下すると、自動復旧は実行されません。",
                                    target: (
                                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                        <dt className="text-fg-muted">
                                          Service
                                        </dt>
                                        <dd>
                                          {approval.service?.name ??
                                            approval.incident?.title ??
                                            "—"}
                                        </dd>
                                        <dt className="text-fg-muted">Host</dt>
                                        <dd>{approval.host?.name ?? "—"}</dd>
                                        <dt className="text-fg-muted">
                                          Incident
                                        </dt>
                                        <dd>
                                          {approval.incident?.title ?? "—"}
                                        </dd>
                                      </dl>
                                    ),
                                    impact:
                                      "インシデントは open のまま残り、必要に応じて再申請できます。",
                                    confirmLabel: "却下",
                                  },
                                  () => decide(approval, "reject"),
                                );
                              }}
                              className="min-h-9 rounded border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger transition hover:bg-danger/20 disabled:opacity-50"
                            >
                              却下
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-fg-muted">
                            {approval.decidedBy
                              ? `${approval.decidedBy} / ${formatDate(
                                  approval.decidedAt,
                                )}`
                              : approval.status === "pending"
                                ? "権限なし"
                                : "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {selected ? (
        <section className="mt-6 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-fg">
              承認リクエスト詳細
            </h2>
            <Link
              href={`/incidents?focus=${encodeURIComponent(selected.incidentId)}`}
              className="text-xs text-success hover:underline"
            >
              インシデントを開く
            </Link>
          </div>
          <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-fg-muted">Approval</dt>
              <dd className="font-mono text-xs text-fg">{selected.id}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Incident</dt>
              <dd className="text-fg">
                {selected.incident?.title ?? selected.incidentId}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Requested action</dt>
              <dd className="break-words font-mono text-xs text-fg">
                {JSON.stringify(selected.requestedAction)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Decision</dt>
              <dd className="text-fg">
                {selected.status}
                {selected.decidedBy ? ` / ${selected.decidedBy}` : ""}
              </dd>
            </div>
          </dl>
          {selected.note ? (
            <p className="mt-3 whitespace-pre-wrap rounded border border-border bg-surface-muted px-3 py-2 text-xs text-fg">
              {selected.note}
            </p>
          ) : null}
        </section>
      ) : null}

      {confirmDialog}
    </AppShell>
  );
}
