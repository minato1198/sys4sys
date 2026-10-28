import type { DetailedScanResult } from "@sys4sys/agent";
import { describe, expect, it } from "vitest";
import {
  allRequestedScopesFailed,
  scanFailureDetail,
  scopeFailed,
} from "./scope-status.js";

function scan(overrides: Partial<DetailedScanResult> = {}): DetailedScanResult {
  return {
    scannedAt: "2026-10-28T00:00:00.000Z",
    rows: [],
    skipped: [],
    scanErrors: [],
    distros: [],
    timings: {},
    warnings: [],
    ...overrides,
  };
}

describe("port scan scope status", () => {
  it("treats a successful timing as scanned even with an error", () => {
    const value = scan({
      timings: { windows: { rows: 0, elapsedMs: 1 } },
      scanErrors: [{ scope: "windows", message: "warning" }],
    });
    expect(scopeFailed(value, "windows")).toBe(false);
  });

  it("detects an unavailable WSL scope", () => {
    const value = scan({
      scanErrors: [{ scope: "wsl", message: "wsl.exe not found" }],
    });
    expect(scopeFailed(value, "wsl")).toBe(true);
    expect(allRequestedScopesFailed(value, "wsl")).toBe(true);
  });

  it("does not treat stopped distros as a failure", () => {
    const value = scan({
      skipped: [{ distro: "Ubuntu", error: "not running (Stopped)" }],
    });
    expect(scopeFailed(value, "wsl")).toBe(false);
    expect(allRequestedScopesFailed(value, "wsl")).toBe(false);
  });

  it("returns partial success when only one scope failed", () => {
    const value = scan({
      timings: { windows: { rows: 1, elapsedMs: 1 } },
      scanErrors: [{ scope: "wsl", message: "wsl.exe not found" }],
    });
    expect(allRequestedScopesFailed(value, "all")).toBe(false);
  });

  it("returns failure when both requested scopes failed", () => {
    const value = scan({
      scanErrors: [
        { scope: "windows", message: "powershell failed" },
        { scope: "wsl", message: "wsl.exe not found" },
      ],
    });
    expect(allRequestedScopesFailed(value, "all")).toBe(true);
  });

  it("includes the distro name in failure details", () => {
    const value = scan({
      scanErrors: [
        { scope: "wsl", distro: "Ubuntu", message: "ss failed" },
        { scope: "wsl", message: "other failure" },
      ],
    });
    expect(scanFailureDetail(value, "wsl")).toBe(
      "Ubuntu: ss failed / other failure",
    );
  });
});
