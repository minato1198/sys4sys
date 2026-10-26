import type { Service } from "../../types.js";
import {
  WRITE_TOOL_INPUTS,
  deployDecisionInput,
  deployServiceInput,
  incidentAckInput,
  incidentResolveInput,
  serviceActionInput,
} from "../schema.js";
import type { McpToolDefinition } from "../types.js";

function actionTool(
  name: string,
  verb: "start" | "stop" | "restart",
): McpToolDefinition {
  return {
    name,
    title: `${verb[0]?.toUpperCase() ?? ""}${verb.slice(1)} a sys4sys service`,
    description:
      `Send a ${verb} action to a service. Requires confirm=true, --allow-write, and services:operate. ` +
      "The tool returns immediately; use sys4sys_get_service to check the resulting state.",
    inputSchema: WRITE_TOOL_INPUTS.serviceAction,
    requiredScopes: ["services:operate"],
    write: true,
    requiresConfirm: true,
    async execute(client, args) {
      const input = serviceActionInput.parse(args);
      return client.request(
        "POST",
        `/api/services/${encodeURIComponent(input.serviceId)}/${verb}`,
      );
    },
  };
}

export const WRITE_TOOLS: McpToolDefinition[] = [
  actionTool("sys4sys_start_service", "start"),
  actionTool("sys4sys_stop_service", "stop"),
  actionTool("sys4sys_restart_service", "restart"),
  {
    name: "sys4sys_deploy_service",
    title: "Deploy a sys4sys service",
    description:
      "Request or execute a deploy. Requires confirm=true, --allow-write, and deploy:execute. " +
      "If the service requires approval, or requireApproval=true, this creates a deploy request and never auto-approves it.",
    inputSchema: WRITE_TOOL_INPUTS.deployService,
    requiredScopes: ["deploy:execute"],
    write: true,
    requiresConfirm: true,
    async execute(client, args) {
      const input = deployServiceInput.parse(args);
      const service = await client.request<Service>(
        "GET",
        `/api/services/${encodeURIComponent(input.serviceId)}`,
      );

      const requiresApproval =
        input.requireApproval === true ||
        service.deploy?.requireApproval === true;
      if (requiresApproval) {
        const request = await client.request<Record<string, unknown>>(
          "POST",
          `/api/services/${encodeURIComponent(input.serviceId)}/deploy-requests`,
          input.note ? { note: input.note } : {},
        );
        return {
          status: "approval_required",
          autoApproved: false,
          deployRequestId: request.id ?? null,
          request,
        };
      }

      return client.request(
        "POST",
        `/api/services/${encodeURIComponent(input.serviceId)}/deploy`,
      );
    },
  },
  {
    name: "sys4sys_ack_incident",
    title: "Acknowledge a sys4sys incident",
    description:
      "Acknowledge an incident. Requires --allow-write and incidents:write. An explicit confirm is not required for ack.",
    inputSchema: WRITE_TOOL_INPUTS.incidentAck,
    requiredScopes: ["incidents:write"],
    write: true,
    async execute(client, args) {
      const input = incidentAckInput.parse(args);
      return client.request(
        "POST",
        `/api/incidents/${encodeURIComponent(input.incidentId)}/ack`,
        input.note ? { note: input.note } : {},
      );
    },
  },
  {
    name: "sys4sys_resolve_incident",
    title: "Resolve a sys4sys incident",
    description:
      "Resolve an incident. Requires confirm=true, --allow-write, and incidents:write.",
    inputSchema: WRITE_TOOL_INPUTS.incidentResolve,
    requiredScopes: ["incidents:write"],
    write: true,
    requiresConfirm: true,
    async execute(client, args) {
      const input = incidentResolveInput.parse(args);
      return client.request(
        "POST",
        `/api/incidents/${encodeURIComponent(input.incidentId)}/resolve`,
        input.note ? { note: input.note } : {},
      );
    },
  },
  {
    name: "sys4sys_approve_deploy_request",
    title: "Approve a sys4sys deploy request",
    description:
      "Approve and execute a deploy request. Requires confirm=true, --allow-write, and approvals:decide. " +
      "The API rejects self-approval. Use a different user or session from the requester.",
    inputSchema: WRITE_TOOL_INPUTS.deployDecision,
    requiredScopes: ["approvals:decide"],
    write: true,
    requiresConfirm: true,
    async execute(client, args) {
      const input = deployDecisionInput.parse(args);
      return client.request(
        "POST",
        `/api/deploy-requests/${encodeURIComponent(input.deployRequestId)}/approve`,
        input.note ? { note: input.note } : {},
      );
    },
  },
  {
    name: "sys4sys_reject_deploy_request",
    title: "Reject a sys4sys deploy request",
    description:
      "Reject a deploy request. Requires confirm=true, --allow-write, and approvals:decide.",
    inputSchema: WRITE_TOOL_INPUTS.deployDecision,
    requiredScopes: ["approvals:decide"],
    write: true,
    requiresConfirm: true,
    async execute(client, args) {
      const input = deployDecisionInput.parse(args);
      return client.request(
        "POST",
        `/api/deploy-requests/${encodeURIComponent(input.deployRequestId)}/reject`,
        input.note ? { note: input.note } : {},
      );
    },
  },
];

export function writeToolNames(): string[] {
  return WRITE_TOOLS.map((tool) => tool.name);
}
