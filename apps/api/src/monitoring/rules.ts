import type { IncidentSeverity } from "@sys4sys/shared";

const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

export function maxSeverity(
  a: IncidentSeverity,
  b: IncidentSeverity,
): IncidentSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

export function parseBackoff(raw: string): number[] {
  const values = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value));
  return values.length > 0 ? values : [10, 30, 90];
}

export function backoffMsForAttempt(
  attempt: number,
  backoffSec: number[],
): number {
  const index = Math.max(0, Math.min(attempt, backoffSec.length - 1));
  return backoffSec[index]! * 1000;
}

export function isCrashLoop(
  timestamps: number[],
  now: number,
  windowMs: number,
  threshold = 3,
): boolean {
  return timestamps.filter((ts) => now - ts <= windowMs).length >= threshold;
}

export function isRecent(
  iso: Date | null | undefined,
  now: number,
  windowMs: number,
): boolean {
  if (!iso) return false;
  return now - iso.getTime() <= windowMs;
}
