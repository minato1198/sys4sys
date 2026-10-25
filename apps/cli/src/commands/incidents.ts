import { incidentQuerySchema } from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import {
  printJson,
  printTable,
  shortId,
  writeErr,
  writeOut,
  type CliOutput,
} from "../output.js";
import {
  confirmNonInteractive,
  parseLimit,
  parseOffset,
  type CommandOptions,
} from "./services.js";

interface IncidentServiceRef {
  id: string;
  name: string;
  status: string;
}

export interface IncidentListItem {
  id: string;
  serviceId: string;
  title: string;
  severity: string;
  status: string;
  startedAt: string | null;
  resolvedAt: string | null;
  summary: string | null;
  pendingApprovalId: string | null;
  service: IncidentServiceRef | null;
}

interface IncidentListResponse {
  items: IncidentListItem[];
  total: number;
}

interface ApprovalSummary {
  id: string;
  status: string;
  requestedAt: string | null;
  decidedBy: string | null;
  requestedAction: Record<string, unknown>;
}

interface ActionSummary {
  id: string;
  type: string;
  status: string;
  startedAt: string | null;
  error: string | null;
}

export interface IncidentDetail extends IncidentListItem {
  events: Array<{ id: string; ts: string | null; type: string }>;
  approvals: ApprovalSummary[];
  actions: ActionSummary[];
  analysis: {
    result?: {
      summary: string;
      rootCauseHypothesis: string;
      evidence: Array<{ quote: string }>;
      recommendedActions: Array<{ type: string; detail: string | null }>;
    };
  } | null;
  report: { body: string; createdAt: string } | null;
}

interface AnalysisResponse {
  analysis: {
    result?: {
      summary: string;
      rootCauseHypothesis: string;
      evidence: Array<{ quote: string }>;
      recommendedActions: Array<{ type: string; detail: string | null }>;
    };
  } | null;
  report: { body: string; createdAt: string } | null;
}

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

