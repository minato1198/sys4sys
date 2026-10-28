import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface CommandRunOptions {
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      // .cmd / .bat のラッパーを含めて子プロセスツリーを止める。
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => undefined);
      return;
    }
    child.kill("SIGKILL");
  } catch {
    // 既に終了している場合は何もしない。
  }
}

/**
 * Windows のヘルスチェック用コマンドを、シェル文字列を組み立てずに実行する。
 * cross-spawn を使うことで `.cmd` / `.bat` も cwd / env 付きで起動できる。
 */
export function runCommand(
  command: string[],
  options: CommandRunOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const executable = command[0];
    if (!executable) {
      reject(new Error("実行コマンドが空です"));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(executable, command.slice(1), {
        cwd: options.cwd || undefined,
        env: options.env ?? process.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        terminate(child);
        reject(error);
      } else {
        resolve();
      }
    };

    timer = setTimeout(
      () => finish(new Error("ヘルスチェックがタイムアウトしました")),
      Math.max(1, options.timeoutMs),
    );
    timer.unref();

    child.once("error", (error: Error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `ヘルスチェックが失敗しました (code=${code ?? "null"}, signal=${
            signal ?? "null"
          })`,
        ),
      );
    });
  });
}
