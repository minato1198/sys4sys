import { config } from "../config.js";

const WINDOW_MS = config.LOGIN_WINDOW_MINUTES * 60_000;
const MAX_BUCKETS = 10_000;
const buckets = new Map<string, number[]>();

function recentAttempts(timestamps: number[], now: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < WINDOW_MS);
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

export function checkLoginRate(key: string): RateLimitResult {
  const now = Date.now();
  const recent = recentAttempts(buckets.get(key) ?? [], now);

  if (recent.length >= config.LOGIN_MAX_ATTEMPTS) {
    const oldest = recent[0] ?? now;
    buckets.set(key, recent);
    return {
      allowed: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((WINDOW_MS - (now - oldest)) / 1000),
      ),
    };
  }

  buckets.set(key, recent);
  return { allowed: true, retryAfterSec: 0 };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const recent = recentAttempts(buckets.get(key) ?? [], now);
  recent.push(now);
  buckets.set(key, recent);

  if (buckets.size > MAX_BUCKETS) {
    for (const [bucketKey, timestamps] of buckets) {
      if (recentAttempts(timestamps, now).length === 0)
        buckets.delete(bucketKey);
    }
  }
}

export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

export function resetRateLimitStoreForTests(): void {
  buckets.clear();
}
