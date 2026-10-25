import { auditLogQuerySchema } from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { printJson, printTable, shortId, writeErr } from "../output.js";
import { parseLimit, parseOffset, type CommandOptions } from "./services.js";

interface AuditItem {
  id: string;
  actorUserId: string | null;
  actorLabel: string | null;
  action: string;
  target: string | null;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  ts: string;
}

interface AuditResponse {
  items: AuditItem[];
  total: number;
}

function parseAuditQuery(options: CommandOptions): URLSearchParams {
  try {
    const query = auditLogQuerySchema.parse({
      actor: options.actor,
      action: options.action,
      target: options.target,
      from: options.since,
      to: options.until,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
    });

    const params = new URLSearchParams();
    if (query.actor) params.set("actor", query.actor);
    if (query.action) params.set("action", query.action);
    if (query.target) params.set("target", query.target);
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    params.set("limit", String(query.limit));
    params.set("offset", String(query.offset));
    return params;
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
}

export async function listAudit(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  parseLimit(options.limit, 100, 500);
  parseOffset(options.offset);
  const params = parseAuditQuery(options);
  const response = await client.request<AuditResponse>(
    "GET",
    `/api/audit-logs?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["TS", "ACTOR", "ACTION", "TARGET", "REASON"],
    response.items.map((item) => [
      item.ts,
      item.actorLabel ?? "-",
      item.action,
      item.target ?? "-",
      item.reason ?? "-",
    ]),
    options.output,
  );
  writeErr(options.output, `total: ${response.total}\n`);
}
