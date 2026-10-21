import { runFile } from "./exec.js";

export interface StopProcessOptions {
  scope: "windows" | "wsl";
  pidScope?: string | null;
  pid: number;
  signal?: "TERM" | "KILL";
  force?: boolean;
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
