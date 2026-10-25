import { setTimeout as sleep } from "node:timers/promises";
import {
  logQuerySchema,
  logStreamQuerySchema,
  type LogQuery,
  type LogStreamQuery,
} from "@sys4sys/shared";
import { ZodError } from "zod";
import { ApiError, type ApiClient } from "../client.js";
import { CliError, UsageError } from "../errors.js";
import { printJson, writeErr, writeOut } from "../output.js";
import { parseSince, parseUntil } from "../time.js";
import type { LogEvent } from "../types.js";
import { parseLimit, type CommandOptions } from "./services.js";

export interface LogPage {
  items: LogEvent[];
  nextCursor: string | null;
}

const TRUNCATE_LENGTH = 200;
const MAX_RECONNECT_ATTEMPTS = 10;

function zodToUsage(error: unknown): UsageError {
  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    return new UsageError(`入力が不正です: ${details}`);
  }
  return new UsageError(
    `入力が不正です: ${error instanceof Error ? error.message : String(error)}`,
  );
}

export function buildLogQuery(
  options: CommandOptions,
  now: Date = new Date(),
): LogQuery {
  try {
    return logQuerySchema.parse({
      hostId: options.host,
      serviceId: options.service,
      level: options.level,
      q: options.grep,
      from: parseSince(options.since, now),
      to: parseUntil(options.until),
      limit: parseLimit(options.limit, 100, 500),
      cursor: options.cursor,
    });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw zodToUsage(error);
  }
}

export function buildLogStreamQuery(
  options: CommandOptions,
  now: Date = new Date(),
): LogStreamQuery {
  try {
    return logStreamQuerySchema.parse({
      hostId: options.host,
      serviceId: options.service,
      level: options.level,
      q: options.grep,
      from: parseSince(options.since, now),
      to: parseUntil(options.until),
    });
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw zodToUsage(error);
  }
}

export function formatLogLine(event: LogEvent, noTruncate = false): string {
  const message = noTruncate ? event.message : truncate(event.message);
  const subject = event.serviceId || event.hostId || "-";
  return `${event.ts}  ${event.level.padEnd(5)}  ${subject}  ${message}`;
}

function truncate(message: string): string {
  if (message.length <= TRUNCATE_LENGTH) return message;
  return `${message.slice(0, TRUNCATE_LENGTH - 1)}…`;
}

export async function queryLogs(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const query = buildLogQuery(options);
  const params = new URLSearchParams();
  if (query.hostId) params.set("hostId", query.hostId);
  if (query.serviceId) params.set("serviceId", query.serviceId);
  if (query.level) params.set("level", query.level);
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);

  const page = await client.request<LogPage>(
    "GET",
    `/api/logs?${params.toString()}`,
  );

  if (options.json) {
    printJson(page, options.output);
    return;
  }

  if (page.items.length === 0) {
    await writeOut(options.output, "ログはありません。\n");
  } else {
    for (const event of page.items) {
      await writeOut(
        options.output,
        `${formatLogLine(event, options.noTruncate)}\n`,
      );
    }
  }

  if (page.nextCursor) {
    writeErr(options.output, `next: --cursor ${page.nextCursor}\n`);
  }
}

export function parseSseBlock(block: string): {
  event: string;
  data: string;
} | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

async function consumeStream(
  response: Response,
  onEvent: (event: LogEvent) => Promise<void>,
  output?: CommandOptions["output"],
): Promise<number> {
  if (!response.body) {
    throw new CliError("ログストリームの本文がありません。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let events = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseBlock(block);
        if (parsed && parsed.event === "log") {
          events += 1;
          try {
            await onEvent(JSON.parse(parsed.data) as LogEvent);
          } catch (error) {
            if (error instanceof CliError) throw error;
            writeErr(
              output,
              `ログイベントを解析できませんでした: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

export async function tailLogs(
  client: ApiClient,
  options: CommandOptions,
): Promise<number> {
  const query = buildLogStreamQuery(options);
  const params = new URLSearchParams();
  if (query.hostId) params.set("hostId", query.hostId);
  if (query.serviceId) params.set("serviceId", query.serviceId);
  if (query.level) params.set("level", query.level);
  if (query.q) params.set("q", query.q);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  const path = `/api/logs/stream?${params.toString()}`;

  const controller = new AbortController();
  const abort = () => controller.abort();
  const external = options.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", abort, { once: true });
  }
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const maxReconnectAttempts =
    options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
  const configuredBackoffMs = options.reconnectDelayMs;
  let backoffMs = configuredBackoffMs ?? 1000;
  let reconnectAttempts = 0;
  try {
    while (!controller.signal.aborted) {
      let received = 0;
      try {
        const response = await client.openStream(path, controller.signal);
        backoffMs = configuredBackoffMs ?? 1000;
        received = await consumeStream(
          response,
          async (event) => {
            if (options.json) {
              await writeOut(options.output, `${JSON.stringify(event)}\n`);
            } else {
              await writeOut(
                options.output,
                `${formatLogLine(event, options.noTruncate)}\n`,
              );
            }
          },
          options.output,
        );
        if (received > 0) reconnectAttempts = 0;
      } catch (error) {
        if (controller.signal.aborted) return 0;
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.status === 403)
        ) {
          throw error;
        }
        if (options.noReconnect) throw error;
        reconnectAttempts += 1;
        if (reconnectAttempts > maxReconnectAttempts) {
          throw new CliError(
            `再接続が ${maxReconnectAttempts} 回を超えました。--no-reconnect で停止できます。`,
            1,
          );
        }
        writeErr(
          options.output,
          `接続が切れました。${Math.round(backoffMs / 1000)} 秒後に再接続します...\n`,
        );
        await wait(backoffMs, controller.signal);
        backoffMs = configuredBackoffMs ?? Math.min(backoffMs * 2, 30_000);
        continue;
      }

      if (controller.signal.aborted) return 0;
      if (options.noReconnect) return 0;
      reconnectAttempts += 1;
      if (reconnectAttempts > maxReconnectAttempts) {
        throw new CliError(
          `再接続が ${maxReconnectAttempts} 回を超えました。--no-reconnect で停止できます。`,
          1,
        );
      }
      writeErr(
        options.output,
        `ストリームが終了しました。${Math.round(backoffMs / 1000)} 秒後に再接続します...\n`,
      );
      await wait(backoffMs, controller.signal);
      backoffMs = configuredBackoffMs ?? Math.min(backoffMs * 2, 30_000);
    }
    return 0;
  } finally {
    external?.removeEventListener("abort", abort);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch {
    // abort による終了は呼び出し側で判定する
  }
}
