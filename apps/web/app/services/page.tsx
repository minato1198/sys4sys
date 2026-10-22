"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import { NavLinks } from "../components/NavLinks";

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
  defaultUser: string | null;
  enabled: boolean;
  state: "running" | "stopped" | "unknown";
}

interface HealthCheck {
  type: "http" | "tcp" | "process" | "command";
  url?: string;
  port?: number;
  command?: string[];
  intervalSec?: number;
  timeoutSec?: number;
  failures?: number;
}

interface HealthResult {
  serviceId: string;
  status: "healthy" | "unhealthy" | "unknown" | "stopped";
  latencyMs?: number;
  checkedAt: string;
  detail?: string;
  consecutiveFailures?: number;
}

interface RuntimeInfo {
  running: boolean;
  adopted: boolean;
  pid: number | null;
  pidScope: string | null;
  health: HealthResult | null;
}

interface Service {
  id: string;
  hostId: string;
  name: string;
  command: string[];
  cwd: string | null;
  env: Record<string, string> | null;
  expectedPorts: number[];
  healthCheck: HealthCheck | null;
  dependsOn: string[];
  autoStart: boolean;
  autoRestartPhase: "observe" | "approve" | "auto";
  status:
    "stopped" | "starting" | "running" | "degraded" | "restarting" | "failed";
  isActive: boolean;
  pid: number | null;
  pidScope: string | null;
  lastStartedAt: string | null;
  lastExitedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  host: Host | null;
  health: HealthResult | null;
  runtime: RuntimeInfo;
}

interface ServiceAction {
  id: string;
  type: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface ServiceDetail extends Service {
  recentActions: ServiceAction[];
}

interface Problem {
  detail?: string;
}

const EMPTY_FORM = {
  hostId: "",
  name: "",
  command: '["node.exe","worker.js"]',
  cwd: "",
  env: "{}",
  expectedPorts: "",
  autoStart: false,
  autoRestartPhase: "observe" as "observe" | "approve" | "auto",
  healthType: "" as "" | "http" | "tcp" | "process" | "command",
  healthUrl: "",
  healthPort: "",
  healthCommand: "",
  healthInterval: "10",
  healthTimeout: "3",
  healthFailures: "3",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function statusTone(status: Service["status"]): string {
  if (status === "running") return "text-signal-400";
  if (status === "degraded") return "text-warn-400";
  if (status === "failed") return "text-danger-400";
  if (status === "starting" || status === "restarting") return "text-sky-300";
  return "text-mist-400";
}

function statusDot(status: Service["status"]): string {
  if (status === "running") return "bg-signal-400";
  if (status === "degraded") return "bg-warn-400";
  if (status === "failed") return "bg-danger-400";
  if (status === "starting" || status === "restarting") return "bg-sky-300";
  return "bg-mist-400";
}

function HealthBadge({ health }: { health: HealthResult | null }) {
  if (!health) {
    return <span className="text-[11px] text-mist-400">未計測</span>;
  }
  const tone =
    health.status === "healthy"
      ? "bg-signal-400/15 text-signal-400"
      : health.status === "unhealthy"
        ? "bg-danger-400/15 text-danger-400"
        : health.status === "stopped"
          ? "bg-ink-800 text-mist-400"
          : "bg-warn-400/15 text-warn-400";
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit rounded px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      >
        {health.status}
      </span>
      {health.detail ? (
        <span
          className="max-w-44 truncate text-[10px] text-mist-400"
          title={health.detail}
        >
          {health.detail}
        </span>
      ) : null}
    </span>
  );
}

export default function ServicesPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ServiceDetail | null>(null);
  const [healthById, setHealthById] = useState<Record<string, HealthResult>>(
    {},
  );

