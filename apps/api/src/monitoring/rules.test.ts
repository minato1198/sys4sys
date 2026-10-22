import { describe, expect, it } from "vitest";
import {
  backoffMsForAttempt,
  isCrashLoop,
  isRecent,
  maxSeverity,
  parseBackoff,
} from "./rules.js";

describe("monitoring rules", () => {
  it("keeps the higher severity", () => {
    expect(maxSeverity("warning", "error")).toBe("error");
    expect(maxSeverity("critical", "info")).toBe("critical");
    expect(maxSeverity("info", "warning")).toBe("warning");
  });

  it("parses backoff values and ignores invalid entries", () => {
    expect(parseBackoff("5, 15,30, x, -1")).toEqual([5, 15, 30]);
    expect(parseBackoff("")).toEqual([10, 30, 90]);
  });

  it("clamps the backoff index to the configured list", () => {
    expect(backoffMsForAttempt(0, [10, 30, 90])).toBe(10_000);
    expect(backoffMsForAttempt(1, [10, 30, 90])).toBe(30_000);
    expect(backoffMsForAttempt(9, [10, 30, 90])).toBe(90_000);
  });

  it("detects a crash loop inside the window", () => {
    const now = 1_000_000;
    expect(isCrashLoop([now - 1000, now - 2000], now, 60_000)).toBe(false);
    expect(isCrashLoop([now - 1000, now - 2000, now - 3000], now, 60_000)).toBe(
      true,
    );
    expect(
      isCrashLoop([now - 1000, now - 2000, now - 90_000], now, 60_000),
    ).toBe(false);
  });

  it("checks whether a timestamp is recent", () => {
    const now = 1_000_000;
    expect(isRecent(new Date(now - 500), now, 1000)).toBe(true);
    expect(isRecent(new Date(now - 1500), now, 1000)).toBe(false);
    expect(isRecent(null, now, 1000)).toBe(false);
  });
});
