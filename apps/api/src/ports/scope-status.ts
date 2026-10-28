import type { DetailedScanResult } from "@sys4sys/agent";

export type RequestedScope = "all" | "windows" | "wsl";

export function scopeHasTiming(
  scan: DetailedScanResult,
  scope: "windows" | "wsl",
): boolean {
  if (scope === "windows") return Boolean(scan.timings.windows);
  return Object.keys(scan.timings).some((key) => key.startsWith("wsl:"));
}

export function scopeFailed(
  scan: DetailedScanResult,
  scope: "windows" | "wsl",
): boolean {
  if (scopeHasTiming(scan, scope)) return false;
  return scan.scanErrors.some((error) => error.scope === scope);
}

export function allRequestedScopesFailed(
  scan: DetailedScanResult,
  scope: RequestedScope,
): boolean {
  const requested: Array<"windows" | "wsl"> =
    scope === "all" ? ["windows", "wsl"] : [scope];
  return requested.every((item) => scopeFailed(scan, item));
}

export function scanFailureDetail(
  scan: DetailedScanResult,
  scope: "windows" | "wsl",
): string {
  const errors = scan.scanErrors
    .filter((error) => error.scope === scope)
    .map(
      (error) => `${error.distro ? `${error.distro}: ` : ""}${error.message}`,
    );
  return errors.length > 0
    ? errors.join(" / ")
    : `${scope} スコープの状態を取得できませんでした`;
}
