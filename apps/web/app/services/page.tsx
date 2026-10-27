"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
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

interface DeployConfig {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
  envKeys?: string[];
  timeoutSec?: number;
  restartAfter?: boolean;
  healthTimeoutSec?: number;
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
  env?: Record<string, string> | null;
  envKeys?: string[];
  expectedPorts: number[];
  healthCheck: HealthCheck | null;
  deploy: DeployConfig | null;
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
  lastDeployAt: string | null;
  lastDeployStatus: "running" | "succeeded" | "failed" | null;
  lastDeployError: string | null;
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
  deployRequestId?: string | null;
}

interface ServiceSecrets {
  env?: Record<string, string> | null;
  deployEnv?: Record<string, string> | null;
}

const ENV_MASK = "***";

type EnvMap = Record<string, string>;

function normalizeEnv(value: EnvMap | null | undefined): EnvMap {
  return value ?? {};
}

function sortedEnvKeys(value: EnvMap): string[] {
  return Object.keys(value).sort((a, b) => a.localeCompare(b));
}

function sameEnv(
  left: EnvMap | null | undefined,
  right: EnvMap | null | undefined,
): boolean {
  const a = normalizeEnv(left);
  const b = normalizeEnv(right);
  const aKeys = sortedEnvKeys(a);
  const bKeys = sortedEnvKeys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!bKeys.includes(key) || a[key] !== b[key]) return false;
  }
  return true;
}

function containsMaskedEnv(value: EnvMap | null | undefined): boolean {
  return Object.values(normalizeEnv(value)).some((item) => item === ENV_MASK);
}

function parseEnvObject(
  text: string,
  jsonMessage: string,
  objectMessage: string,
): EnvMap | null {
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(jsonMessage);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  ) {
    throw new Error(objectMessage);
  }
  return parsed as EnvMap;
}

function maskedEnvFromKeys(keys: string[] | undefined): EnvMap | null {
  if (!keys || keys.length === 0) return null;
  return Object.fromEntries(keys.map((key) => [key, ENV_MASK]));
}

function envValuesFromService(service: Service | ServiceDetail): EnvMap | null {
  if (service.env) return service.env;
  return maskedEnvFromKeys(service.envKeys);
}

function deployEnvValuesFromService(
  deploy: DeployConfig | null,
): EnvMap | null {
  if (deploy?.env) return deploy.env;
  return maskedEnvFromKeys(deploy?.envKeys);
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
  deployCommand: "",
  deployCwd: "",
  deployEnv: "",
  deployTimeout: "600",
  deployHealthTimeout: "120",
  deployRestartAfter: true,
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ja-JP", { hour12: false });
}

function statusTone(status: Service["status"]): string {
  if (status === "running") return "text-success";
  if (status === "degraded") return "text-warning";
  if (status === "failed") return "text-danger";
  if (status === "starting" || status === "restarting") return "text-info";
  return "text-fg-muted";
}

function statusDot(status: Service["status"]): string {
  if (status === "running") return "bg-success";
  if (status === "degraded") return "bg-warning";
  if (status === "failed") return "bg-danger";
  if (status === "starting" || status === "restarting") return "bg-sky-300";
  return "bg-mist-400";
}

function deployTone(status: Service["lastDeployStatus"]): string {
  if (status === "succeeded") return "text-success";
  if (status === "failed") return "text-danger";
  if (status === "running") return "text-info";
  return "text-fg-muted";
}

