import { basename } from "node:path";
import { config } from "../config.js";

export interface AllowlistResult {
  ok: boolean;
  reason?: string;
}

function normalizeCommandName(value: string): string {
  const name = basename(value.trim()).toLowerCase();
  return name.replace(/\.(exe|cmd|bat|com)$/i, "");
}

export function allowedCommands(): string[] {
  return config.SERVICE_COMMAND_ALLOWLIST.split(",")
    .map((value) => normalizeCommandName(value))
    .filter(Boolean);
}

export function isCommandAllowed(command: string[]): AllowlistResult {
  const executable = command[0]?.trim();
  if (!executable) {
    return { ok: false, reason: "実行コマンドが空です" };
  }

  const allowed = new Set(allowedCommands());
  const name = normalizeCommandName(executable);
  if (!allowed.has(name)) {
    return {
      ok: false,
      reason: `${executable} は許可されていません。SERVICE_COMMAND_ALLOWLIST を確認してください`,
    };
  }
  return { ok: true };
}