function err(options: CommandOptions, text: string): void {
  writeErr(options.output, text);
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} にはインシデントIDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} にはインシデントID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function parseIncidentQuery(options: CommandOptions): URLSearchParams {
  let query;
  try {
    query = incidentQuerySchema.parse({
      status: options.status,
      severity: options.severity,
      serviceId: options.service,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw new UsageError(
        `フィルタが不正です: ${error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    throw error;
  }

  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.severity) params.set("severity", query.severity);
  if (query.serviceId) params.set("serviceId", query.serviceId);
  params.set("limit", String(query.limit));
  params.set("offset", String(query.offset));
  return params;
}

function formatIncidentRow(incident: IncidentListItem): string[] {
  return [
    shortId(incident.id),
    incident.severity,
    incident.status,
    incident.service?.name ?? incident.serviceId,
    incident.startedAt ?? "-",
    incident.title,
  ];
}

function bodyText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function printAnalysis(
  detail: {
    analysis: IncidentDetail["analysis"];
    report: IncidentDetail["report"];
  },
  options: CommandOptions,
): void {
  if (!detail.analysis) {
    out(options, "\nAnalysis: none\n");
    return;
  }

  const result = detail.analysis.result;
  out(options, "\nLatest analysis:\n");
  out(options, `  summary: ${result?.summary ?? "-"}\n`);
  if (options.full) {
    out(options, `  hypothesis: ${result?.rootCauseHypothesis ?? "-"}\n`);
    for (const evidence of result?.evidence ?? []) {
      out(options, `  evidence: ${evidence.quote}\n`);
    }
    for (const action of result?.recommendedActions ?? []) {
      out(
        options,
        `  action: ${action.type}${action.detail ? ` (${action.detail})` : ""}\n`,
      );
    }
  } else {
    out(options, "  全文は --json または --full で表示します。\n");
  }

  if (detail.report) {
    out(options, "\nReport:\n");
    const body = detail.report.body;
    if (options.full) {
      out(options, body.endsWith("\n") ? body : `${body}\n`);
    } else {
      const lines = body.split(/\r?\n/).slice(0, 20);
      for (const line of lines) out(options, `  ${line}\n`);
      if (body.split(/\r?\n/).length > 20) {
        out(options, "  ...(全文は --json または --full)\n");
      }
    }
  }
}

export async function listIncidents(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  parseLimit(options.limit, 50, 200);
  parseOffset(options.offset);
  const params = parseIncidentQuery(options);
  const response = await client.request<IncidentListResponse>(
    "GET",
    `/api/incidents?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["ID", "SEVERITY", "STATUS", "SERVICE", "STARTED", "TITLE"],
    response.items.map(formatIncidentRow),
    options.output,
  );
  err(options, `total: ${response.total}\n`);
}

export async function getIncident(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "incidents get");
  const detail = await client.request<IncidentDetail>(
    "GET",
    `/api/incidents/${encodeURIComponent(id)}`,
  );

  if (options.json) {
    printJson(detail, options.output);
    return;
  }

  out(options, `ID:       ${detail.id}\n`);
  out(options, `Title:    ${detail.title}\n`);
  out(options, `Severity: ${detail.severity}\n`);
  out(options, `Status:   ${detail.status}\n`);
  out(options, `Service:  ${detail.service?.name ?? detail.serviceId}\n`);
  out(options, `Started:  ${detail.startedAt ?? "-"}\n`);
  out(options, `Approval: ${detail.pendingApprovalId ?? "-"}\n`);

  out(options, "\nApprovals:\n");
  if (detail.approvals.length === 0) {
    out(options, "  none\n");
  } else {
    for (const approval of detail.approvals) {
      out(
        options,
        `  ${shortId(approval.id)} ${approval.status} action=${bodyText(
          approval.requestedAction.type ?? approval.requestedAction,
        )}\n`,
      );
    }
  }

  out(options, "\nActions:\n");
  if (detail.actions.length === 0) {
    out(options, "  none\n");
  } else {
    for (const action of detail.actions) {
      out(
        options,
        `  ${shortId(action.id)} ${action.type} ${action.status}${
          action.error ? ` error=${action.error}` : ""
        }\n`,
      );
    }
  }

  if (options.full) {
    out(options, "\nEvents:\n");
    if (detail.events.length === 0) out(options, "  none\n");
    for (const event of detail.events) {
      out(options, `  ${event.ts ?? "-"} ${event.type}\n`);
    }
  }

  printAnalysis(detail, options);
}

export async function ackIncident(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "incidents ack");
  await client.request<IncidentDetail>(
    "POST",
    `/api/incidents/${encodeURIComponent(id)}/ack`,
    options.note ? { note: options.note } : {},
  );

  if (options.json) {
    printJson({ acked: true, id }, options.output);
  } else {
    out(options, `incident acked: ${id}\n`);
  }
}

export async function resolveIncident(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "incidents resolve");
  await confirmNonInteractive(`incident ${id} の resolve`, options);
  await client.request<IncidentDetail>(
    "POST",
    `/api/incidents/${encodeURIComponent(id)}/resolve`,
    options.note ? { note: options.note } : {},
  );

  if (options.json) {
    printJson({ resolved: true, id }, options.output);
  } else {
    out(options, `incident resolved: ${id}\n`);
  }
}

export async function analyzeIncident(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "incidents analyze");
  const result = await client.request<{
    incidentId: string;
    queued: boolean;
    alreadyQueued: boolean;
    status: string;
  }>("POST", `/api/incidents/${encodeURIComponent(id)}/analyze`);

  if (options.json) {
    printJson(result, options.output);
  } else {
    out(options, `analysis queued: ${id}\n`);
  }
}

export async function incidentAnalysis(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "incidents analysis");
  const detail = await client.request<AnalysisResponse>(
    "GET",
    `/api/incidents/${encodeURIComponent(id)}/analysis`,
  );

  if (options.json) {
    printJson(detail, options.output);
  } else {
    printAnalysis(detail, options);
  }
}
