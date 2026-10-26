import { readFileSync } from "node:fs";

declare const __SYS4SYS_CLI_VERSION__: string | undefined;

export const CLI_NAME = "sys4sys";

function packageVersion(): string {
  if (
    typeof __SYS4SYS_CLI_VERSION__ !== "undefined" &&
    typeof __SYS4SYS_CLI_VERSION__ === "string"
  ) {
    return __SYS4SYS_CLI_VERSION__;
  }

  try {
    const raw = readFileSync(
      new URL("../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // ビルド外で package.json を読めない場合は診断用の値を返す。
  }
  return "0.0.0";
}

export const CLI_VERSION = packageVersion();

export interface VersionInfo {
  name: string;
  version: string;
  node: string;
  platform: NodeJS.Platform;
}

export function versionInfo(): VersionInfo {
  return {
    name: CLI_NAME,
    version: CLI_VERSION,
    node: process.versions.node,
    platform: process.platform,
  };
}
