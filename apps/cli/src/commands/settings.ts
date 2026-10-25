import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  aiSettingsUpdateSchema,
  mailSettingsSchema,
  retentionSettingsSchema,
} from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { printJson, writeOut } from "../output.js";
import { confirmNonInteractive, type CommandOptions } from "./services.js";

type JsonValue = unknown;

interface MailView {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  from: string;
  recipients: string[];
  mode: string;
  passwordSet: boolean;
}

interface AiView {
  baseUrl: string;
  model: string;
  maxInputTokens: number;
  temperature: number;
  timeoutSec: number;
  dailyRequestLimit: number;
  sendLogsExternally: boolean;
  apiKeySet: boolean;
}

interface RetentionView {
  logDays: number;
}

interface BackupResult {
  path: string;
  sizeBytes: number;
}

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonFile(path: string): Promise<JsonValue> {
  let text: string;
  try {
    text =
      path === "-" ? await readStdin() : await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new UsageError(
      `ファイルを読み込めません (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new UsageError(
      `JSON を解析できません (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function zodUsage(error: unknown): UsageError {
  if (error instanceof ZodError) {
    return new UsageError(
      `設定 JSON が不正です: ${error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return new UsageError(
    `設定 JSON が不正です: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function requireFile(
  options: CommandOptions,
  command: string,
): Promise<JsonValue> {
  if (!options.file) {
    throw new UsageError(`${command} には --file <json|-|-> が必要です。`);
  }
  return readJsonFile(options.file);
}

function requireNoPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new UsageError(
      `${command} に不要な引数があります: ${positionals.join(" ")}`,
    );
  }
}

function printBackup(result: BackupResult, options: CommandOptions): void {
  if (options.json) {
    printJson(result, options.output);
    return;
  }
  out(options, `Backup path:  ${result.path}\n`);
  out(options, `Backup size:  ${result.sizeBytes} bytes\n`);
}

export async function getMailSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings mail get");
  const view = await client.request<MailView>("GET", "/api/settings/mail");
  if (options.json) {
    printJson(view, options.output);
    return;
  }
  out(options, `Host:        ${view.host}\n`);
  out(options, `Port:        ${view.port}\n`);
  out(options, `Secure:      ${view.secure ? "yes" : "no"}\n`);
  out(options, `Username:    ${view.username ?? "-"}\n`);
  out(options, `From:        ${view.from}\n`);
  out(options, `Recipients:  ${view.recipients.join(", ")}\n`);
  out(options, `Mode:        ${view.mode}\n`);
  out(options, `Password:    ${view.passwordSet ? "set" : "unset"}\n`);
}

export async function setMailSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings mail set");
  const input = await requireFile(options, "settings mail set");
  let body: { password?: string; clearPassword?: boolean } & Record<
    string,
    unknown
  >;
  try {
    const parsed = mailSettingsSchema.parse(input);
    if (input !== null && typeof input === "object" && !Array.isArray(input)) {
      body = {
        ...parsed,
        ...((input as Record<string, unknown>).clearPassword === true
          ? { clearPassword: true }
          : {}),
      };
    } else {
      body = parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw zodUsage(error);
  }

  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: mail settings は更新しません。\n");
    }
    printJson({ dryRun: true, mail: redactMail(body) }, options.output);
    return;
  }

  await confirmNonInteractive("settings mail set", options);
  const view = await client.request<MailView>(
    "PUT",
    "/api/settings/mail",
    body,
  );
  if (options.json) {
    printJson(view, options.output);
  } else {
    out(options, "mail settings updated.\n");
  }
}

export async function testMailSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings mail test");
  const result = await client.request<unknown>(
    "POST",
    "/api/settings/mail/test",
  );
  if (options.json) {
    printJson(result, options.output);
  } else {
    out(options, "mail test succeeded.\n");
  }
}

export async function getAiSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings ai get");
  const view = await client.request<AiView>("GET", "/api/settings/ai");
  if (options.json) {
    printJson(view, options.output);
    return;
  }
  out(options, `Base URL:             ${view.baseUrl}\n`);
  out(options, `Model:              ${view.model}\n`);
  out(options, `API key:            ${view.apiKeySet ? "set" : "unset"}\n`);
  out(options, `Max input tokens:   ${view.maxInputTokens}\n`);
  out(options, `Temperature:        ${view.temperature}\n`);
  out(options, `Timeout:            ${view.timeoutSec}s\n`);
  out(options, `Daily limit:        ${view.dailyRequestLimit}\n`);
  out(
    options,
    `Send logs:          ${view.sendLogsExternally ? "yes" : "no"}\n`,
  );
}

export async function setAiSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings ai set");
  const input = await requireFile(options, "settings ai set");
  let body;
  try {
    body = aiSettingsUpdateSchema.parse(input);
  } catch (error) {
    throw zodUsage(error);
  }

  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: ai settings は更新しません。\n");
    }
    printJson({ dryRun: true, ai: redactAi(body) }, options.output);
    return;
  }

  await confirmNonInteractive("settings ai set", options);
  const view = await client.request<AiView>("PUT", "/api/settings/ai", body);
  if (options.json) {
    printJson(view, options.output);
  } else {
    out(options, "ai settings updated.\n");
  }
}

export async function testAiSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings ai test");
  const result = await client.request<unknown>("POST", "/api/ai/test");
  if (options.json) {
    printJson(result, options.output);
  } else {
    out(options, "ai test succeeded.\n");
  }
}

export async function getRetentionSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings retention get");
  const view = await client.request<RetentionView>(
    "GET",
    "/api/settings/retention",
  );
  if (options.json) {
    printJson(view, options.output);
    return;
  }
  out(options, `Log days: ${view.logDays}\n`);
}

export async function setRetentionSettings(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings retention set");
  const input = await requireFile(options, "settings retention set");
  let body;
  try {
    body = retentionSettingsSchema.parse(input);
  } catch (error) {
    throw zodUsage(error);
  }

  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: retention settings は更新しません。\n");
    }
    printJson({ dryRun: true, retention: body }, options.output);
    return;
  }

  await confirmNonInteractive("settings retention set", options);
  const view = await client.request<RetentionView>(
    "PUT",
    "/api/settings/retention",
    body,
  );
  if (options.json) {
    printJson(view, options.output);
  } else {
    out(options, "retention settings updated.\n");
  }
}

export async function createBackup(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  requireNoPositionals(positionals, "settings backup");
  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: backup は作成しません。\n");
    }
    printJson({ dryRun: true, action: "backup" }, options.output);
    return;
  }

  await confirmNonInteractive("settings backup", options);
  const result = await client.request<BackupResult>(
    "POST",
    "/api/admin/backup",
  );
  printBackup(result, options);
}

function redactMail(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "password" && typeof value === "string" ? "***" : value,
    ]),
  );
}

function redactAi(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      key === "apiKey" && typeof value === "string" ? "***" : value,
    ]),
  );
}
