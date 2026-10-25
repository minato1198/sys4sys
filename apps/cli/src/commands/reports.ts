import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { reportExportQuerySchema, reportQuerySchema } from "@sys4sys/shared";
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
import { parseLimit, parseOffset, type CommandOptions } from "./services.js";

interface ReportIncident {
  id: string;
  title: string;
  severity: string;
  status: string;
  serviceName: string | null;
}

interface ReportItem {
  id: string;
  incidentId: string;
  format: string;
  body: string;
  createdAt: string;
  incident: ReportIncident | null;
}

interface ReportDetail extends ReportItem {
  analysis: unknown;
}

interface ReportListResponse {
  items: ReportItem[];
  total: number;
}

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} にはレポートIDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} にはレポートID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function parseReportQuery(options: CommandOptions): URLSearchParams {
  try {
    const query = reportQuerySchema.parse({
      incidentId: options.incident,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
    });
    const params = new URLSearchParams();
    if (query.incidentId) params.set("incidentId", query.incidentId);
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

function printBody(body: string, options: CommandOptions): void {
  if (options.full) {
    out(options, body.endsWith("\n") ? body : `${body}\n`);
    return;
  }

  const lines = body.split(/\r?\n/);
  for (const line of lines.slice(0, 40)) out(options, `${line}\n`);
  if (lines.length > 40) {
    out(
      options,
      `\n...(${lines.length - 40} lines hidden. Use --full or --json.)\n`,
    );
  }
}

export async function listReports(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  parseLimit(options.limit, 50, 200);
  parseOffset(options.offset);
  const params = parseReportQuery(options);
  const response = await client.request<ReportListResponse>(
    "GET",
    `/api/reports?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["ID", "INCIDENT", "SERVICE", "CREATED", "FORMAT"],
    response.items.map((item) => [
      shortId(item.id),
      item.incident?.title ?? item.incidentId,
      item.incident?.serviceName ?? "-",
      item.createdAt,
      item.format,
    ]),
    options.output,
  );
  writeErr(options.output, `total: ${response.total}\n`);
}

export async function getReport(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "reports get");
  const report = await client.request<ReportDetail>(
    "GET",
    `/api/reports/${encodeURIComponent(id)}`,
  );

  if (options.json) {
    printJson(report, options.output);
    return;
  }

  out(options, `ID:       ${report.id}\n`);
  out(options, `Incident: ${report.incident?.title ?? report.incidentId}\n`);
  out(options, `Created:  ${report.createdAt}\n`);
  out(options, `Format:   ${report.format}\n\n`);
  printBody(report.body, options);
}

export async function exportReport(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "reports export");
  let format = "md";
  try {
    format = reportExportQuerySchema.parse({ format: options.format }).format;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new UsageError(
        "--format は md|json のいずれかを指定してください。",
      );
    }
    throw error;
  }

  const path = options.outputPath;
  if (format === "json") {
    const payload = await client.request<{
      report: ReportDetail;
      analysis: unknown;
    }>("GET", `/api/reports/${encodeURIComponent(id)}/export?format=json`);

    if (path && path !== "-") {
      await writeFile(resolve(path), JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        flag: options.force ? "w" : "wx",
      });
      if (options.json) {
        printJson({ exported: true, path, format }, options.output);
      } else {
        out(options, `exported: ${resolve(path)}\n`);
      }
      return;
    }

    printJson(payload, options.output);
    return;
  }

  const body = await client.request<string>(
    "GET",
    `/api/reports/${encodeURIComponent(id)}/export?format=md`,
  );
  const text = typeof body === "string" ? body : String(body ?? "");

  if (path && path !== "-") {
    try {
      await writeFile(resolve(path), text, {
        encoding: "utf8",
        flag: options.force ? "w" : "wx",
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new UsageError(
          `出力ファイルが既にあります: ${resolve(path)}。上書きするには --force を指定してください。`,
        );
      }
      throw error;
    }

    if (options.json) {
      printJson(
        { exported: true, path: resolve(path), format, metadata: { id } },
        options.output,
      );
    } else {
      out(options, `exported: ${resolve(path)}\n`);
    }
    return;
  }

  out(options, text.endsWith("\n") ? text : `${text}\n`);
}
