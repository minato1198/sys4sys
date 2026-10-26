import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AuthMe } from "@sys4sys/shared";
import {
  createCredentialStore,
  resolveCredentials,
  type CredentialStore,
  type ResolvedCredentials,
} from "../auth/store.js";
import { ApiClient, DEFAULT_API_URL, normalizeApiUrl } from "../client.js";
import { printJson, writeOut, type CliOutput } from "../output.js";

const execFileAsync = promisify(execFile);

export type DoctorStatus = "ok" | "warn" | "error" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  store?: CredentialStore;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  platform?: NodeJS.Platform;
  nodeVersion?: string;
  whoami?: () => Promise<AuthMe>;
  wslCheck?: () => Promise<boolean>;
  configDirWritable?: () => Promise<boolean>;
  json?: boolean;
  strict?: boolean;
  output?: CliOutput;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceLabel(source: ResolvedCredentials["source"]): string {
  switch (source) {
    case "env-token":
    case "token-file":
    case "stored-token":
      return "token";
    case "env-cookie":
    case "stored-cookie":
      return "session";
    case "password":
      return "password";
    default:
      return "none";
  }
}

function authClient(resolved: ResolvedCredentials): ApiClient {
  return new ApiClient({
    apiUrl: resolved.apiUrl,
    token: resolved.token,
    sessionCookie: resolved.sessionCookie,
    email: resolved.email,
    password: resolved.password,
  });
}

function tokenExpiryCheck(
  resolved: ResolvedCredentials,
  now: Date,
): DoctorCheck | null {
  if (resolved.source !== "stored-token" || !resolved.tokenExpiresAt) {
    return null;
  }
  const expires = new Date(resolved.tokenExpiresAt);
  if (Number.isNaN(expires.getTime())) {
    return {
      name: "token-expires",
      status: "warn",
      detail: `期限を解析できません: ${resolved.tokenExpiresAt}`,
      hint: "`sys4sys tokens list` で保存済みトークンの状態を確認してください。",
    };
  }

  const remainingMs = expires.getTime() - now.getTime();
  const days = Math.ceil(remainingMs / 86_400_000);
  const detail = `${expires.toISOString()} (${days} days)`;
  if (remainingMs <= 0) {
    return {
      name: "token-expires",
      status: "error",
      detail,
      hint: "トークンの有効期限が切れています。再発行して auth login し直してください。",
    };
  }
  if (days <= 7) {
    return {
      name: "token-expires",
      status: "warn",
      detail,
      hint: "期限が近いため、計画的にローテーションしてください。",
    };
  }
  return { name: "token-expires", status: "ok", detail };
}

function credentialsCheck(
  store: CredentialStore,
  stored: ResolvedCredentials["stored"],
  platform: NodeJS.Platform,
): Promise<DoctorCheck> {
  return (async () => {
    const path = store.path();
    try {
      const info = await stat(path);
      if (platform === "win32") {
        return {
          name: "credentials",
          status: "ok",
          detail: `${path} (Windows ACL best-effort)`,
        };
      }
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        return {
          name: "credentials",
          status: "warn",
          detail: `${path} (mode ${mode.toString(8)})`,
          hint: "chmod 600 で資格情報ファイルの権限を絞ってください。",
        };
      }
      return {
        name: "credentials",
        status: "ok",
        detail: `${path} (mode ${mode.toString(8)})`,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          name: "credentials",
          status: stored ? "warn" : "ok",
          detail: `${path} (not created)`,
          hint: stored
            ? "資格情報の読み込み元と保存先が一致しているか確認してください。"
            : "環境変数または auth login で認証できます。",
        };
      }
      return {
        name: "credentials",
        status: "error",
        detail: `${path}: ${errorMessage(error)}`,
      };
    }
  })();
}

async function configDirCheck(store: CredentialStore): Promise<DoctorCheck> {
  const directory = dirname(store.path());
  const probe = `${directory}/.doctor-${randomUUID()}`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(probe, "ok", { mode: 0o600 });
    await rm(probe, { force: true });
    return {
      name: "config-dir",
      status: "ok",
      detail: `${directory} (writable)`,
    };
  } catch (error) {
    return {
      name: "config-dir",
      status: "error",
      detail: `${directory}: ${errorMessage(error)}`,
      hint: "SYS4SYS_CONFIG_DIR を書き込み可能なディレクトリに変更してください。",
    };
  }
}

