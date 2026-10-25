import { approvalQuerySchema } from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
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
  type CommandOptions,
} from "./services.js";

interface ApprovalItem {
  id: string;
  incidentId: string;
  requestedAction: Record<string, unknown>;
  status: string;
  requestedAt: string | null;
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  note: string | null;
  incident: {
    id: string;
    title: string;
    severity: string;
    status: string;
  } | null;
  service: { id: string; name: string; status: string } | null;
}

interface ApprovalListResponse {
  items: ApprovalItem[];
  total: number;
}

interface DecisionResponse {
  approval: ApprovalItem;
  action: { id: string; status: string } | null;
  incident: { id: string; status: string };
}

function actionLabel(value: Record<string, unknown>): string {
  const type = typeof value.type === "string" ? value.type : "action";
  const reason = typeof value.reason === "string" ? value.reason : "";
  return reason ? `${type} (${reason})` : type;
}

function parseApprovalQuery(options: CommandOptions): URLSearchParams {
  try {
    const query = approvalQuerySchema.parse({
      status: options.status ?? "pending",
      limit: options.limit ?? 50,
    });
    const params = new URLSearchParams();
    params.set("status", query.status);
    params.set("limit", String(query.limit));
    return params;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new UsageError(
        `--status / --limit が不正です: ${error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    throw error;
  }
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} には承認IDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} には承認ID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

async function findPendingApproval(
  client: ApiClient,
  id: string,
): Promise<ApprovalItem | null> {
  const params = new URLSearchParams({ status: "pending", limit: "200" });
  const response = await client.request<ApprovalListResponse>(
    "GET",
    `/api/approvals?${params.toString()}`,
  );
  return response.items.find((item) => item.id === id) ?? null;
}

function printApprovalTarget(
  approval: ApprovalItem,
  options: CommandOptions,
): void {
  const write = (text: string) => void writeOut(options.output, text);
  write(`ID:        ${approval.id}\n`);
  write(`Incident:  ${approval.incident?.title ?? approval.incidentId}\n`);
  write(`Service:   ${approval.service?.name ?? "-"}\n`);
  write(`Action:    ${actionLabel(approval.requestedAction)}\n`);
  write(
    `Requested: ${approval.requestedBy ?? "system"} (${approval.requestedAt ?? "-"})\n`,
  );
}

export async function listApprovals(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  parseLimit(options.limit, 50, 200);
  const params = parseApprovalQuery(options);
  const response = await client.request<ApprovalListResponse>(
    "GET",
    `/api/approvals?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["ID", "INCIDENT", "SERVICE", "ACTION", "REQUESTED BY", "REQUESTED"],
    response.items.map((item) => [
      shortId(item.id),
      item.incident?.title ?? item.incidentId,
      item.service?.name ?? "-",
      actionLabel(item.requestedAction),
      item.requestedBy ?? "system",
      item.requestedAt ?? "-",
    ]),
    options.output,
  );
  writeErr(options.output, `total: ${response.total}\n`);
}

async function decideApproval(
  verb: "approve" | "reject",
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, `approvals ${verb}`);
  if (!options.yes) {
    const target = await findPendingApproval(client, id);
    if (!target) {
      throw new UsageError(
        `pending 承認が見つかりません: ${id}。approvals list で確認してください。`,
      );
    }
    printApprovalTarget(target, options);
    await confirmNonInteractive(`approval ${id} の ${verb}`, options);
  }

  const result = await client.request<DecisionResponse>(
    "POST",
    `/api/approvals/${encodeURIComponent(id)}/${verb}`,
    options.note ? { note: options.note } : {},
  );

  if (options.json) {
    printJson(result, options.output);
  } else {
    writeOut(options.output, `approval ${verb}d: ${id}\n`);
    if (result.action) {
      void writeOut(
        options.output,
        `action: ${result.action.id} (${result.action.status})\n`,
      );
    }
  }
}

export async function approveApproval(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  await decideApproval("approve", client, positionals, options);
}

export async function rejectApproval(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  await decideApproval("reject", client, positionals, options);
}
