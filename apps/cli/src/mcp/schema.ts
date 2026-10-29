import { z } from "zod";
import { CLI_LIMITS } from "../limits.js";

const id = (name: string) => z.string().min(1).max(200).describe(name);
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback).describe("Maximum items");

export const serviceIdInput = id("sys4sys service ID");
export const incidentIdInput = id("sys4sys incident ID");
export const approvalIdInput = id("sys4sys approval ID");
export const deployRequestIdInput = id("sys4sys deploy request ID");

export const listServicesInput = z.object({
  hostId: z.string().min(1).optional().describe("Filter by host ID"),
  status: z
    .enum([
      "stopped",
      "starting",
      "running",
      "stopping",
      "degraded",
      "restarting",
      "failed",
    ])
    .optional()
    .describe("Filter by service status"),
  limit: limit(200, 50),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
});

export const getServiceInput = z.object({
  serviceId: serviceIdInput,
});

export const queryLogsInput = z.object({
  hostId: z.string().min(1).optional().describe("Filter by host ID"),
  serviceId: z.string().min(1).optional().describe("Filter by service ID"),
  level: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .optional()
    .describe("Filter by log level"),
  q: z.string().max(500).optional().describe("Substring search in messages"),
  from: z.string().datetime().optional().describe("ISO 8601 lower bound"),
  to: z.string().datetime().optional().describe("ISO 8601 upper bound"),
  limit: limit(CLI_LIMITS.mcpLogMaxLimit, 50),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("nextCursor from a previous call"),
});

export const listIncidentsInput = z.object({
  status: z.string().min(1).optional().describe("Incident status"),
  severity: z.string().min(1).optional().describe("Incident severity"),
  serviceId: z.string().min(1).optional().describe("Filter by service ID"),
  limit: limit(200, 50),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
});

export const getIncidentInput = z.object({
  incidentId: incidentIdInput,
});

export const listApprovalsInput = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "expired", "succeeded", "failed"])
    .default("pending")
    .describe("Approval status"),
  limit: limit(200, 50),
});

export const cliSchemaInput = z.object({
  command: z
    .string()
    .min(1)
    .optional()
    .describe("Exact command name, for example 'services list'"),
});

const confirm = z
  .boolean()
  .optional()
  .describe("Must be true to execute a destructive write tool");

export const serviceActionInput = z.object({
  serviceId: serviceIdInput,
  confirm,
});

export const deployServiceInput = z.object({
  serviceId: serviceIdInput,
  confirm,
  note: z.string().max(500).optional().describe("Deploy request note"),
  requireApproval: z
    .boolean()
    .optional()
    .describe(
      "true creates a deploy request; false still cannot bypass an approval-required service",
    ),
});

export const incidentAckInput = z.object({
  incidentId: incidentIdInput,
  note: z.string().max(500).optional(),
});

export const incidentResolveInput = z.object({
  incidentId: incidentIdInput,
  note: z.string().max(500).optional(),
  confirm,
});

export const deployDecisionInput = z.object({
  deployRequestId: deployRequestIdInput,
  note: z.string().max(500).optional(),
  confirm,
});

/** MCP クライアントへ返す JSON Schema。SDK は Zod を JSON Schema に変換する。 */
export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
}

export const READ_TOOL_INPUTS = {
  whoami: z.object({}),
  listServices: listServicesInput,
  getService: getServiceInput,
  queryLogs: queryLogsInput,
  listIncidents: listIncidentsInput,
  getIncident: getIncidentInput,
  listApprovals: listApprovalsInput,
  schema: cliSchemaInput,
} as const;

export const WRITE_TOOL_INPUTS = {
  serviceAction: serviceActionInput,
  deployService: deployServiceInput,
  incidentAck: incidentAckInput,
  incidentResolve: incidentResolveInput,
  deployDecision: deployDecisionInput,
} as const;
