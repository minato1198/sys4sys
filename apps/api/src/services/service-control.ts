import {
  decodeCommandOutput,
  ExternalCommandError,
  runFile,
} from "@sys4sys/agent";
import { config } from "../config.js";
import type { services } from "../db/schema.js";

export type ExternalServiceState =
  "running" | "stopped" | "starting" | "stopping" | "degraded" | "unknown";

export interface ServiceInspection {
  state: ExternalServiceState;
  pid: number | null;
  exitCode: number | null;
  missing?: boolean;
  detail?: string;
}

export interface ServiceController {
  inspect(service: ServiceRow): Promise<ServiceInspection>;
  start(service: ServiceRow): Promise<ServiceInspection>;
  stop(service: ServiceRow): Promise<ServiceInspection>;
  restart(service: ServiceRow): Promise<ServiceInspection>;
}

export type ServiceRow = typeof services.$inferSelect;

export type ServiceControlErrorCode =
  "not_found" | "access_denied" | "timeout" | "failed" | "unknown";

export class ServiceControlError extends Error {
  constructor(
    readonly code: ServiceControlErrorCode,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "ServiceControlError";
  }

  get statusCode(): number {
    if (this.code === "failed") return 502;
    return 503;
  }
}

const INSPECT_SCRIPT = `
$ErrorActionPreference = "Stop"
$name = $env:SYS4SYS_SERVICE_NAME
if ([string]::IsNullOrWhiteSpace($name)) {
  Write-Output '{"missing":true,"detail":"service name is empty"}'
  exit 0
}
$svc = Get-CimInstance -ClassName Win32_Service |
  Where-Object { $_.Name -eq $name } |
  Select-Object -First 1
if ($null -eq $svc) {
  [pscustomobject]@{ missing = $true; detail = "service not found" } |
    ConvertTo-Json -Compress
  exit 0
}
[pscustomobject]@{
  missing = $false
  name = [string]$svc.Name
  state = [string]$svc.State
  pid = [int]$svc.ProcessId
  exitCode = [int]$svc.ExitCode
} | ConvertTo-Json -Compress
`.trim();

interface InspectionPayload {
  missing?: unknown;
  state?: unknown;
  pid?: unknown;
  exitCode?: unknown;
  detail?: unknown;
}

export function mapScmState(value: unknown): ExternalServiceState {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "start pending":
      return "starting";
    case "stop pending":
      return "stopping";
    case "paused":
    case "paused pending":
      return "degraded";
    default:
      return "unknown";
  }
}

function extractBalancedJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
      if (depth < 0) return null;
    }
  }

  return null;
}

function findLastJsonObject(text: string): string | null {
  let candidate: string | null = null;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const json = extractBalancedJsonObject(text, index);
    if (!json) continue;
    try {
      JSON.parse(json);
      candidate = json;
      index += json.length - 1;
    } catch {
      // Continue scanning; PowerShell may emit CLIXML or diagnostics around JSON.
    }
  }

  return candidate;
}

export function parseInspectionPayload(output: string): ServiceInspection {
  const text = output.trim();
  if (!text) {
    return {
      state: "unknown",
      pid: null,
      exitCode: null,
      detail: "SCM 状態の出力が空です",
    };
  }

  const jsonText = findLastJsonObject(text);
  if (!jsonText) {
    return {
      state: "unknown",
      pid: null,
      exitCode: null,
      detail: `SCM 状態を解析できません: ${text.slice(0, 500)}`,
    };
  }

  let payload: InspectionPayload;
  try {
    payload = JSON.parse(jsonText) as InspectionPayload;
  } catch {
    return {
      state: "unknown",
      pid: null,
      exitCode: null,
      detail: `SCM 状態の JSON が不正です: ${jsonText.slice(0, 500)}`,
    };
  }

  if (payload.missing === true) {
    return {
      state: "unknown",
      pid: null,
      exitCode: null,
      missing: true,
      detail:
        typeof payload.detail === "string"
          ? payload.detail
          : "サービスが見つかりません",
    };
  }

  const pid =
    typeof payload.pid === "number" && payload.pid > 0 ? payload.pid : null;
  const exitCode =
    typeof payload.exitCode === "number" && Number.isFinite(payload.exitCode)
      ? payload.exitCode
      : null;

  return {
    state: mapScmState(payload.state),
    pid,
    exitCode,
    missing: false,
  };
}

