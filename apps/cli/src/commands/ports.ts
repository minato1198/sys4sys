import {
  killTokenQuerySchema,
  portHistoryQuerySchema,
  portScopeSchema,
  protocolSchema,
  reservationCreateSchema,
  type PortScope,
  type Protocol,
} from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { ApiError } from "../client.js";
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
  type CommandOptions,
} from "./services.js";

interface PortItem {
  id: string;
  scope: PortScope;
  protocol: Protocol;
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
  commandLine: string | null;
  serviceId: string | null;
  status: string;
  conflict: boolean;
}

interface ReservationItem {
  id: string;
  scope: PortScope;
  protocol: Protocol;
  port: number;
  serviceId: string;
  note: string | null;
  createdAt: string;
  status: string;
  inUse: boolean;
}

interface PortListResponse {
  scannedAt: string;
  items: PortItem[];
  reservations: ReservationItem[];
  conflicts: ReservationItem[];
}

interface PortHistoryItem {
  id: string;
  scope: PortScope;
  pidScope: string | null;
  protocol: Protocol;
  port: number;
  pid: number | null;
  process: string | null;
  serviceId: string | null;
  openedAt: string;
  closedAt: string | null;
  releasedBy: string | null;
}

interface KillToken {
  token: string;
  expiresAt: string;
  scope: PortScope;
  pidScope: string | null;
  port: number;
  pid: number;
  process: string | null;
}

interface ActionResponse {
  id: string;
  type: string;
  status: string;
  error: string | null;
}

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

