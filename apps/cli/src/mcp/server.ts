import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { ApiError } from "../client.js";
import type { AuthMe } from "@sys4sys/shared";
import { CLI_VERSION } from "../version.js";
import { READ_TOOLS } from "./tools/read.js";
import { WRITE_TOOLS } from "./tools/write.js";
import type { McpClient, McpToolDefinition } from "./types.js";

export interface CreateMcpServerOptions {
  client: McpClient;
  allowWrite: boolean;
  version?: string;
  /** 起動時の診断に使う。テストではメモリへ退避できる。 */
  stderr?: (text: string) => void;
}

export interface CreatedMcpServer {
  server: McpServer;
  whoami: AuthMe;
  toolNames: string[];
}

export function availableTools(
  me: AuthMe,
  allowWrite: boolean,
): McpToolDefinition[] {
  const scopes = new Set<string>(me.scopes);
  return [...READ_TOOLS, ...(allowWrite ? WRITE_TOOLS : [])].filter((tool) =>
    tool.requiredScopes.every((scope) => scopes.has(scope)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(text: string): string {
  return text
    .replace(/s4s_[A-Za-z0-9_-]{16,}/g, "s4s_[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

function toolContent(value: unknown): CallToolResult {
  const text = redact(JSON.stringify(value ?? null, null, 2));
  return {
    content: [{ type: "text", text }],
  };
}

function toolError(error: unknown): CallToolResult {
  if (error instanceof ApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: redact(
            JSON.stringify(
              {
                error: {
                  status: error.status,
                  title: error.title,
                  detail: error.detail,
                  requiredScope: error.problem?.requiredScope,
                  deployRequestId: error.problem?.deployRequestId,
                },
              },
              null,
              2,
            ),
          ),
        },
      ],
    };
  }

  if (error instanceof ZodError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: redact(
            JSON.stringify(
              {
                error: {
                  type: "invalid_input",
                  message: "入力が不正です",
                  issues: error.issues.map((issue) => ({
                    path: issue.path.join(".") || "(root)",
                    message: issue.message,
                  })),
                },
              },
              null,
              2,
            ),
          ),
        },
      ],
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: redact(
          JSON.stringify(
            { error: { type: "tool_error", message: errorMessage(error) } },
            null,
            2,
          ),
        ),
      },
    ],
  };
}

async function executeTool(
  tool: McpToolDefinition,
  client: McpClient,
  rawArgs: unknown,
): Promise<CallToolResult> {
  try {
    const args =
      rawArgs && typeof rawArgs === "object"
        ? (rawArgs as Record<string, unknown>)
        : {};
    if (tool.requiresConfirm && args.confirm !== true) {
      return toolError(
        new Error(
          "確認が必要です。破壊的な操作は confirm: true を指定してください。",
        ),
      );
    }
    return toolContent(await tool.execute(client, args));
  } catch (error) {
    return toolError(error);
  }
}

export async function createMcpServer(
  options: CreateMcpServerOptions,
): Promise<CreatedMcpServer> {
  const me = await options.client.whoami();
  const tools = availableTools(me, options.allowWrite);
  const server = new McpServer(
    { name: "sys4sys", version: options.version ?? CLI_VERSION },
    {
      instructions:
        "sys4sys MCP is read-first. Read tools are safe. Write tools require --allow-write, " +
        "the matching token scope, and confirm=true where marked. Never approve your own deploy request.",
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: Boolean(tool.requiresConfirm),
          idempotentHint: !tool.write,
        },
      },
      async (args) =>
        executeTool(tool, options.client, args as Record<string, unknown>),
    );
  }

  return {
    server,
    whoami: me,
    toolNames: tools.map((tool) => tool.name),
  };
}

export interface McpStdioOptions extends CreateMcpServerOptions {
  allowWrite: boolean;
}

export async function runMcpStdio(
  options: McpStdioOptions,
): Promise<CreatedMcpServer> {
  const created = await createMcpServer(options);
  if (options.allowWrite) {
    (options.stderr ?? process.stderr.write.bind(process.stderr))(
      "[sys4sys mcp] 警告: 書き込みツールが有効です。トークンのスコープとクライアント側の承認 UI を確認してください。\n",
    );
  }
  const transport = new StdioServerTransport();
  await created.server.connect(transport);
  return created;
}
