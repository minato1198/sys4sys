import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import {
  printJson,
  printTable,
  shortId,
  writeErr,
  writeOut,
} from "../output.js";
import {
  confirmNonInteractive,
  parseLimit,
  parseOffset,
  type CommandOptions,
} from "./services.js";

interface DeployRequestSnapshot {
  command: string[];
  cwd: string | null;
  timeoutSec: number;
  restartAfter: boolean;
  healthTimeoutSec: number;
  envHash: string;
  deployEnvHash: string;
}

interface DeployRequestItem {
  id: string;
  serviceId: string;
  requestedBy: string;
  requestedAt: string;
  status:
    "pending" | "approved" | "rejected" | "expired" | "executed" | "failed";
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  actionId: string | null;
  snapshot: DeployRequestSnapshot;
  expiresAt: string;
  service?: { id: string; name: string } | null;
}

interface DeployRequestListResponse {
  items: DeployRequestItem[];
  total: number;
}

interface DeployDecisionResponse {
  request: DeployRequestItem;
  action: { id: string; status: string } | null;
}

const querySchema = z.object({
  status: z
    .enum(["pending", "approved", "rejected", "expired", "executed", "failed"])
    .default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} にはデプロイ要求IDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} にはデプロイ要求ID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function parseQuery(options: CommandOptions): URLSearchParams {
  parseLimit(options.limit, 50, 200);
  parseOffset(options.offset);
  try {
    const query = querySchema.parse({
      status: options.status ?? "pending",
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    });
    const params = new URLSearchParams();
    params.set("status", query.status);
    params.set("limit", String(query.limit));
    params.set("offset", String(query.offset));
    return params;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new UsageError(
        `フィルタが不正です: ${error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    throw error;
  }
}

async function fetchRequest(
  client: ApiClient,
  id: string,
): Promise<DeployRequestItem> {
  return client.request<DeployRequestItem>(
    "GET",
    `/api/deploy-requests/${encodeURIComponent(id)}`,
  );
}

function printRequest(
  request: DeployRequestItem,
  options: CommandOptions,
): void {
  if (options.json) {
    printJson(request, options.output);
    return;
  }

  out(options, `ID:         ${request.id}\n`);
  out(options, `Service:    ${request.service?.name ?? request.serviceId}\n`);
  out(options, `Command:    ${request.snapshot.command.join(" ")}\n`);
  out(options, `CWD:        ${request.snapshot.cwd ?? "-"}\n`);
  out(options, `Status:     ${request.status}\n`);
  out(options, `Requested:  ${request.requestedBy} (${request.requestedAt})\n`);
  out(options, `Decided:    ${request.decidedBy ?? "-"}\n`);
  out(options, `Expires:    ${request.expiresAt}\n`);
  out(options, `Note:       ${request.note ?? "-"}\n`);
  out(options, `Action:     ${request.actionId ?? "-"}\n`);
}

export async function listDeployRequests(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const params = parseQuery(options);
  const response = await client.request<DeployRequestListResponse>(
    "GET",
    `/api/deploy-requests?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["ID", "SERVICE", "STATUS", "REQUESTED BY", "EXPIRES", "NOTE"],
    response.items.map((request) => [
      shortId(request.id),
      request.service?.name ?? request.serviceId,
      request.status,
      request.requestedBy,
      request.expiresAt,
      request.note ?? "-",
    ]),
    options.output,
  );
  writeErr(options.output, `total: ${response.total}\n`);
}

export async function getDeployRequest(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "deploy-requests get");
  const request = await fetchRequest(client, id);
  printRequest(request, options);
}

function verbStatus(status: DeployRequestItem["status"]): string {
  if (status === "executed") return "approved";
  if (status === "failed") return "failed";
  return status;
}

function approvalTimeout(
  request: DeployRequestItem,
  options: CommandOptions,
): number {
  if (options.timeout !== undefined) {
    const parsed = Number(options.timeout);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new UsageError(
        "--timeout は 1 以上の整数（秒）で指定してください。",
      );
    }
    return parsed;
  }
  return request.snapshot.timeoutSec + request.snapshot.healthTimeoutSec + 30;
}

async function waitForDeployRequestResult(
  client: ApiClient,
  id: string,
  options: CommandOptions,
  timeoutSec: number,
): Promise<DeployRequestItem> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus: DeployRequestItem["status"] | null = null;

  while (Date.now() < deadline) {
    const request = await fetchRequest(client, id);
    lastStatus = request.status;
    if (request.status === "executed" || request.status === "failed") {
      return request;
    }
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
  }

  throw new CliError(
    `デプロイ要求が完了しませんでした (request=${id}, last=${lastStatus ?? "unknown"})`,
    5,
  );
}

export async function approveDeployRequest(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "deploy-requests approve");
  if (!options.yes) {
    const target = await fetchRequest(client, id);
    printRequest(target, { ...options, json: false });
    await confirmNonInteractive(`deploy request ${id} の approve`, options);
  }

  const result = await client.request<DeployDecisionResponse>(
    "POST",
    `/api/deploy-requests/${encodeURIComponent(id)}/approve`,
    options.note ? { note: options.note } : {},
  );

  if (options.wait && result.action) {
    const timeoutSec = approvalTimeout(result.request, options);
    const final = await waitForDeployRequestResult(
      client,
      id,
      options,
      timeoutSec,
    );
    if (options.json) {
      printJson({ ...result, request: final }, options.output);
    } else {
      out(options, `deploy request ${verbStatus(final.status)}: ${id}\n`);
      if (final.actionId) out(options, `action: ${final.actionId}\n`);
    }
    return final.status === "failed" ? 5 : 0;
  }

  if (options.json) {
    printJson(result, options.output);
  } else {
    out(options, `deploy request approved: ${id}\n`);
    if (result.action) out(options, `action: ${result.action.id}\n`);
  }
  return 0;
}

export async function rejectDeployRequest(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "deploy-requests reject");
  if (!options.yes) {
    const target = await fetchRequest(client, id);
    printRequest(target, { ...options, json: false });
    await confirmNonInteractive(`deploy request ${id} の reject`, options);
  }

  const result = await client.request<DeployDecisionResponse>(
    "POST",
    `/api/deploy-requests/${encodeURIComponent(id)}/reject`,
    options.note ? { note: options.note } : {},
  );

  if (options.json) {
    printJson(result, options.output);
  } else {
    out(options, `deploy request rejected: ${id}\n`);
  }
  return 0;
}

export async function createDeployRequest(
  client: ApiClient,
  serviceId: string,
  options: CommandOptions,
): Promise<DeployRequestItem> {
  return client.request<DeployRequestItem>(
    "POST",
    `/api/services/${encodeURIComponent(serviceId)}/deploy-requests`,
    options.note ? { note: options.note } : {},
  );
}
