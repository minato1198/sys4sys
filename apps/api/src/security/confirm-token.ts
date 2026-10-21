import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const TOKEN_TTL_MS = 60_000;
const PURPOSE = "sys4sys:port-kill:v1";

export interface KillTokenPayload {
  scope: "windows" | "wsl";
  pidScope: string | null;
  port: number;
  pid: number;
  /** PID 再利用対策。取得時点のプロセス開始時刻。 */
  startedAt: string | null;
  exp: number;
}

export interface SignedKillToken {
  token: string;
  expiresAt: Date;
}

function signature(data: string): string {
  return createHmac("sha256", config.SESSION_SECRET)
    .update(`${PURPOSE}\n${data}`)
    .digest("base64url");
}

export function signKillToken(
  payload: Omit<KillTokenPayload, "exp">,
  ttlMs = TOKEN_TTL_MS,
): SignedKillToken {
  const body: KillTokenPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const data = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  return {
    token: `${data}.${signature(data)}`,
    expiresAt: new Date(body.exp),
  };
}

export function verifyKillToken(token: string): KillTokenPayload | null {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator >= token.length - 1) return null;

  const data = token.slice(0, separator);
  const provided = token.slice(separator + 1);
  const expected = signature(data);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as Partial<KillTokenPayload>;

    if (
      (payload.scope !== "windows" && payload.scope !== "wsl") ||
      (payload.pidScope !== undefined &&
        payload.pidScope !== null &&
        typeof payload.pidScope !== "string") ||
      typeof payload.port !== "number" ||
      typeof payload.pid !== "number" ||
      (typeof payload.startedAt !== "string" && payload.startedAt !== null) ||
      typeof payload.exp !== "number" ||
      payload.exp < Date.now()
    ) {
      return null;
    }

    return {
      scope: payload.scope,
      pidScope: payload.pidScope ?? null,
      port: payload.port,
      pid: payload.pid,
      startedAt: payload.startedAt,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
