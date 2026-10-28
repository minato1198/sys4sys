import { runFile, ExternalCommandError } from "./exec.js";

export interface StopProcessOptions {
  scope: "windows" | "wsl";
  pidScope?: string | null;
  pid: number;
  signal?: "TERM" | "KILL";
  force?: boolean;
}

export interface ProcessRef {
  scope: "windows" | "wsl";
  pidScope?: string | null;
  pid: number;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

/** PID が生存しているかを三値で返す。WSL は `kill -0` で確認する。 */
export async function isProcessAlive(
  ref: ProcessRef,
): Promise<ProcessLiveness> {
  if (!Number.isInteger(ref.pid) || ref.pid <= 0) return "dead";

  if (ref.scope === "windows") {
    try {
      process.kill(ref.pid, 0);
      return "alive";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return "alive";
      if (code === "ESRCH") return "dead";
      return "unknown";
    }
  }

  if (!ref.pidScope) return "unknown";
  try {
    await runFile(
      "wsl.exe",
      ["-d", ref.pidScope, "--", "kill", "-0", String(ref.pid)],
      5000,
    );
    return "alive";
  } catch (error) {
    if (error instanceof ExternalCommandError) {
      if (error.timedOut) return "unknown";
      // `kill -0` の exit code 1 は「その PID が存在しない」を意味する。
      if (error.exitCode === 1) return "dead";
    }
    return "unknown";
  }
}

/**
 * ポートを掴んでいるプロセスを停止する。
 * シェル文字列は組み立てず、引数配列で実行する。
 */
export async function stopProcess(options: StopProcessOptions): Promise<void> {
  if (!Number.isInteger(options.pid) || options.pid <= 4) {
    throw new Error("system process cannot be stopped");
  }

  if (options.scope === "windows") {
    const args = ["/PID", String(options.pid), "/T"];
    if (options.signal === "KILL" || options.force) args.push("/F");
    await runFile("taskkill.exe", args, 15_000);
    return;
  }

  if (!options.pidScope) {
    throw new Error("WSL pidScope is required");
  }

  const signal = options.signal === "KILL" || options.force ? "-KILL" : "-TERM";
  await runFile(
    "wsl.exe",
    ["-d", options.pidScope, "--", "kill", signal, String(options.pid)],
    15_000,
  );
}
