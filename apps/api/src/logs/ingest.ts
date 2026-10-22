import { randomUUID } from "node:crypto";
import type { LogLevel } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logEvents } from "../db/schema.js";
import { publishLog } from "./bus.js";
import {
  detectLevel,
  fingerprintOf,
  normalizeLine,
  type LogStream,
} from "./parse.js";

export {
  coerceLevel,
  detectLevel,
  fingerprintOf,
  normalizeLine,
} from "./parse.js";
export type { LogStream } from "./parse.js";

export interface LogEventView {
  id: string;
  hostId: string;
  serviceId: string;
  ts: string;
  level: LogLevel;
  stream: LogStream;
  message: string;
  fields: Record<string, unknown> | null;
  fingerprint: string;
}

export interface IngestLogInput {
  hostId: string;
  serviceId: string;
  stream: LogStream;
  message: string;
  level?: LogLevel;
  fields?: Record<string, unknown> | null;
  ts?: Date;
}

function toRow(input: IngestLogInput) {
  const normalized = normalizeLine(input.message, input.stream);
  const message = normalized.message.slice(0, config.LOG_MAX_LINE_CHARS);
  const level =
    input.level ?? normalized.level ?? detectLevel(message, input.stream);
  const fields = input.fields ?? normalized.fields ?? null;
  const ts = input.ts ?? new Date();
  return {
    id: randomUUID(),
    hostId: input.hostId,
    serviceId: input.serviceId,
    ts,
    level,
    stream: input.stream,
    message,
    fields,
    fingerprint: fingerprintOf(message),
  };
}

function toView(row: ReturnType<typeof toRow>): LogEventView {
  return {
    id: row.id,
    hostId: row.hostId,
    serviceId: row.serviceId,
    ts: row.ts.toISOString(),
    level: row.level,
    stream: row.stream,
    message: row.message,
    fields: row.fields,
    fingerprint: row.fingerprint,
  };
}

export async function ingestLog(
  input: IngestLogInput,
): Promise<LogEventView | null> {
  const result = await ingestLogs([input]);
  return result[0] ?? null;
}

export async function ingestLogs(
  inputs: IngestLogInput[],
): Promise<LogEventView[]> {
  const rows = inputs
    .filter((input) => input.message.trim().length > 0)
    .map(toRow);
  if (rows.length === 0) return [];

  await db.insert(logEvents).values(rows);
  const views = rows.map(toView);
  for (const view of views) publishLog(view);
  return views;
}