function zodUsage(error: unknown): UsageError {
  if (error instanceof ZodError) {
    return new UsageError(
      `入力が不正です: ${error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return new UsageError(
    `入力が不正です: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function singleScope(
  options: CommandOptions,
  command: string,
): string | undefined {
  const values =
    options.scope ?? (options.portScope ? [options.portScope] : []);
  if (values.length > 1) {
    throw new UsageError(`${command} の --scope は 1 回だけ指定してください。`);
  }
  return values[0];
}

function requireScope(options: CommandOptions, command: string): PortScope {
  const scope = singleScope(options, command);
  if (!scope) {
    throw new UsageError(`${command} には --scope windows|wsl が必要です。`);
  }
  try {
    return portScopeSchema.parse(scope);
  } catch (error) {
    throw zodUsage(error);
  }
}

function parseOptionalProtocol(
  value: string | undefined,
): Protocol | undefined {
  if (!value) return undefined;
  try {
    return protocolSchema.parse(value);
  } catch (error) {
    throw zodUsage(error);
  }
}

function parsePortFlag(value: string | undefined, command: string): number {
  if (!value) {
    throw new UsageError(`${command} には --port 1〜65535 が必要です。`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new UsageError("--port は 1〜65535 の整数で指定してください。");
  }
  return parsed;
}

function parsePortPositional(value: string | undefined): number {
  if (!value) {
    throw new UsageError("ports kill にはポートが必要です。");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new UsageError("ポートは 1〜65535 の整数で指定してください。");
  }
  return parsed;
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} には予約IDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} には予約ID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function conflictPrefix(item: PortItem): string {
  return item.conflict || item.status === "conflict" ? "! " : "";
}

export async function listPorts(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const scope = singleScope(options, "ports list") ?? "all";
  if (!["all", "windows", "wsl"].includes(scope)) {
    throw new UsageError(
      "--scope は all|windows|wsl のいずれかを指定してください。",
    );
  }

  const params = new URLSearchParams({ scope });
  const protocol = parseOptionalProtocol(options.protocol);
  if (protocol) params.set("protocol", protocol);
  if (options.port)
    params.set("port", String(parsePortFlag(options.port, "ports list")));
  if (options.service) params.set("serviceId", options.service);
  if (options.grep) params.set("q", options.grep);

  const response = await client.request<PortListResponse>(
    "GET",
    `/api/ports?${params.toString()}`,
  );

  if (options.json) {
    printJson(response, options.output);
    return;
  }

  printTable(
    ["SCOPE", "PROTO", "PORT", "PID", "PROCESS", "SERVICE", "STATUS"],
    response.items.map((item) => [
      conflictPrefix(item) + item.scope,
      item.protocol,
      String(item.port),
      item.pid ? String(item.pid) : "-",
      item.process ?? "-",
      item.serviceId ? shortId(item.serviceId) : "-",
      item.status,
    ]),
    options.output,
  );

  if (options.reservations || response.reservations.length > 0) {
    out(options, "\nReservations:\n");
    if (response.reservations.length === 0) {
      out(options, "  none\n");
    } else {
      printTable(
        ["ID", "SCOPE", "PROTO", "PORT", "SERVICE", "STATUS"],
        response.reservations.map((reservation) => [
          shortId(reservation.id),
          reservation.scope,
          reservation.protocol,
          String(reservation.port),
          shortId(reservation.serviceId),
          reservation.status,
        ]),
        options.output,
      );
    }
  }
}

export async function portHistory(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const scope = requireScope(options, "ports history");
  const port = parsePortFlag(options.port, "ports history");
  let query;
  try {
    query = portHistoryQuerySchema.parse({
      scope,
      port,
      protocol: options.protocol,
      from: options.since,
      to: options.until,
      limit: options.limit ?? 100,
    });
  } catch (error) {
    throw zodUsage(error);
  }

  const params = new URLSearchParams();
  params.set("scope", query.scope);
  params.set("port", String(query.port));
  if (query.protocol) params.set("protocol", query.protocol);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  params.set("limit", String(query.limit));

  const rows = await client.request<PortHistoryItem[]>(
    "GET",
    `/api/ports/history?${params.toString()}`,
  );

  if (options.json) {
    printJson(rows, options.output);
    return;
  }

  if (rows.length === 0) {
    out(options, "history: none\n");
    return;
  }

  printTable(
    ["OPENED", "CLOSED", "PID", "PROCESS", "SERVICE", "RELEASED BY"],
    rows.map((row) => [
      row.openedAt,
      row.closedAt ?? "open",
      row.pid ? String(row.pid) : "-",
      row.process ?? "-",
      row.serviceId ? shortId(row.serviceId) : "-",
      row.releasedBy ?? "-",
    ]),
    options.output,
  );
}

export async function reservePort(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const scope = requireScope(options, "ports reserve");
  const port = parsePortFlag(options.port, "ports reserve");
  if (!options.protocol) {
    throw new UsageError("ports reserve には --protocol tcp|udp が必要です。");
  }
  if (!options.service) {
    throw new UsageError("ports reserve には --service <id> が必要です。");
  }

  let body;
  try {
    body = reservationCreateSchema.parse({
      scope,
      port,
      protocol: options.protocol,
      serviceId: options.service,
      note: options.note,
    });
  } catch (error) {
    throw zodUsage(error);
  }

  const created = await client.request<ReservationItem>(
    "POST",
    "/api/ports/reserve",
    body,
  );

  if (options.json) {
    printJson(created, options.output);
  } else {
    out(options, `reservation created: ${created.id}\n`);
  }
}

export async function releasePort(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "ports release");
  await confirmNonInteractive(`reservation ${id} の release`, options);
  await client.request<void>(
    "DELETE",
    `/api/ports/reserve/${encodeURIComponent(id)}`,
  );

  if (options.json) {
    printJson({ released: true, id }, options.output);
  } else {
    out(options, `reservation released: ${id}\n`);
  }
}

export async function killPort(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const port = parsePortPositional(positionals[0]);
  if (positionals.length > 1) {
    throw new UsageError(
      `ports kill にはポート以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  const scope = requireScope(options, "ports kill");
  const signal = parseKillSignal(options.killSignal);

  const params = new URLSearchParams({ scope });
  if (options.pid) params.set("pid", options.pid);
  if (options.pidScope) params.set("pidScope", options.pidScope);

  const token = await client.request<KillToken>(
    "GET",
    `/api/ports/${port}/kill-token?${params.toString()}`,
  );

  out(options, `Target: ${token.scope}:${token.port} pid=${token.pid}\n`);
  out(options, `Process: ${token.process ?? "-"}\n`);
  out(options, `Token expires: ${token.expiresAt}\n`);
  await confirmNonInteractive(
    `port ${token.port} (pid=${token.pid}) の kill`,
    options,
  );

  try {
    const action = await client.request<ActionResponse>(
      "POST",
      `/api/ports/${port}/kill`,
      {
        scope: token.scope,
        pidScope: token.pidScope,
        confirmToken: token.token,
        signal,
        force: options.force ?? false,
      },
    );

    if (options.json) {
      printJson(action, options.output);
    } else {
      out(options, `Action:  ${action.id}\n`);
      out(options, `Status:  ${action.status}\n`);
      if (action.error) out(options, `Error:   ${action.error}\n`);
    }
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 400 &&
      error.detail.includes("トークン")
    ) {
      throw new CliError(
        "確認トークンの期限が切れたか無効です。ports kill を再実行してトークンを再取得してください。",
        4,
      );
    }
    throw error;
  }
}

export function parseKillSignal(value: string | undefined): "TERM" | "KILL" {
  if (!value) return "TERM";
  if (value === "TERM" || value === "KILL") return value;
  throw new UsageError("--signal は TERM|KILL のいずれかを指定してください。");
}