  const load = useCallback(async () => {
    try {
      const [meResponse, servicesResponse, hostsResponse] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/services", { cache: "no-store" }),
        fetch("/api/hosts", { cache: "no-store" }),
      ]);
      if (
        meResponse.status === 401 ||
        servicesResponse.status === 401 ||
        hostsResponse.status === 401
      ) {
        window.location.href = "/login";
        return;
      }
      if (!meResponse.ok) throw new Error(`auth ${meResponse.status}`);
      if (!servicesResponse.ok)
        throw new Error(`services ${servicesResponse.status}`);
      if (!hostsResponse.ok) throw new Error(`hosts ${hostsResponse.status}`);

      const me = (await meResponse.json()) as AuthUser;
      const serviceList = (await servicesResponse.json()) as Service[];
      const hostList = (await hostsResponse.json()) as Host[];
      setUser(me);
      setServices(serviceList);
      setHosts(hostList);
      setForm((current) => {
        if (current.hostId) return current;
        const candidate = hostList.find((host) => host.enabled) ?? hostList[0];
        return candidate ? { ...current, hostId: candidate.id } : current;
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshServices = useCallback(async () => {
    const response = await fetch("/api/services", { cache: "no-store" });
    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (!response.ok) throw new Error(`services ${response.status}`);
    setServices((await response.json()) as Service[]);
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const canOperate = user?.role === "admin" || user?.role === "operator";
  const isAdmin = user?.role === "admin";

  const summary = useMemo(() => {
    const running = services.filter(
      (service) => service.status === "running",
    ).length;
    const degraded = services.filter(
      (service) => service.status === "degraded",
    ).length;
    const failed = services.filter(
      (service) => service.status === "failed",
    ).length;
    return { total: services.length, running, degraded, failed };
  }, [services]);

  async function runAction(
    service: Service,
    type: "start" | "stop" | "restart",
  ) {
    if (
      type === "stop" &&
      !window.confirm(`${service.name} を停止しますか？`)
    ) {
      return;
    }
    setBusyId(service.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(service.id)}/${type}`,
        { method: "POST" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `${type} に失敗しました (${response.status})`,
        );
      }
      setMessage(`${service.name} の ${type} を実行しました`);
      await refreshServices();
      if (selected?.id === service.id) await openDetail(service.id);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function checkHealth(service: Service) {
    setBusyId(service.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(service.id)}/health`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ??
            `ヘルスチェックに失敗しました (${response.status})`,
        );
      }
      const result = (await response.json()) as HealthResult;
      setHealthById((current) => ({ ...current, [service.id]: result }));
      setMessage(
        `${service.name}: ${result.status}${
          result.detail ? ` — ${result.detail}` : ""
        }`,
      );
      await refreshServices();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

  async function openDetail(id: string) {
    try {
      const response = await fetch(`/api/services/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      setSelected((await response.json()) as ServiceDetail);
    } catch {
      // 詳細は補助情報なので失敗しても一覧は維持する
    }
  }

  function editService(service: Service) {
    setEditingId(service.id);
    setForm({
      hostId: service.hostId,
      name: service.name,
      command: JSON.stringify(service.command, null, 0),
      cwd: service.cwd ?? "",
      env: JSON.stringify(service.env ?? {}, null, 0),
      expectedPorts: service.expectedPorts.join(", "),
      autoStart: service.autoStart,
      autoRestartPhase: service.autoRestartPhase,
      healthType: service.healthCheck?.type ?? "",
      healthUrl: service.healthCheck?.url ?? "",
      healthPort: service.healthCheck?.port
        ? String(service.healthCheck.port)
        : "",
      healthCommand: service.healthCheck?.command
        ? JSON.stringify(service.healthCheck.command)
        : "",
      healthInterval: String(service.healthCheck?.intervalSec ?? 10),
      healthTimeout: String(service.healthCheck?.timeoutSec ?? 3),
      healthFailures: String(service.healthCheck?.failures ?? 3),
    });
    setMessage(null);
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }

  function resetForm() {
    setEditingId(null);
    const candidate = hosts.find((host) => host.enabled) ?? hosts[0];
    setForm({ ...EMPTY_FORM, hostId: candidate?.id ?? "" });
  }

  async function submitService(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      let command: unknown;
      try {
        command = JSON.parse(form.command);
      } catch {
        throw new Error("command は JSON 配列で入力してください");
      }
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every((item) => typeof item === "string" && item.length > 0)
      ) {
        throw new Error("command は空でない文字列の配列にしてください");
      }

      let env: Record<string, string> | null = null;
      if (form.env.trim()) {
        try {
          const parsed = JSON.parse(form.env) as unknown;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Object.values(parsed).every((value) => typeof value === "string")
          ) {
            throw new Error("env は文字列のオブジェクトにしてください");
          }
          env = parsed as Record<string, string>;
        } catch (cause) {
          throw new Error(
            cause instanceof Error
              ? cause.message
              : "env は JSON オブジェクトで入力してください",
          );
        }
      }

      const expectedPorts = form.expectedPorts
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => Number(value));
      if (
        expectedPorts.some(
          (port) => !Number.isInteger(port) || port < 1 || port > 65535,
        )
      ) {
        throw new Error("expected ports は 1〜65535 の整数で入力してください");
      }

      let healthCheck: HealthCheck | null = null;
      if (form.healthType) {
        healthCheck = {
          type: form.healthType,
          intervalSec: Number(form.healthInterval) || 10,
          timeoutSec: Number(form.healthTimeout) || 3,
          failures: Number(form.healthFailures) || 3,
        };
        if (form.healthType === "http") {
          if (!form.healthUrl.trim())
            throw new Error("health URL を入力してください");
          healthCheck.url = form.healthUrl.trim();
        }
        if (form.healthType === "tcp") {
          const port = Number(form.healthPort);
          if (!Number.isInteger(port))
            throw new Error("health port を入力してください");
          healthCheck.port = port;
        }
        if (form.healthType === "command") {
          try {
            const parsed = JSON.parse(form.healthCommand) as unknown;
            if (
              !Array.isArray(parsed) ||
              parsed.length === 0 ||
              !parsed.every((item) => typeof item === "string")
            ) {
              throw new Error("health command は文字列の配列にしてください");
            }
            healthCheck.command = parsed as string[];
          } catch (cause) {
            throw new Error(
              cause instanceof Error
                ? cause.message
                : "health command は JSON 配列で入力してください",
            );
          }
        }
      }

      const payload = {
        hostId: form.hostId,
        name: form.name.trim(),
        command: command as string[],
        cwd: form.cwd.trim() || undefined,
        env: env ?? undefined,
        expectedPorts: expectedPorts.length > 0 ? expectedPorts : undefined,
        healthCheck: healthCheck ?? undefined,
        autoStart: form.autoStart,
        autoRestartPhase: form.autoRestartPhase,
      };

      const response = await fetch(
        editingId
          ? `/api/services/${encodeURIComponent(editingId)}`
          : "/api/services",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        throw new Error(
          problem?.detail ?? `保存に失敗しました (${response.status})`,
        );
      }
      setMessage(
        editingId ? "サービスを更新しました" : "サービスを登録しました",
      );
      resetForm();
      await refreshServices();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteService(service: Service) {
    if (!window.confirm(`${service.name} を削除しますか？`)) return;
    setBusyId(service.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(service.id)}`,
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
      setMessage(`${service.name} を削除しました`);
      if (selected?.id === service.id) setSelected(null);
      if (editingId === service.id) resetForm();
      await refreshServices();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyId(null);
    }
  }

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
              Services
            </h1>
            <p className="text-xs text-mist-400">
              Windows / WSL の自作 API・ワーカーを登録して起動・停止します。
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
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="mt-6 rounded-lg border border-signal-400/30 bg-signal-400/10 px-4 py-3 text-sm text-signal-400">
          {message}
        </div>
      ) : null}

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        {[
          { label: "Total", value: summary.total, tone: "text-white" },
          { label: "Running", value: summary.running, tone: "text-signal-400" },
          { label: "Degraded", value: summary.degraded, tone: "text-warn-400" },
          { label: "Failed", value: summary.failed, tone: "text-danger-400" },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4"
          >
            <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-mist-400">
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
            <h2 className="text-sm font-semibold text-white">登録サービス</h2>
            <p className="text-[11px] text-mist-400">
              10 秒ごとの自動更新はありません。操作後に再読み込みしてください。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshServices()}
            className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-signal-400/40 hover:text-white"
          >
            更新
          </button>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-700/70 bg-ink-950/40 text-[10px] uppercase tracking-[0.12em] text-mist-400">
                <th className="px-4 py-2 font-medium">Service</th>
                <th className="px-4 py-2 font-medium">Host</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">PID</th>
                <th className="px-4 py-2 font-medium">Ports</th>
                <th className="px-4 py-2 font-medium">Health</th>
                <th className="px-4 py-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/40">
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-mist-400"
                  >
                    読み込み中…
                  </td>
                </tr>
              ) : services.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-mist-400"
                  >
                    サービスがありません
                  </td>
                </tr>
              ) : (
                services.map((service) => {
                  const health = healthById[service.id] ?? service.health;
                  const busy = busyId === service.id;
                  return (
                    <tr
                      key={service.id}
                      className="align-top hover:bg-ink-800/40"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void openDetail(service.id)}
                          className="text-left text-sm font-medium text-white hover:text-signal-400"
                        >
                          {service.name}
                        </button>
                        <div
                          className="mt-0.5 max-w-72 truncate font-mono text-[10px] text-mist-400"
                          title={service.command.join(" ")}
                        >
                          {service.command.join(" ")}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                              service.host?.kind === "windows"
                                ? "bg-sky-400/15 text-sky-300"
                                : "bg-signal-400/15 text-signal-400"
                            }`}
                          >
                            {service.host?.kind?.toUpperCase() ?? "?"}
                          </span>
                          <span className="text-xs text-mist-200">
                            {service.host?.distro ?? service.host?.name ?? "—"}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 text-xs ${statusTone(service.status)}`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${statusDot(service.status)}`}
                          />
                          {service.status}
                        </span>
                        {service.lastError ? (
                          <div
                            className="mt-1 max-w-52 truncate text-[10px] text-danger-400"
                            title={service.lastError}
                          >
                            {service.lastError}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-mist-400">
                        {service.pid ?? "—"}
                        {service.pidScope ? (
                          <span className="ml-1 text-[10px] text-mist-400">
                            @{service.pidScope}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-mist-200">
                        {service.expectedPorts.length > 0
                          ? service.expectedPorts.join(", ")
                          : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <HealthBadge health={health} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          {canOperate ? (
                            <>
                              <button
                                type="button"
                                disabled={busy || service.status === "running"}
                                onClick={() => void runAction(service, "start")}
                                className="rounded border border-signal-400/30 bg-signal-400/10 px-2 py-1 text-[10px] text-signal-400 transition hover:bg-signal-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Start
                              </button>
                              <button
                                type="button"
                                disabled={busy || service.status === "stopped"}
                                onClick={() => void runAction(service, "stop")}
                                className="rounded border border-danger-400/30 bg-danger-400/10 px-2 py-1 text-[10px] text-danger-400 transition hover:bg-danger-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Stop
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void runAction(service, "restart")
                                }
                                className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-200 transition hover:border-signal-400/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Restart
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void checkHealth(service)}
                            className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-200 transition hover:border-signal-400/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Health
                          </button>
                          <Link
                            href={`/logs?serviceId=${encodeURIComponent(service.id)}`}
                            className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-200 transition hover:border-signal-400/40 hover:text-white"
                          >
                            Logs
                          </Link>
                          {isAdmin ? (
                            <>
                              <button
                                type="button"
                                disabled={busy || service.runtime.running}
                                onClick={() => editService(service)}
                                className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-200 transition hover:border-signal-400/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                disabled={busy || service.runtime.running}
                                onClick={() => void deleteService(service)}
                                className="rounded border border-danger-400/20 px-2 py-1 text-[10px] text-danger-400/80 transition hover:border-danger-400/50 hover:text-danger-400 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Delete
                              </button>
                            </>
                          ) : null}
                        </div>
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
        <section className="mt-6 rounded-xl border border-ink-700/70 bg-ink-900/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                {selected.name} の詳細
              </h2>
              <p className="mt-1 text-[11px] text-mist-400">
                last started {formatDate(selected.lastStartedAt)} / last exited{" "}
                {formatDate(selected.lastExitedAt)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 hover:text-white"
            >
              閉じる
            </button>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Configuration
              </div>
              <pre className="mt-2 overflow-x-auto font-mono text-[11px] text-mist-200">
                {JSON.stringify(
                  {
                    command: selected.command,
                    cwd: selected.cwd,
                    env: selected.env,
                    expectedPorts: selected.expectedPorts,
                    healthCheck: selected.healthCheck,
                    autoStart: selected.autoStart,
                    autoRestartPhase: selected.autoRestartPhase,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
            <div className="rounded-lg border border-ink-700 bg-ink-950/40 p-3">
              <div className="text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Recent actions
              </div>
              <div className="mt-2 space-y-1.5">
                {selected.recentActions.length === 0 ? (
                  <p className="text-[11px] text-mist-400">
                    操作履歴はありません
                  </p>
                ) : (
                  selected.recentActions.map((action) => (
                    <div
                      key={action.id}
                      className="flex items-center justify-between gap-3 rounded border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-[11px]"
                    >
                      <span className="text-mist-200">
                        {action.type} / {action.status}
                      </span>
                      <span className="font-mono text-[10px] text-mist-400">
                        {formatDate(action.startedAt)}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {isAdmin ? (
        <form
          onSubmit={submitService}
          className="mt-6 rounded-xl border border-ink-700/70 bg-ink-900/50 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-white">
                {editingId ? "サービスを編集" : "サービスを登録"}
              </h2>
              <p className="mt-1 text-[11px] text-mist-400">
                command は配列で指定します（シェル文字列は実行しません）。
                許可コマンドは SERVICE_COMMAND_ALLOWLIST で管理します。
              </p>
            </div>
            {editingId ? (
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-ink-700 px-2 py-1 text-[10px] text-mist-400 hover:text-white"
              >
                新規に切り替え
              </button>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Host
              </span>
              <select
                required
                value={form.hostId}
                onChange={(event) =>
                  setForm({ ...form, hostId: event.target.value })
                }
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              >
                <option value="">選択してください</option>
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.kind.toUpperCase()} / {host.name}
                    {host.distro ? ` (${host.distro})` : ""}
                    {host.enabled ? "" : " [disabled]"}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Name
              </span>
              <input
                required
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="api"
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Command (JSON array)
              </span>
              <textarea
                required
                rows={2}
                value={form.command}
                onChange={(event) =>
                  setForm({ ...form, command: event.target.value })
                }
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Working directory
              </span>
              <input
                value={form.cwd}
                onChange={(event) =>
                  setForm({ ...form, cwd: event.target.value })
                }
                placeholder="C:\\dev\\my-api または /home/me/app"
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Expected ports (comma separated)
              </span>
              <input
                value={form.expectedPorts}
                onChange={(event) =>
                  setForm({ ...form, expectedPorts: event.target.value })
                }
                placeholder="3001, 3002"
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Environment (JSON object)
              </span>
              <textarea
                rows={2}
                value={form.env}
                onChange={(event) =>
                  setForm({ ...form, env: event.target.value })
                }
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="flex items-center gap-2 rounded-md border border-ink-700 bg-ink-950/40 px-3 py-2 text-xs text-mist-200">
              <input
                type="checkbox"
                checked={form.autoStart}
                onChange={(event) =>
                  setForm({ ...form, autoStart: event.target.checked })
                }
                className="accent-signal-400"
              />
              autoStart
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Auto restart phase
              </span>
              <select
                value={form.autoRestartPhase}
                onChange={(event) =>
                  setForm({
                    ...form,
                    autoRestartPhase: event.target
                      .value as typeof form.autoRestartPhase,
                  })
                }
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              >
                <option value="observe">observe</option>
                <option value="approve">approve</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Health check
              </span>
              <select
                value={form.healthType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    healthType: event.target.value as typeof form.healthType,
                  })
                }
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
              >
                <option value="">none</option>
                <option value="http">http</option>
                <option value="tcp">tcp</option>
                <option value="process">process</option>
                <option value="command">command</option>
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                  Interval
                </span>
                <input
                  value={form.healthInterval}
                  onChange={(event) =>
                    setForm({ ...form, healthInterval: event.target.value })
                  }
                  className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                  Timeout
                </span>
                <input
                  value={form.healthTimeout}
                  onChange={(event) =>
                    setForm({ ...form, healthTimeout: event.target.value })
                  }
                  className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                  Failures
                </span>
                <input
                  value={form.healthFailures}
                  onChange={(event) =>
                    setForm({ ...form, healthFailures: event.target.value })
                  }
                  className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 focus:border-signal-400/40 focus:outline-none"
                />
              </label>
            </div>
          </div>

          {form.healthType === "http" || form.healthType === "tcp" ? (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {form.healthType === "http" ? (
                <label className="block md:col-span-2">
                  <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                    Health URL
                  </span>
                  <input
                    value={form.healthUrl}
                    onChange={(event) =>
                      setForm({ ...form, healthUrl: event.target.value })
                    }
                    placeholder="http://127.0.0.1:3001/health"
                    className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                    Health port
                  </span>
                  <input
                    value={form.healthPort}
                    onChange={(event) =>
                      setForm({ ...form, healthPort: event.target.value })
                    }
                    placeholder="3001"
                    className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
                  />
                </label>
              )}
            </div>
          ) : null}

          {form.healthType === "command" ? (
            <label className="mt-3 block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-mist-400">
                Health command (JSON array)
              </span>
              <input
                value={form.healthCommand}
                onChange={(event) =>
                  setForm({ ...form, healthCommand: event.target.value })
                }
                placeholder='["node.exe","-e","process.exit(0)"]'
                className="w-full rounded-md border border-ink-700 bg-ink-950/70 px-2 py-1.5 font-mono text-xs text-mist-200 placeholder:text-mist-400/50 focus:border-signal-400/40 focus:outline-none"
              />
            </label>
          ) : null}

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 rounded-md bg-signal-400 px-4 py-2 text-xs font-semibold text-ink-950 transition hover:bg-signal-400/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "保存中…" : editingId ? "更新する" : "登録する"}
          </button>
        </form>
      ) : (
        <p className="mt-6 rounded-lg border border-ink-700 bg-ink-900/50 px-4 py-3 text-xs text-mist-400">
          サービスの登録・編集・削除は管理者のみ実行できます。起動・停止・再起動は
          operator 以上で実行できます。
        </p>
      )}
    </main>
  );
}