async function defaultWslCheck(): Promise<boolean> {
  try {
    await execFileAsync("wsl.exe", ["--status"], {
      timeout: 2_500,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

export async function collectDoctorChecks(
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const now = (options.now ?? (() => new Date()))();
  const fetchImpl = options.fetchImpl ?? fetch;
  const store = options.store ?? createCredentialStore(env);
  const checks: DoctorCheck[] = [];

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= 22 ? "ok" : "error",
    detail: `v${nodeVersion}`,
    hint: nodeMajor >= 22 ? undefined : "Node.js 22 以上が必要です。",
  });

  let resolved: ResolvedCredentials;
  let resolvedError: string | null = null;
  try {
    resolved = await resolveCredentials({
      apiUrl: options.apiUrl,
      store,
      env,
      cwd: process.cwd(),
    });
  } catch (error) {
    resolvedError = errorMessage(error);
    resolved = { apiUrl: options.apiUrl, source: "none", stored: null };
  }

  const rawApiUrl =
    resolved.apiUrl?.trim() || env.SYS4SYS_API_URL?.trim() || DEFAULT_API_URL;
  let apiUrl: string | null = null;
  try {
    apiUrl = normalizeApiUrl(rawApiUrl);
    checks.push({ name: "api-url", status: "ok", detail: apiUrl });
  } catch (error) {
    checks.push({
      name: "api-url",
      status: "error",
      detail: errorMessage(error),
      hint: "SYS4SYS_API_URL または --api に http(s) の URL を指定してください。",
    });
  }

  let serverDate: Date | null = null;
  if (apiUrl) {
    try {
      const response = await fetchImpl(`${apiUrl}/api/health`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      await response.body?.cancel();
      checks.push({
        name: "api",
        status: response.ok ? "ok" : "error",
        detail: `${apiUrl} (${response.status})`,
        hint: response.ok
          ? undefined
          : "API が起動しているか、URL とリバースプロキシを確認してください。",
      });
      const dateHeader = response.headers.get("date");
      if (dateHeader) {
        const parsed = new Date(dateHeader);
        if (!Number.isNaN(parsed.getTime())) serverDate = parsed;
      }
    } catch (error) {
      checks.push({
        name: "api",
        status: "error",
        detail: `${apiUrl}: ${errorMessage(error)}`,
        hint: "API の起動状態、ファイアウォール、URL を確認してください。",
      });
    }
  }

  if (resolvedError) {
    checks.push({
      name: "auth",
      status: "error",
      detail: `資格情報を読み込めません: ${resolvedError}`,
      hint: "資格情報ファイルの内容を確認し、必要なら auth login し直してください。",
    });
  } else if (resolved.source === "none") {
    checks.push({
      name: "auth",
      status: "warn",
      detail: "未ログイン",
      hint: "sys4sys auth login を実行するか、SYS4SYS_TOKEN を設定してください。",
    });
  } else {
    try {
      const me = await (options.whoami
        ? options.whoami()
        : authClient(resolved).whoami());
      const prefix = resolved.tokenPrefix ? ` ${resolved.tokenPrefix}` : "";
      checks.push({
        name: "auth",
        status: "ok",
        detail: `${sourceLabel(resolved.source)}${prefix} (${me.role})`,
      });
      checks.push({
        name: "scopes",
        status: me.scopes.length > 0 ? "ok" : "warn",
        detail: me.scopes.length > 0 ? me.scopes.join(", ") : "(none)",
        hint:
          me.scopes.length > 0
            ? undefined
            : "必要なスコープを持つトークンを発行してください。",
      });
    } catch (error) {
      checks.push({
        name: "auth",
        status: "error",
        detail: `${sourceLabel(resolved.source)}: ${errorMessage(error)}`,
        hint: "トークンまたはセッションの有効性を確認してください。",
      });
    }
  }

  const expiry = tokenExpiryCheck(resolved, now);
  if (expiry) checks.push(expiry);

  if (resolved.stored?.token && resolved.stored?.sessionCookie) {
    checks.push({
      name: "duplicate-credentials",
      status: "warn",
      detail: "token と session の両方が保存されています",
      hint: "使用しない資格情報を削除してください。token が優先されます。",
    });
  } else {
    checks.push({
      name: "duplicate-credentials",
      status: "ok",
      detail: "重複なし",
    });
  }

  if (serverDate) {
    const skewSec = Math.round((now.getTime() - serverDate.getTime()) / 1000);
    checks.push({
      name: "clock-skew",
      status: Math.abs(skewSec) <= 300 ? "ok" : "warn",
      detail: `${skewSec >= 0 ? "+" : ""}${skewSec}s`,
      hint:
        Math.abs(skewSec) <= 300
          ? undefined
          : "端末と API サーバーの時刻同期を確認してください。",
    });
  } else {
    checks.push({
      name: "clock-skew",
      status: "skip",
      detail: "Date ヘッダーを取得できません",
    });
  }

  checks.push(await credentialsCheck(store, resolved.stored, platform));

  checks.push(
    options.configDirWritable
      ? {
          name: "config-dir",
          status: (await options.configDirWritable()) ? "ok" : "error",
          detail: dirname(store.path()),
        }
      : await configDirCheck(store),
  );

  if (platform === "win32") {
    const available = await (options.wslCheck ?? defaultWslCheck)();
    checks.push({
      name: "wsl",
      status: available ? "ok" : "skip",
      detail: available ? "available" : "not available (optional)",
    });
  } else {
    checks.push({
      name: "wsl",
      status: "skip",
      detail: "Windows のみ",
    });
  }

  return { checks };
}

export function formatDoctorLine(check: DoctorCheck): string {
  const label = check.status.toUpperCase().padEnd(6);
  const name = check.name.padEnd(22);
  const hint = check.hint ? `\n     hint: ${check.hint}` : "";
  return `${label}${name}${check.detail}${hint}\n`;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const report = await collectDoctorChecks(options);
  if (options.json) {
    printJson(report, options.output);
  } else {
    for (const check of report.checks) {
      await writeOut(options.output, formatDoctorLine(check));
    }
  }

  if (!options.strict) return 0;
  return report.checks.some(
    (check) => check.status === "warn" || check.status === "error",
  )
    ? 1
    : 0;
}
