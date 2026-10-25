import { UsageError } from "./errors.js";

const RELATIVE_PATTERN = /^(\d+)(s|m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

export function parseRelativeDuration(value: string): number {
  const match = RELATIVE_PATTERN.exec(value.trim());
  if (!match) {
    throw new UsageError(
      `相対時刻の形式が不正です: ${value}（例: 30s, 15m, 2h, 1d）`,
    );
  }

  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new UsageError(`相対時刻は 1 以上で指定してください: ${value}`);
  }

  const unit = match[2] ?? "";
  const multiplier = UNIT_MS[unit];
  if (!multiplier) {
    throw new UsageError(`未知の時間単位です: ${unit}`);
  }
  return amount * multiplier;
}

export function toIso(value: string, now: Date = new Date()): string {
  const trimmed = value.trim();
  if (RELATIVE_PATTERN.test(trimmed)) {
    return new Date(
      now.getTime() - parseRelativeDuration(trimmed),
    ).toISOString();
  }

  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    throw new UsageError(
      `時刻の形式が不正です: ${value}（ISO 8601 または 15m / 2h / 1d）`,
    );
  }
  return new Date(timestamp).toISOString();
}

export function parseSince(
  value: string | undefined,
  now: Date = new Date(),
): string | undefined {
  return value === undefined ? undefined : toIso(value, now);
}

export function parseUntil(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (RELATIVE_PATTERN.test(value.trim())) {
    throw new UsageError(
      "--until には相対時刻を指定できません。ISO 8601 を指定してください。",
    );
  }
  return toIso(value);
}