function HealthBadge({ health }: { health: HealthResult | null }) {
  if (!health) {
    return <span className="text-xs text-fg-muted">未計測</span>;
  }
  const tone =
    health.status === "healthy"
      ? "bg-success/15 text-success"
      : health.status === "unhealthy"
        ? "bg-danger/15 text-danger"
        : health.status === "stopped"
          ? "bg-surface-muted text-fg-muted"
          : "bg-warning/15 text-warning";
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span
        className={`inline-flex w-fit rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}
      >
        {health.status}
      </span>
      {health.detail ? (
        <span
          className="max-w-44 truncate text-xs text-fg-muted"
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
  const [envBaseline, setEnvBaseline] = useState<EnvMap | null>(null);
  const [deployEnvBaseline, setDeployEnvBaseline] = useState<EnvMap | null>(
    null,
  );
  const [revealing, setRevealing] = useState(false);
  const [healthById, setHealthById] = useState<Record<string, HealthResult>>(
    {},
  );
  const { requestConfirm, dialog: confirmDialog } = useConfirmDialog();

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
  ): Promise<string | null> {
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
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(text);
      return text;
    } finally {
      setBusyId(null);
    }
  }

  async function pollDeploy(id: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      try {
        const response = await fetch(
          `/api/services/${encodeURIComponent(id)}`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        const detail = (await response.json()) as ServiceDetail;
        setSelected((current) => (current?.id === id ? detail : current));
        if (detail.lastDeployStatus !== "running") {
          await refreshServices();
          setMessage(
            `${detail.name}: deploy ${detail.lastDeployStatus ?? "unknown"}${
              detail.lastDeployError ? ` — ${detail.lastDeployError}` : ""
            }`,
          );
          return;
        }
      } catch {
        return;
      }
    }
    await refreshServices().catch(() => undefined);
    setMessage(
      "デプロイ状態の確認がタイムアウトしました。Logs で [deploy] ログを確認してください。",
    );
  }

  async function runDeploy(service: Service): Promise<string | null> {
    if (!service.deploy) {
      setMessage("デプロイ設定がありません。Edit から登録してください。");
      return null;
    }

    setBusyId(service.id);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(service.id)}/deploy`,
        { method: "POST" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        if (
          response.status === 409 &&
          problem?.detail === "approval_required"
        ) {
          setMessage(
            `${service.name} のデプロイには承認が必要です。/approvals ページで承認待ちを確認してください${
              problem.deployRequestId
                ? `（要求 ID: ${problem.deployRequestId}）`
                : ""
            }。`,
          );
          return null;
        }
        throw new Error(
          problem?.detail ?? `デプロイに失敗しました (${response.status})`,
        );
      }
      setMessage(
        `${service.name} のデプロイを開始しました。進行状況は Logs の [deploy] ログで確認できます。`,
      );
      await refreshServices();
      if (selected?.id === service.id) await openDetail(service.id);
      void pollDeploy(service.id);
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(text);
      return text;
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

  async function editService(service: Service) {
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(service.id)}`,
        { cache: "no-store" },
      );
      if (response.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        setMessage(
          problem?.detail ??
            `編集用のサービス詳細を取得できませんでした (${response.status})`,
        );
        return;
      }

      const detail = (await response.json()) as ServiceDetail;
      const envValues = envValuesFromService(detail);
      const deployEnvValues = deployEnvValuesFromService(detail.deploy);
      setEditingId(service.id);
      setEnvBaseline(envValues);
      setDeployEnvBaseline(deployEnvValues);
      setForm({
        hostId: detail.hostId,
        name: detail.name,
        command: JSON.stringify(detail.command, null, 0),
        cwd: detail.cwd ?? "",
        env: envValues ? JSON.stringify(envValues, null, 0) : "{}",
        expectedPorts: detail.expectedPorts.join(", "),
        autoStart: detail.autoStart,
        autoRestartPhase: detail.autoRestartPhase,
        healthType: detail.healthCheck?.type ?? "",
        healthUrl: detail.healthCheck?.url ?? "",
        healthPort: detail.healthCheck?.port
          ? String(detail.healthCheck.port)
          : "",
        healthCommand: detail.healthCheck?.command
          ? JSON.stringify(detail.healthCheck.command)
          : "",
        healthInterval: String(detail.healthCheck?.intervalSec ?? 10),
        healthTimeout: String(detail.healthCheck?.timeoutSec ?? 3),
        healthFailures: String(detail.healthCheck?.failures ?? 3),
        deployCommand: detail.deploy
          ? JSON.stringify(detail.deploy.command)
          : "",
        deployCwd: detail.deploy?.cwd ?? "",
        deployEnv: deployEnvValues
          ? JSON.stringify(deployEnvValues, null, 2)
          : "",
        deployTimeout: String(detail.deploy?.timeoutSec ?? 600),
        deployHealthTimeout: String(detail.deploy?.healthTimeoutSec ?? 120),
        deployRestartAfter: detail.deploy?.restartAfter ?? true,
      });
      setMessage(null);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function resetForm() {
    setEditingId(null);
    setEnvBaseline(null);
    setDeployEnvBaseline(null);
    setRevealing(false);
    const candidate = hosts.find((host) => host.enabled) ?? hosts[0];
    setForm({ ...EMPTY_FORM, hostId: candidate?.id ?? "" });
  }

  function fillDeployExample() {
    setForm((current) => ({
      ...current,
      deployCommand:
        '["pwsh.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","deploy.ps1","-NoRestart"]',
      deployCwd: current.deployCwd || current.cwd,
      deployTimeout: current.deployTimeout || "600",
      deployHealthTimeout: current.deployHealthTimeout || "120",
      deployRestartAfter: true,
    }));
  }

  async function revealServiceEnv() {
    if (!editingId || !isAdmin) return;
    setRevealing(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/services/${encodeURIComponent(editingId)}/secrets`,
        { cache: "no-store" },
      );
      if (!response.ok) {
        const problem = (await response
          .json()
          .catch(() => null)) as Problem | null;
        if (response.status === 403) {
          throw new Error(
            problem?.detail ??
              "env を表示するには admin 権限と services:secrets スコープが必要です",
          );
        }
        throw new Error(
          problem?.detail ?? `env 表示に失敗しました (${response.status})`,
        );
      }

      const data = (await response.json()) as ServiceSecrets;
      const envValues = data.env ?? null;
      const deployEnvValues = data.deployEnv ?? null;
      setEnvBaseline(envValues);
      setDeployEnvBaseline(deployEnvValues);
      setForm((current) => ({
        ...current,
        env: envValues ? JSON.stringify(envValues, null, 0) : "{}",
        deployEnv: deployEnvValues
          ? JSON.stringify(deployEnvValues, null, 2)
          : "",
      }));
      setMessage(
        "env 値を表示しました。値を変更しない限り、保存時に PATCH へ env は送信されません。",
      );
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRevealing(false);
    }
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

      const env = parseEnvObject(
        form.env,
        "env は JSON オブジェクトで入力してください",
        "env は文字列のオブジェクトにしてください",
      );
      const envUnchanged = editingId ? sameEnv(env, envBaseline) : false;
      if (!envUnchanged && containsMaskedEnv(env)) {
        throw new Error(
          "env の既存値を変更する場合は Reveal で平文値を取得するか、変更しない env はそのまま保存してください",
        );
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

      let deploy: DeployConfig | null = null;
      if (form.deployCommand.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(form.deployCommand);
        } catch {
          throw new Error("deploy command は JSON 配列で入力してください");
        }
        if (
          !Array.isArray(parsed) ||
          parsed.length === 0 ||
          !parsed.every((item) => typeof item === "string" && item.length > 0)
        ) {
          throw new Error(
            "deploy command は空でない文字列の配列にしてください",
          );
        }

        const deployEnv = parseEnvObject(
          form.deployEnv,
          "deploy env は JSON オブジェクトで入力してください",
          "deploy env は文字列の値を持つ JSON オブジェクトにしてください",
        );
        const deployEnvUnchanged = editingId
          ? sameEnv(deployEnv, deployEnvBaseline)
          : false;
        if (!deployEnvUnchanged && containsMaskedEnv(deployEnv)) {
          throw new Error(
            "deploy env の既存値を変更する場合は Reveal で平文値を取得するか、変更しない deploy env はそのまま保存してください",
          );
        }

        const timeoutSec = Number(form.deployTimeout) || 600;
        const healthTimeoutSec = Number(form.deployHealthTimeout) || 120;
        if (
          !Number.isInteger(timeoutSec) ||
          timeoutSec < 10 ||
          timeoutSec > 3600
        ) {
          throw new Error("deploy timeout は 10-3600 の整数にしてください");
        }
        if (
          !Number.isInteger(healthTimeoutSec) ||
          healthTimeoutSec < 5 ||
          healthTimeoutSec > 900
        ) {
          throw new Error(
            "deploy health timeout は 5-900 の整数にしてください",
          );
        }

        deploy = {
          command: parsed as string[],
          timeoutSec,
          restartAfter: form.deployRestartAfter,
          healthTimeoutSec,
        };
        if (form.deployCwd.trim()) deploy.cwd = form.deployCwd.trim();
        if (!deployEnvUnchanged) {
          if (deployEnv) {
            deploy.env = deployEnv;
          } else if (editingId) {
            deploy.env = {};
          }
        }
      }

      const payload: Record<string, unknown> = {
        hostId: form.hostId,
        name: form.name.trim(),
        command: command as string[],
        cwd: form.cwd.trim() || undefined,
        expectedPorts: expectedPorts.length > 0 ? expectedPorts : undefined,
        healthCheck: healthCheck ?? undefined,
        deploy: deploy ?? (editingId ? null : undefined),
        autoStart: form.autoStart,
        autoRestartPhase: form.autoRestartPhase,
      };
      if (!envUnchanged) {
        payload.env = env;
      }

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

  async function deleteService(service: Service): Promise<string | null> {
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
      return null;
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      setMessage(text);
      return text;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell
      title="Services"
      description="Windows / WSL の自作 API・ワーカーを登録して起動・停止します。"
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

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        {[
          { label: "Total", value: summary.total, tone: "text-fg" },
          { label: "Running", value: summary.running, tone: "text-success" },
          { label: "Degraded", value: summary.degraded, tone: "text-warning" },
          { label: "Failed", value: summary.failed, tone: "text-danger" },
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
            <h2 className="text-sm font-semibold text-fg">登録サービス</h2>
            <p className="text-xs text-fg-muted">
              10 秒ごとの自動更新はありません。操作後に再読み込みしてください。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshServices()}
            className="rounded-md border border-border bg-surface-muted px-3 py-1.5 text-xs font-medium text-fg transition hover:border-success/40 hover:text-fg"
          >
            更新
          </button>
        </div>
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-xs text-fg-muted">
                <th scope="col" className="px-4 py-2 font-medium">
                  Service
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Host
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  PID
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Ports
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Health
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-fg-muted"
                  >
                    読み込み中…
                  </td>
                </tr>
              ) : services.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="px-4 py-8 text-center text-sm text-fg-muted"
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
                      className="align-top hover:bg-surface-muted"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => void openDetail(service.id)}
                          className="text-left text-sm font-medium text-fg hover:text-success"
                        >
                          {service.name}
                        </button>
                        <div
                          className="mt-0.5 max-w-72 truncate font-mono text-xs text-fg-muted"
                          title={service.command.join(" ")}
                        >
                          {service.command.join(" ")}
                        </div>
                        {service.deploy ? (
                          <div className="mt-1 max-w-72 text-xs text-fg-muted">
                            deploy:{" "}
                            <span
                              className={deployTone(service.lastDeployStatus)}
                            >
                              {service.lastDeployStatus ?? "not run"}
                            </span>
                            {service.lastDeployAt
                              ? ` · ${formatDate(service.lastDeployAt)}`
                              : ""}
                            {service.lastDeployError ? (
                              <div
                                className="max-w-72 truncate text-danger"
                                title={service.lastDeployError}
                              >
                                {service.lastDeployError}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                              service.host?.kind === "windows"
                                ? "bg-info/15 text-info"
                                : "bg-success/15 text-success"
                            }`}
                          >
                            {service.host?.kind?.toUpperCase() ?? "?"}
                          </span>
                          <span className="text-xs text-fg">
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
                            className="mt-1 max-w-52 truncate text-xs text-danger"
                            title={service.lastError}
                          >
                            {service.lastError}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                        {service.pid ?? "—"}
                        {service.pidScope ? (
                          <span className="ml-1 text-xs text-fg-muted">
                            @{service.pidScope}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-fg">
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
                                className="rounded border border-success/30 bg-success/10 px-2 py-1 text-xs text-success transition hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Start
                              </button>
                              <button
                                type="button"
                                disabled={busy || service.status === "stopped"}
                                onClick={() =>
                                  requestConfirm(
                                    {
                                      title: "サービスを停止しますか？",
                                      description:
                                        "稼働中のサービスを停止し、依存する接続を切ります。",
                                      target: (
                                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                          <dt className="text-fg-muted">
                                            Service
                                          </dt>
                                          <dd>{service.name}</dd>
                                          <dt className="text-fg-muted">
                                            Host
                                          </dt>
                                          <dd>
                                            {service.host?.name ?? "—"}
                                            {service.pidScope
                                              ? ` @${service.pidScope}`
                                              : ""}
                                          </dd>
                                          <dt className="text-fg-muted">PID</dt>
                                          <dd className="font-mono">
                                            {service.pid ?? "—"}
                                          </dd>
                                        </dl>
                                      ),
                                      impact:
                                        "停止後もプロセスが残る場合は、Ports から PID を確認してください。",
                                      confirmLabel: "停止",
                                    },
                                    () => runAction(service, "stop"),
                                  )
                                }
                                className="min-h-9 rounded border border-danger/30 bg-danger/10 px-2.5 py-1 text-xs text-danger transition hover:bg-danger/20 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Stop
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                  void runAction(service, "restart")
                                }
                                className="rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Restart
                              </button>
                              {service.deploy ? (
                                <button
                                  type="button"
                                  disabled={
                                    busy ||
                                    service.lastDeployStatus === "running"
                                  }
                                  onClick={() =>
                                    requestConfirm(
                                      {
                                        title: "デプロイしますか？",
                                        description:
                                          "登録されたデプロイコマンドを実行します。サービスが再起動する場合があります。",
                                        target: (
                                          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                            <dt className="text-fg-muted">
                                              Service
                                            </dt>
                                            <dd>{service.name}</dd>
                                            <dt className="text-fg-muted">
                                              Command
                                            </dt>
                                            <dd className="break-all font-mono">
                                              {service.deploy?.command.join(
                                                " ",
                                              ) ?? "—"}
                                            </dd>
                                            {service.deploy?.cwd ? (
                                              <>
                                                <dt className="text-fg-muted">
                                                  cwd
                                                </dt>
                                                <dd className="font-mono">
                                                  {service.deploy.cwd}
                                                </dd>
                                              </>
                                            ) : null}
                                          </dl>
                                        ),
                                        impact:
                                          "実行結果は Logs の [deploy] ログに記録されます。",
                                        confirmLabel: "デプロイ",
                                      },
                                      () => runDeploy(service),
                                    )
                                  }
                                  className="min-h-9 rounded border border-info/30 bg-info/10 px-2.5 py-1 text-xs text-info transition hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  {service.lastDeployStatus === "running"
                                    ? "Deploying…"
                                    : "Deploy"}
                                </button>
                              ) : null}
                            </>
                          ) : null}
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void checkHealth(service)}
                            className="rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            Health
                          </button>
                          <Link
                            href={`/logs?serviceId=${encodeURIComponent(service.id)}`}
                            className="rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg"
                          >
                            Logs
                          </Link>
                          {isAdmin ? (
                            <>
                              <button
                                type="button"
                                disabled={busy || service.runtime.running}
                                onClick={() => void editService(service)}
                                className="rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                disabled={busy || service.runtime.running}
                                onClick={() =>
                                  requestConfirm(
                                    {
                                      title: "サービスを削除しますか？",
                                      description:
                                        "サービス定義と監視設定を削除します。",
                                      target: (
                                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                                          <dt className="text-fg-muted">
                                            Service
                                          </dt>
                                          <dd>{service.name}</dd>
                                          <dt className="text-fg-muted">
                                            Host
                                          </dt>
                                          <dd>{service.host?.name ?? "—"}</dd>
                                          <dt className="text-fg-muted">
                                            Status
                                          </dt>
                                          <dd>{service.status}</dd>
                                        </dl>
                                      ),
                                      impact:
                                        "削除しても、実際に稼働しているプロセスは停止されません。停止が必要な場合は先に Stop を実行してください。",
                                      confirmLabel: "削除",
                                    },
                                    () => deleteService(service),
                                  )
                                }
                                className="min-h-9 rounded border border-danger/20 px-2.5 py-1 text-xs text-danger transition hover:border-danger/50 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
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
        <section className="mt-6 rounded-xl border border-border bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                {selected.name} の詳細
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                last started {formatDate(selected.lastStartedAt)} / last exited{" "}
                {formatDate(selected.lastExitedAt)}
              </p>
              <p className="mt-1 text-xs text-fg-muted">
                last deploy {formatDate(selected.lastDeployAt)} /{" "}
                <span className={deployTone(selected.lastDeployStatus)}>
                  {selected.lastDeployStatus ?? "not run"}
                </span>
                {selected.lastDeployError ? (
                  <span className="text-danger">
                    {" "}
                    — {selected.lastDeployError}
                  </span>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
            >
              閉じる
            </button>
          </div>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-border bg-surface-muted p-3">
              <div className="text-xs text-fg-muted">Configuration</div>
              <pre className="mt-2 overflow-x-auto font-mono text-xs text-fg">
                {JSON.stringify(
                  {
                    command: selected.command,
                    cwd: selected.cwd,
                    env: selected.env ?? null,
                    envKeys: selected.envKeys ?? [],
                    expectedPorts: selected.expectedPorts,
                    healthCheck: selected.healthCheck,
                    deploy: selected.deploy,
                    autoStart: selected.autoStart,
                    autoRestartPhase: selected.autoRestartPhase,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
            <div className="rounded-lg border border-border bg-surface-muted p-3">
              <div className="text-xs text-fg-muted">Recent actions</div>
              <div className="mt-2 space-y-1.5">
                {selected.recentActions.length === 0 ? (
                  <p className="text-xs text-fg-muted">操作履歴はありません</p>
                ) : (
                  selected.recentActions.map((action) => (
                    <div
                      key={action.id}
                      className="flex items-center justify-between gap-3 rounded border border-border bg-surface px-2 py-1.5 text-xs"
                    >
                      <span className="text-fg">
                        {action.type} / {action.status}
                      </span>
                      <span className="font-mono text-xs text-fg-muted">
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
          className="mt-6 rounded-xl border border-border bg-surface p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-fg">
                {editingId ? "サービスを編集" : "サービスを登録"}
              </h2>
              <p className="mt-1 text-xs text-fg-muted">
                command は配列で指定します（シェル文字列は実行しません）。
                許可コマンドは SERVICE_COMMAND_ALLOWLIST で管理します。
              </p>
            </div>
            {editingId ? (
              <button
                type="button"
                onClick={resetForm}
                className="rounded border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
              >
                新規に切り替え
              </button>
            ) : null}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">Host</span>
              <select
                required
                value={form.hostId}
                onChange={(event) =>
                  setForm({ ...form, hostId: event.target.value })
                }
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
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
              <span className="mb-1 block text-xs text-fg-muted">Name</span>
              <input
                required
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="api"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-xs text-fg-muted">
                Command (JSON array)
              </span>
              <textarea
                required
                rows={2}
                value={form.command}
                onChange={(event) =>
                  setForm({ ...form, command: event.target.value })
                }
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">
                Working directory
              </span>
              <input
                value={form.cwd}
                onChange={(event) =>
                  setForm({ ...form, cwd: event.target.value })
                }
                placeholder="C:\\dev\\my-api または /home/me/app"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">
                Expected ports (comma separated)
              </span>
              <input
                value={form.expectedPorts}
                onChange={(event) =>
                  setForm({ ...form, expectedPorts: event.target.value })
                }
                placeholder="3001, 3002"
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
            <label className="block md:col-span-2">
              <span className="mb-1 block text-xs text-fg-muted">
                Environment (JSON object)
              </span>
              <textarea
                rows={2}
                value={form.env}
                onChange={(event) =>
                  setForm({ ...form, env: event.target.value })
                }
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
              />
              {editingId ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={revealing}
                    onClick={() => void revealServiceEnv()}
                    className="rounded border border-success/30 bg-success/10 px-2 py-1 text-xs text-success transition hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {revealing ? "表示中…" : "Reveal env"}
                  </button>
                  <span className="text-xs text-fg-muted">
                    env は通常 *** で表示します。保存時に値を変えなければ PATCH
                    には送信しません。
                  </span>
                </div>
              ) : null}
            </label>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            <label className="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs text-fg">
              <input
                type="checkbox"
                checked={form.autoStart}
                onChange={(event) =>
                  setForm({ ...form, autoStart: event.target.checked })
                }
                className="accent-success"
              />
              autoStart
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">
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
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
              >
                <option value="observe">observe</option>
                <option value="approve">approve</option>
                <option value="auto">auto</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-fg-muted">
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
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg focus:border-success/40"
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
                <span className="mb-1 block text-xs text-fg-muted">
                  Interval
                </span>
                <input
                  value={form.healthInterval}
                  onChange={(event) =>
                    setForm({ ...form, healthInterval: event.target.value })
                  }
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">
                  Timeout
                </span>
                <input
                  value={form.healthTimeout}
                  onChange={(event) =>
                    setForm({ ...form, healthTimeout: event.target.value })
                  }
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">
                  Failures
                </span>
                <input
                  value={form.healthFailures}
                  onChange={(event) =>
                    setForm({ ...form, healthFailures: event.target.value })
                  }
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
                />
              </label>
            </div>
          </div>

          {form.healthType === "http" || form.healthType === "tcp" ? (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {form.healthType === "http" ? (
                <label className="block md:col-span-2">
                  <span className="mb-1 block text-xs text-fg-muted">
                    Health URL
                  </span>
                  <input
                    value={form.healthUrl}
                    onChange={(event) =>
                      setForm({ ...form, healthUrl: event.target.value })
                    }
                    placeholder="http://127.0.0.1:3001/health"
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                  />
                </label>
              ) : (
                <label className="block">
                  <span className="mb-1 block text-xs text-fg-muted">
                    Health port
                  </span>
                  <input
                    value={form.healthPort}
                    onChange={(event) =>
                      setForm({ ...form, healthPort: event.target.value })
                    }
                    placeholder="3001"
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                  />
                </label>
              )}
            </div>
          ) : null}

          {form.healthType === "command" ? (
            <label className="mt-3 block">
              <span className="mb-1 block text-xs text-fg-muted">
                Health command (JSON array)
              </span>
              <input
                value={form.healthCommand}
                onChange={(event) =>
                  setForm({ ...form, healthCommand: event.target.value })
                }
                placeholder='["node.exe","-e","process.exit(0)"]'
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
              />
            </label>
          ) : null}

          <div className="mt-5 rounded-lg border border-border bg-surface-muted p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-xs text-fg-muted">Deploy</div>
                <p className="mt-1 text-xs text-fg-muted">
                  deploy.ps1 などの実行コマンドを登録します。成功後に sys4sys
                  がサービスを再起動し、ヘルス確認します。
                </p>
              </div>
              <button
                type="button"
                onClick={fillDeployExample}
                className="rounded border border-border px-2 py-1 text-xs text-fg transition hover:border-success/40 hover:text-fg"
              >
                deploy.ps1 の例を入力
              </button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-fg-muted">
                  Deploy command (JSON array)
                </span>
                <textarea
                  rows={2}
                  value={form.deployCommand}
                  onChange={(event) =>
                    setForm({ ...form, deployCommand: event.target.value })
                  }
                  placeholder='["pwsh.exe","-NoProfile","-ExecutionPolicy","Bypass","-File","deploy.ps1","-NoRestart"]'
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
                <span className="mt-1 block text-xs text-fg-muted">
                  空欄でデプロイ設定なし。deploy.ps1 側で再起動する場合は
                  restartAfter を OFF にしてください。
                </span>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-fg-muted">
                  Deploy working directory
                </span>
                <input
                  value={form.deployCwd}
                  onChange={(event) =>
                    setForm({ ...form, deployCwd: event.target.value })
                  }
                  placeholder="(service cwd)"
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-fg-muted">
                    Timeout (sec)
                  </span>
                  <input
                    value={form.deployTimeout}
                    onChange={(event) =>
                      setForm({ ...form, deployTimeout: event.target.value })
                    }
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-fg-muted">
                    Health timeout (sec)
                  </span>
                  <input
                    value={form.deployHealthTimeout}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        deployHealthTimeout: event.target.value,
                      })
                    }
                    className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg focus:border-success/40"
                  />
                </label>
              </div>
              <label className="block md:col-span-2">
                <span className="mb-1 block text-xs text-fg-muted">
                  Deploy env (JSON object, optional)
                </span>
                <textarea
                  rows={2}
                  value={form.deployEnv}
                  onChange={(event) =>
                    setForm({ ...form, deployEnv: event.target.value })
                  }
                  placeholder='{"NODE_ENV":"production"}'
                  className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-muted focus:border-success/40"
                />
              </label>
              <label className="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-3 py-2 text-xs text-fg md:col-span-2">
                <input
                  type="checkbox"
                  checked={form.deployRestartAfter}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      deployRestartAfter: event.target.checked,
                    })
                  }
                  className="accent-success"
                />
                Restart service after successful deploy
              </label>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="mt-4 rounded-md bg-success px-4 py-2 text-xs font-semibold text-ink-950 transition hover:bg-success/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "保存中…" : editingId ? "更新する" : "登録する"}
          </button>
        </form>
      ) : (
        <p className="mt-6 rounded-lg border border-border bg-surface px-4 py-3 text-xs text-fg-muted">
          サービスの登録・編集・削除は管理者のみ実行できます。起動・停止・再起動は
          operator 以上で実行できます。
        </p>
      )}

      {confirmDialog}
    </AppShell>
  );
}
