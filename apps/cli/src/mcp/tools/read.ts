import {
  incidentQuerySchema,
  logQuerySchema,
  serviceListQuerySchema,
} from "@sys4sys/shared";
import { generateSchema } from "../../commands/schema.js";
import { CLI_LIMITS } from "../../limits.js";
import type { Service } from "../../types.js";
import {
  READ_TOOL_INPUTS,
  cliSchemaInput,
  getIncidentInput,
  getServiceInput,
  listApprovalsInput,
  listIncidentsInput,
  listServicesInput,
  queryLogsInput,
} from "../schema.js";
import type { McpClient, McpToolDefinition } from "../types.js";

interface ListEnvelope<T> {
  items: T[];
  total: number;
}

function stripServiceSecrets(service: Service): Record<string, unknown> {
  const { env, deploy, ...safe } = service;
  return {
    ...safe,
    envKeys: service.envKeys ?? (env ? Object.keys(env) : []),
    deploy: deploy
      ? {
          ...deploy,
          env: undefined,
          envKeys:
            deploy.envKeys ?? (deploy.env ? Object.keys(deploy.env) : []),
        }
      : null,
  };
}

function queryParams(values: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params;
}

export const READ_TOOLS: McpToolDefinition[] = [
  {
    name: "sys4sys_whoami",
    title: "Show sys4sys identity",
    description:
      "Return the authenticated sys4sys user, role, and token scopes. The token value is never returned.",
    inputSchema: READ_TOOL_INPUTS.whoami,
    requiredScopes: [],
    write: false,
    async execute(client) {
      return client.whoami();
    },
  },
  {
    name: "sys4sys_list_services",
    title: "List sys4sys services",
    description:
      "List services visible to this token. Use hostId or status to narrow results. Secrets and env values are never returned.",
    inputSchema: READ_TOOL_INPUTS.listServices,
    requiredScopes: ["services:read"],
    write: false,
    async execute(client, args) {
      const input = listServicesInput.parse(args);
      const filter = serviceListQuerySchema.parse({
        hostId: input.hostId,
        status: input.status,
      });
      const params = queryParams({
        hostId: filter.hostId,
        status: filter.status,
      });
      const path =
        params.size > 0 ? `/api/services?${params}` : "/api/services";
      const services = await client.request<Service[]>("GET", path);
      const total = services.length;
      const page = services.slice(input.offset, input.offset + input.limit);
      const nextOffset = input.offset + page.length;
      return {
        items: page.map(stripServiceSecrets),
        total,
        nextCursor: nextOffset < total ? String(nextOffset) : null,
      };
    },
  },
  {
    name: "sys4sys_get_service",
    title: "Get a sys4sys service",
    description:
      "Return one service. env and deploy.env values are replaced by key names only. Secrets are never returned.",
    inputSchema: READ_TOOL_INPUTS.getService,
    requiredScopes: ["services:read"],
    write: false,
    async execute(client, args) {
      const input = getServiceInput.parse(args);
      const service = await client.request<Service>(
        "GET",
        `/api/services/${encodeURIComponent(input.serviceId)}`,
      );
      return stripServiceSecrets(service);
    },
  },
  {
    name: "sys4sys_query_logs",
    title: "Query sys4sys logs",
    description: `Search masked sys4sys logs. Secrets are masked by the API. Prefer serviceId and a time range. At most ${CLI_LIMITS.mcpLogMaxLimit} rows are returned.`,
    inputSchema: READ_TOOL_INPUTS.queryLogs,
    requiredScopes: ["logs:read"],
    write: false,
    async execute(client, args) {
      const input = queryLogsInput.parse(args);
      const query = logQuerySchema.parse({
        hostId: input.hostId,
        serviceId: input.serviceId,
        level: input.level,
        q: input.q,
        from: input.from,
        to: input.to,
        limit: Math.min(input.limit, CLI_LIMITS.mcpLogMaxLimit),
        cursor: input.cursor,
      });
      const params = queryParams({
        hostId: query.hostId,
        serviceId: query.serviceId,
        level: query.level,
        q: query.q,
        from: query.from,
        to: query.to,
        limit: query.limit,
        cursor: query.cursor,
      });
      return client.request("GET", `/api/logs?${params}`);
    },
  },
  {
    name: "sys4sys_list_incidents",
    title: "List sys4sys incidents",
    description:
      "List incidents. Filter by status, severity, or serviceId. Use nextCursor for the next page.",
    inputSchema: READ_TOOL_INPUTS.listIncidents,
    requiredScopes: ["incidents:read"],
    write: false,
    async execute(client, args) {
      const input = listIncidentsInput.parse(args);
      const query = incidentQuerySchema.parse({
        status: input.status,
        severity: input.severity,
        serviceId: input.serviceId,
        limit: input.limit,
        offset: input.offset,
      });
      const params = queryParams({
        status: query.status,
        severity: query.severity,
        serviceId: query.serviceId,
        limit: query.limit,
        offset: query.offset,
      });
      const result = await client.request<ListEnvelope<unknown>>(
        "GET",
        `/api/incidents?${params}`,
      );
      const nextOffset = query.offset + result.items.length;
      return {
        ...result,
        nextCursor: nextOffset < result.total ? String(nextOffset) : null,
      };
    },
  },
  {
    name: "sys4sys_get_incident",
    title: "Get a sys4sys incident",
    description:
      "Return incident details, latest analysis, and report. Secrets are not included.",
    inputSchema: READ_TOOL_INPUTS.getIncident,
    requiredScopes: ["incidents:read"],
    write: false,
    async execute(client, args) {
      const input = getIncidentInput.parse(args);
      return client.request(
        "GET",
        `/api/incidents/${encodeURIComponent(input.incidentId)}`,
      );
    },
  },
  {
    name: "sys4sys_list_approvals",
    title: "List sys4sys approvals",
    description:
      "List pending or historical approvals. Use this before approving or rejecting a destructive action.",
    inputSchema: READ_TOOL_INPUTS.listApprovals,
    requiredScopes: ["approvals:read"],
    write: false,
    async execute(client, args) {
      const input = listApprovalsInput.parse(args);
      const params = new URLSearchParams({
        status: input.status,
        limit: String(input.limit),
      });
      const result = await client.request<ListEnvelope<unknown>>(
        "GET",
        `/api/approvals?${params}`,
      );
      return { ...result, nextCursor: null };
    },
  },
  {
    name: "sys4sys_schema",
    title: "Get the sys4sys CLI schema",
    description:
      "Return the machine-readable CLI command contract. Pass command to narrow the result. This tool does not call the API.",
    inputSchema: READ_TOOL_INPUTS.schema,
    requiredScopes: [],
    write: false,
    async execute(_client, args) {
      const input = cliSchemaInput.parse(args);
      return generateSchema(input.command);
    },
  },
];

/** tools/list に出す JSON Schema を検証・文書化するための読み取り専用ビュー。 */
export function readToolSummary() {
  return READ_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    requiredScopes: [...tool.requiredScopes],
  }));
}

/** API のエラーを MCP テストから参照できるようにする。 */
export function requiredScopesForTool(name: string): readonly string[] {
  return READ_TOOLS.find((tool) => tool.name === name)?.requiredScopes ?? [];
}

export type ReadToolClient = McpClient;
