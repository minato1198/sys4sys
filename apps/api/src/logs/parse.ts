import { createHash } from "node:crypto";
import type { LogLevel } from "@sys4sys/shared";

export type LogStream = "stdout" | "stderr" | "file" | "eventlog";

const LEVEL_ALIASES: Record<string, LogLevel> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  information: "info",
  notice: "info",
  warn: "warn",
  warning: "warn",
  error: "error",
  err: "error",
  fatal: "fatal",
  critical: "fatal",
  crit: "fatal",
  panic: "fatal",
};

const NUMERIC_LEVELS: Record<number, LogLevel> = {
  10: "debug",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

export function coerceLevel(value: unknown): LogLevel | undefined {
  if (typeof value === "number") return NUMERIC_LEVELS[value];
  if (typeof value !== "string") return undefined;
  return LEVEL_ALIASES[value.trim().toLowerCase()];
}

export function detectLevel(
  message: string,
  stream: LogStream = "stdout",
): LogLevel {
  if (/\b(fatal|panic|critical)\b/i.test(message)) return "fatal";
  if (/\b(error|exception|failed|failure|traceback)\b/i.test(message)) {
    return "error";
  }
  if (/\b(warn|warning|deprecated)\b/i.test(message)) return "warn";
  if (/\b(debug|trace)\b/i.test(message)) return "debug";
  return stream === "stderr" ? "warn" : "info";
}

/**
 * ログの fingerprint。タイムスタンプ・UUID・数値を正規化して、
 * 同じ種類のメッセージが同じ値になるようにする（M3 のルールエンジン用）。
 */
export function fingerprintOf(message: string): string {
  const normalized = message
    .toLowerCase()
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g,
      "<uuid>",
    )
    .replace(/\b[0-9a-f]{8,}\b/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export interface NormalizedLine {
  message: string;
  level?: LogLevel;
  fields?: Record<string, unknown> | null;
}

/** JSON ログ（pino / winston など）を可能な範囲で構造化する。 */
export function normalizeLine(raw: string, stream: LogStream): NormalizedLine {
  const line = raw.replace(/\r$/, "").trimEnd();
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>;
        const message =
          typeof object.message === "string"
            ? object.message
            : typeof object.msg === "string"
              ? object.msg
              : line;
        const level =
          coerceLevel(object.level) ??
          coerceLevel(object.severity) ??
          coerceLevel(object.lvl);
        const serialized = JSON.stringify(object);
        const fields =
          serialized.length <= 16_384
            ? object
            : { truncated: true, preview: serialized.slice(0, 2000) };
        return { message, level, fields };
      }
    } catch {
      // 通常のテキストとして扱う
    }
  }
  void stream;
  return { message: line };
}
