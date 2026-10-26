import type { AuthMe } from "@sys4sys/shared";
import type { z } from "zod";

export interface McpClient {
  whoami(): Promise<AuthMe>;
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
}

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  requiredScopes: readonly string[];
  write: boolean;
  requiresConfirm?: boolean;
  execute(client: McpClient, args: Record<string, unknown>): Promise<unknown>;
}
