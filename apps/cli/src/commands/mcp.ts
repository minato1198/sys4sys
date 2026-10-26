import { ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import { runMcpStdio } from "../mcp/server.js";
import { CLI_VERSION } from "../version.js";

export interface McpCommandOptions {
  transport?: string;
  allowWrite?: boolean;
  apiUrl?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: (text: string) => void;
  version?: string;
}

export function allowWriteEnabled(
  options: McpCommandOptions,
  env: NodeJS.ProcessEnv = options.env ?? process.env,
): boolean {
  if (options.allowWrite === true) return true;
  return env.SYS4SYS_MCP_ALLOW_WRITE?.trim().toLowerCase() === "true";
}

/**
 * MCP stdio は stdout をプロトコル専用にする。起動失敗も stderr にだけ書く。
 */
export async function runMcpCommand(
  options: McpCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr.write.bind(process.stderr);
  const transport = options.transport?.trim() || "stdio";

  try {
    if (transport !== "stdio") {
      throw new UsageError(
        "MCP の transport は stdio のみ対応しています（HTTP/SSE は未実装）。",
      );
    }

    const token = env.SYS4SYS_TOKEN?.trim();
    if (!token) {
      throw new CliError(
        "SYS4SYS_TOKEN が必要です。mcp serve は保存済み資格情報や対話ログインを使いません。",
        3,
      );
    }

    const client = new ApiClient({
      apiUrl: options.apiUrl ?? env.SYS4SYS_API_URL,
      token,
      timeoutMs: 30_000,
    });
    const allowWrite = allowWriteEnabled(options, env);
    await runMcpStdio({
      client,
      allowWrite,
      version: options.version ?? CLI_VERSION,
      stderr,
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`[sys4sys mcp] ${message}\n`);
    return error instanceof CliError ? error.exitCode : 1;
  }
}