export function scExitCodeToError(
  action: "start" | "stop",
  exitCode: number | null,
  stderr: string,
): ServiceControlError | null {
  if (exitCode === null || exitCode === 0) return null;
  if (action === "start" && exitCode === 1056) return null;
  if (action === "stop" && exitCode === 1062) return null;
  if (exitCode === 1060) {
    return new ServiceControlError(
      "not_found",
      "Windows サービスが見つかりません",
      exitCode,
    );
  }
  if (exitCode === 5) {
    return new ServiceControlError(
      "access_denied",
      "Windows サービスを操作する権限がありません",
      exitCode,
    );
  }
  const detail = stderr.trim();
  return new ServiceControlError(
    "failed",
    `Windows サービスの ${action} に失敗しました (exit=${exitCode})${
      detail ? `: ${detail.slice(0, 500)}` : ""
    }`,
    exitCode,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function serviceNameOf(service: ServiceRow): string {
  const name = service.serviceName?.trim();
  if (!name) {
    throw new ServiceControlError(
      "not_found",
      "Windows サービスの serviceName が設定されていません",
    );
  }
  return name;
}

export class WindowsServiceController implements ServiceController {
  constructor(
    private readonly exec: typeof runFile = runFile,
    private readonly options: {
      timeoutMs: number;
      pollMs: number;
      powershell?: string;
    } = {
      timeoutMs: config.SERVICE_CONTROL_TIMEOUT_MS,
      pollMs: config.SERVICE_CONTROL_POLL_MS,
      powershell: "powershell.exe",
    },
  ) {}

  async inspect(service: ServiceRow): Promise<ServiceInspection> {
    if (process.platform !== "win32") {
      return {
        state: "unknown",
        pid: null,
        exitCode: null,
        detail: "Windows 以外では SCM を照会できません",
      };
    }

    let name: string;
    try {
      name = serviceNameOf(service);
    } catch (error) {
      if (error instanceof ServiceControlError) {
        return {
          state: "unknown",
          pid: null,
          exitCode: null,
          missing: true,
          detail: error.message,
        };
      }
      throw error;
    }

    try {
      const output = await this.exec(
        this.options.powershell ?? "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", INSPECT_SCRIPT],
        this.options.timeoutMs,
        { ...process.env, SYS4SYS_SERVICE_NAME: name },
      );
      return parseInspectionPayload(decodeCommandOutput(output));
    } catch (error) {
      if (error instanceof ExternalCommandError) {
        if (error.timedOut) {
          return {
            state: "unknown",
            pid: null,
            exitCode: null,
            detail: "SCM 状態の照会がタイムアウトしました",
          };
        }
        return {
          state: "unknown",
          pid: null,
          exitCode: error.exitCode,
          detail: decodeCommandOutput(error.stderr).trim().slice(0, 500),
        };
      }
      return {
        state: "unknown",
        pid: null,
        exitCode: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async requireInspection(
    service: ServiceRow,
  ): Promise<ServiceInspection> {
    const inspection = await this.inspect(service);
    if (inspection.missing) {
      throw new ServiceControlError(
        "not_found",
        "Windows サービスが見つかりません",
      );
    }
    if (inspection.state === "unknown" && inspection.detail) {
      throw new ServiceControlError("unknown", inspection.detail);
    }
    return inspection;
  }

  private async runSc(
    action: "start" | "stop",
    service: ServiceRow,
  ): Promise<void> {
    if (process.platform !== "win32") {
      throw new ServiceControlError(
        "unknown",
        "Windows 以外では SCM を操作できません",
      );
    }
    const name = serviceNameOf(service);
    try {
      await this.exec("sc.exe", [action, name], this.options.timeoutMs);
    } catch (error) {
      if (error instanceof ExternalCommandError) {
        if (error.timedOut) {
          throw new ServiceControlError(
            "timeout",
            `Windows サービスの ${action} がタイムアウトしました`,
          );
        }
        const mapped = scExitCodeToError(
          action,
          error.exitCode,
          decodeCommandOutput(error.stderr),
        );
        if (!mapped) return;
        throw mapped;
      }
      throw new ServiceControlError(
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async waitForState(
    service: ServiceRow,
    accept: ExternalServiceState[],
    description: string,
  ): Promise<ServiceInspection> {
    const deadline = Date.now() + this.options.timeoutMs;
    let last: ServiceInspection = {
      state: "unknown",
      pid: null,
      exitCode: null,
    };

    while (Date.now() < deadline) {
      last = await this.requireInspection(service);
      if (accept.includes(last.state)) return last;
      await sleep(this.options.pollMs);
    }

    throw new ServiceControlError(
      "timeout",
      `Windows サービスが ${description} になりませんでした (last=${last.state})`,
    );
  }

  async start(service: ServiceRow): Promise<ServiceInspection> {
    const current = await this.requireInspection(service);
    if (current.state === "running" || current.state === "degraded") {
      return current;
    }
    if (current.state === "starting") {
      return this.waitForState(service, ["running", "degraded"], "Running");
    }
    if (current.state === "stopping") {
      await this.waitForState(service, ["stopped"], "Stopped");
    }

    await this.runSc("start", service);
    return this.waitForState(service, ["running", "degraded"], "Running");
  }

  async stop(service: ServiceRow): Promise<ServiceInspection> {
    const current = await this.requireInspection(service);
    if (current.state === "stopped") {
      return current;
    }
    if (current.state === "stopping") {
      return this.waitForState(service, ["stopped"], "Stopped");
    }

    await this.runSc("stop", service);
    return this.waitForState(service, ["stopped"], "Stopped");
  }

  async restart(service: ServiceRow): Promise<ServiceInspection> {
    const current = await this.requireInspection(service);
    if (current.state !== "stopped") {
      await this.stop(service);
    }
    return this.start(service);
  }
}

export function getServiceController(
  service: ServiceRow,
): ServiceController | null {
  if (service.controlMode !== "windows-service") return null;
  return new WindowsServiceController();
}
