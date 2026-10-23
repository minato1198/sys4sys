import { AuthError, CliError, UsageError } from "./errors.js";
import type { AuthUser, Problem } from "./types.js";

export const DEFAULT_API_URL = "http://127.0.0.1:8787";

export interface ApiClientOptions {
  apiUrl?: string;
  email?: string;
  password?: string;
  sessionCookie?: string;
  timeoutMs?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
    readonly problem?: Problem,
  ) {
    super(`${title}: ${detail}`);
    this.name = "ApiError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeApiUrl(raw: string | undefined): string {
  let value = (raw ?? DEFAULT_API_URL).trim();
  value = value.replace(/\/+$/, "");
  if (value.endsWith("/api")) value = value.slice(0, -4);

  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new UsageError(`API URL が不正です: ${raw ?? ""}`);
  }

  return value;
}

function normalizeSessionCookie(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const match = /(?:^|;\s*)sys4sys_session=([^;]+)/.exec(value);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return value;
}

function extractSessionCookie(headers: Headers): string | undefined {
  const withGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
  };
  const setCookies =
    withGetSetCookie.getSetCookie?.() ??
    [headers.get("set-cookie") ?? ""].filter(Boolean);

  for (const setCookie of setCookies) {
    const match = /(?:^|;\s*)sys4sys_session=([^;]+)/.exec(setCookie);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return undefined;
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toApiError(
  status: number,
  statusText: string,
  payload: unknown,
): ApiError {
  if (payload !== null && typeof payload === "object") {
    const problem = payload as Problem;
    return new ApiError(
      status,
      problem.title ?? (statusText || "API Error"),
      problem.detail ?? "",
      problem,
    );
  }

  return new ApiError(
    status,
    statusText || "API Error",
    typeof payload === "string" ? payload : "",
  );
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly email?: string;
  private readonly password?: string;
  private readonly timeoutMs: number;
  private cookie?: string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = normalizeApiUrl(options.apiUrl);
    this.email = options.email?.trim() || undefined;
    this.password = options.password || undefined;
    this.cookie = normalizeSessionCookie(options.sessionCookie);
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get apiUrl(): string {
    return this.baseUrl;
  }

  async whoami(): Promise<AuthUser> {
    return this.request<AuthUser>("GET", "/api/auth/me");
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.requestInternal<T>(method, path, body, true);
  }

  private async requestInternal<T>(
    method: string,
    path: string,
    body: unknown,
    allowLoginRetry: boolean,
  ): Promise<T> {
    await this.ensureAuth();

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.cookie) headers.Cookie = `sys4sys_session=${this.cookie}`;

    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CliError(
        `API に接続できません (${this.url(path)}): ${errorMessage(error)}`,
        1,
      );
    }

    if (response.status === 401 && allowLoginRetry && this.canLogin()) {
      await response.body?.cancel();
      this.cookie = undefined;
      await this.login();
      return this.requestInternal<T>(method, path, body, false);
    }

    const payload = await readResponse(response);
    if (!response.ok) {
      throw toApiError(response.status, response.statusText, payload);
    }
    return payload as T;
  }

  private async ensureAuth(): Promise<void> {
    if (this.cookie) return;
    if (!this.canLogin()) {
      throw new AuthError(
        "認証情報がありません。SYS4SYS_EMAIL / SYS4SYS_PASSWORD または SYS4SYS_SESSION_COOKIE を設定してください。",
      );
    }
    await this.login();
  }

  private canLogin(): boolean {
    return Boolean(this.email && this.password);
  }

  private async login(): Promise<void> {
    if (!this.email || !this.password) {
      throw new AuthError(
        "ログイン用のメールアドレスとパスワードがありません。",
      );
    }

    let response: Response;
    try {
      response = await fetch(this.url("/api/auth/login"), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: this.email,
          password: this.password,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new CliError(
        `ログイン API に接続できません (${this.url("/api/auth/login")}): ${errorMessage(error)}`,
        1,
      );
    }

    const payload = await readResponse(response);
    if (!response.ok) {
      throw toApiError(response.status, response.statusText, payload);
    }

    const cookie = extractSessionCookie(response.headers);
    if (!cookie) {
      throw new AuthError(
        "ログイン応答から sys4sys_session Cookie を取得できませんでした。",
      );
    }
    this.cookie = cookie;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
}
