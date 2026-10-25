import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  serviceCreateSchema,
  serviceListQuerySchema,
  serviceUpdateSchema,
  type ServiceCreateInput,
  type ServiceListQuery,
  type ServiceUpdateInput,
} from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { ApiError } from "../client.js";
import { AuthError, CliError, UsageError } from "../errors.js";
import {
  printJson,
  printTable,
  redactEnvFields,
  shortId,
  writeErr,
  writeOut,
  type CliOutput,
} from "../output.js";
import type {
  Action,
  DeployConfig,
  Host,
  Service,
  ServiceSecrets,
} from "../types.js";

export interface CommandOptions {
  json: boolean;
  showEnv: boolean;
  dryRun: boolean;
  yes: boolean;
  wait: boolean;
  file?: string;
  host?: string;
  status?: string;
  timeout?: string;
  limit?: string;
  cursor?: string;
  service?: string;
  level?: string;
  grep?: string;
  since?: string;
  until?: string;
  noTruncate?: boolean;
  noReconnect?: boolean;
  md?: boolean;
  email?: string;
  passwordStdin?: boolean;
  revokeToken?: boolean;
  user?: string;
  name?: string;
  scope?: string[];
  expiresIn?: string;
  save?: boolean;
  severity?: string;
  offset?: string;
  note?: string;
  full?: boolean;
  kind?: string;
  distro?: string;
  disabled?: boolean;
  enable?: boolean;
  disable?: boolean;
  portScope?: string;
  protocol?: string;
  port?: string;
  reservations?: boolean;
  pid?: string;
  pidScope?: string;
  killSignal?: string;
  force?: boolean;
  format?: string;
  outputPath?: string;
  request?: boolean;
  action?: string;
  target?: string;
  actor?: string;
  incident?: string;
  signal?: AbortSignal;
  output?: CliOutput;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
}

function out(options: CommandOptions, text: string): void {
  void writeOut(options.output, text);
}

function err(options: CommandOptions, text: string): void {
  writeErr(options.output, text);
}

interface DeployResult {
  action: Action;
  service: Service;
}

interface ActionPage {
  items: Action[];
  nextCursor: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  return new UsageError(`入力が不正です: ${errorMessage(error)}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text =
      path === "-" ? await readStdin() : await readFile(resolve(path), "utf8");
  } catch (error) {
    throw new UsageError(
      `ファイルを読み込めません (${path}): ${errorMessage(error)}`,
    );
  }

  try {
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new UsageError(
      `JSON を解析できません (${path}): ${errorMessage(error)}`,
    );
  }
}

function parseCreateInput(value: unknown): ServiceCreateInput {
  try {
    return serviceCreateSchema.parse(value);
  } catch (error) {
    throw zodToUsage(error);
  }
}

function parseUpdateInput(value: unknown): ServiceUpdateInput {
  try {
    return serviceUpdateSchema.parse(value);
  } catch (error) {
    throw zodToUsage(error);
  }
}

function parseListQuery(value: unknown): ServiceListQuery {
  try {
    return serviceListQuerySchema.parse(value);
  } catch (error) {
    throw zodToUsage(error);
  }
}

async function assertHostExists(
  client: ApiClient,
  hostId: string,
): Promise<void> {
  const hosts = await client.request<Host[]>("GET", "/api/hosts");
  if (!hosts.some((host) => host.id === hostId)) {
    throw new UsageError(`hostId が見つかりません: ${hostId}`);
  }
}

async function fetchService(client: ApiClient, id: string): Promise<Service> {
  return client.request<Service>(
    "GET",
    `/api/services/${encodeURIComponent(id)}`,
  );
}

async function fetchServiceSecrets(
  client: ApiClient,
  id: string,
): Promise<ServiceSecrets> {
  try {
    return await client.request<ServiceSecrets>(
      "GET",
      `/api/services/${encodeURIComponent(id)}/secrets`,
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      throw new AuthError(
        "--show-env には admin 権限と services:secrets スコープが必要です",
      );
    }
    throw error;
  }
}

async function withServiceEnv(
  client: ApiClient,
  service: Service,
  options: CommandOptions,
): Promise<Service> {
  if (!options.showEnv) return service;

  err(
    options,
    "警告: --show-env は secrets API 経由で平文 env を表示します。表示は監査ログに記録されます。\n",
  );
  const secrets = await fetchServiceSecrets(client, service.id);
  return {
    ...service,
    env: secrets.env,
    envKeys: secrets.env ? Object.keys(secrets.env) : [],
    deploy: service.deploy
      ? {
          ...service.deploy,
          env: secrets.deployEnv,
          envKeys: secrets.deployEnv ? Object.keys(secrets.deployEnv) : [],
        }
      : null,
  };
}

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} にはサービスIDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} にはサービスID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function printService(service: Service, options: CommandOptions): void {
  if (options.json) {
    printJson(redactEnvFields(service, options.showEnv), options.output);
    return;
  }

  out(options, `ID:      ${service.id}\n`);
  out(options, `Name:    ${service.name}\n`);
  out(options, `Host:    ${service.host?.name ?? service.hostId}\n`);
  out(options, `Status:  ${service.status}\n`);
  out(options, `Health:  ${service.health?.status ?? "unknown"}\n`);
  out(options, `PID:     ${service.pid ?? "-"}\n`);
  out(options, `Command: ${service.command.join(" ")}\n`);
  out(options, `CWD:     ${service.cwd ?? "-"}\n`);
  out(
    options,
    `Ports:   ${service.expectedPorts.length > 0 ? service.expectedPorts.join(", ") : "-"}\n`,
  );
  if (options.showEnv) {
    out(
      options,
      `Env:     ${service.env ? JSON.stringify(service.env) : "-"}\n`,
    );
  }
  out(
    options,
    `Deploy:  ${service.deploy ? "configured" : "not configured"}\n`,
  );
  if (service.deploy) {
    out(options, `  command: ${service.deploy.command.join(" ")}\n`);
    out(options, `  cwd:     ${service.deploy.cwd ?? "-"}\n`);
    out(options, `  timeout: ${service.deploy.timeoutSec}s\n`);
    out(options, `  restart: ${service.deploy.restartAfter ? "yes" : "no"}\n`);
    out(options, `  health:  ${service.deploy.healthTimeoutSec}s\n`);
    if (options.showEnv) {
      out(
        options,
        `  env:     ${service.deploy.env ? JSON.stringify(service.deploy.env) : "-"}\n`,
      );
    }
  }
  out(options, `Last deploy: ${service.lastDeployStatus ?? "-"}\n`);
  if (service.lastDeployError) {
    out(options, `Deploy error: ${service.lastDeployError}\n`);
  }
}

function printServiceList(services: Service[], options: CommandOptions): void {
  printTable(
    ["ID", "NAME", "STATUS", "HEALTH", "HOST", "PORTS", "DEPLOY"],
    services.map((service) => [
      shortId(service.id),
      service.name,
      service.status,
      service.health?.status ?? "unknown",
      service.host?.name ?? service.hostId,
      service.expectedPorts.length > 0 ? service.expectedPorts.join(",") : "-",
      service.deploy ? "yes" : "-",
    ]),
    options.output,
  );
}

function printDeployPlan(
  service: Service,
  deploy: DeployConfig,
  options: CommandOptions,
): void {
  out(options, `Service: ${service.name} (${service.id})\n`);
  out(options, `Command: ${deploy.command.join(" ")}\n`);
  out(options, `CWD:     ${deploy.cwd ?? "-"}\n`);
  out(options, `Timeout: ${deploy.timeoutSec}s\n`);
  out(options, `Restart: ${deploy.restartAfter ? "yes" : "no"}\n`);
  out(options, `Health:  ${deploy.healthTimeoutSec}s\n`);
  if (options.showEnv) {
    out(options, `Env:     ${deploy.env ? JSON.stringify(deploy.env) : "-"}\n`);
  }
}

function printAction(action: Action, options: CommandOptions): void {
  out(options, `Action:  ${action.id}\n`);
  out(options, `Type:    ${action.type}\n`);
  out(options, `Status:  ${action.status}\n`);
  if (action.error) out(options, `Error:   ${action.error}\n`);
}

async function confirmDeploy(
  service: Service,
  deploy: DeployConfig,
  yes: boolean,
  json: boolean,
): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) {
    throw new UsageError(
      "非対話環境で deploy を実行するには --yes を指定してください。",
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      `deploy ${service.name} (${deploy.command.join(" ")}) を実行しますか? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError("deploy をキャンセルしました。", 1);
    }
  } finally {
    rl.close();
  }
  if (json) {
    process.stderr.write("deploy を開始します。\n");
  }
}

function parseTimeout(value: string | undefined, deploy: DeployConfig): number {
  if (value !== undefined) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new UsageError(
        "--timeout は 1 以上の整数（秒）で指定してください。",
      );
    }
    return parsed;
  }
  return deploy.timeoutSec + deploy.healthTimeoutSec + 30;
}

async function waitForDeploy(
  client: ApiClient,
  serviceId: string,
  action: Action,
  timeoutSec: number,
): Promise<DeployResult> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = action.status;

  while (Date.now() < deadline) {
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));

    const service = await fetchService(client, serviceId);
    const current = service.recentActions?.find(
      (candidate) => candidate.id === action.id,
    );

    if (current) {
      lastStatus = current.status;
      if (current.status === "succeeded" || current.status === "failed") {
        return { action: current, service };
      }
      continue;
    }

    const deployFinishedAfterStart =
      service.lastDeployAt !== null &&
      action.startedAt !== null &&
      new Date(service.lastDeployAt).getTime() >=
        new Date(action.startedAt).getTime();

    if (
      deployFinishedAfterStart &&
      (service.lastDeployStatus === "succeeded" ||
        service.lastDeployStatus === "failed")
    ) {
      return {
        action: {
          ...action,
          status: service.lastDeployStatus,
          finishedAt: service.lastDeployAt,
          error: service.lastDeployError,
        },
        service,
      };
    }
  }

  throw new CliError(
    `deploy がタイムアウトしました (action=${action.id}, last=${lastStatus})`,
    5,
  );
}

export async function listServices(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const filter = parseListQuery({
    hostId: options.host,
    status: options.status,
  });
  const params = new URLSearchParams();
  if (filter.hostId) params.set("hostId", filter.hostId);
  if (filter.status) params.set("status", filter.status);
  const query = params.toString();
  const services = await client.request<Service[]>(
    "GET",
    query ? `/api/services?${query}` : "/api/services",
  );

  if (options.json) {
    if (options.showEnv) {
      err(
        options,
        "警告: services list は env 値を表示しません。平文 env は services get --show-env でのみ参照できます。\n",
      );
    }
    printJson(redactEnvFields(services, false), options.output);
    return;
  }
  printServiceList(services, options);
}

export async function getService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "services get");
  let service = await fetchService(client, id);
  service = await withServiceEnv(client, service, options);
  printService(service, options);
}

export async function createService(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  if (!options.file) {
    throw new UsageError("services create には --file が必要です。");
  }

  const input = parseCreateInput(await readJsonFile(options.file));
  await assertHostExists(client, input.hostId);

  if (options.dryRun) {
    const preview = { dryRun: true, service: input };
    if (options.json) {
      printJson(redactEnvFields(preview, options.showEnv), options.output);
    } else {
      out(
        options,
        "dry-run: 入力スキーマと hostId を確認しました（command allowlist は API 実行時に検証されます）。\n",
      );
      out(
        options,
        `${JSON.stringify(redactEnvFields(input, options.showEnv), null, 2)}\n`,
      );
    }
    return;
  }

  const created = await client.request<Service>("POST", "/api/services", input);
  const revealed = await withServiceEnv(client, created, options);
  if (options.json) {
    printJson(redactEnvFields(revealed, options.showEnv), options.output);
  } else {
    out(options, "service created.\n");
    printService(revealed, options);
  }
}

export async function updateService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "services update");
  if (!options.file) {
    throw new UsageError("services update には --file が必要です。");
  }

  const patch = parseUpdateInput(await readJsonFile(options.file));
  if (Object.keys(patch).length === 0) {
    throw new UsageError("更新する項目がありません。");
  }

  await fetchService(client, id);

  if (options.dryRun) {
    const preview = { dryRun: true, serviceId: id, patch };
    if (options.json) {
      printJson(redactEnvFields(preview, options.showEnv), options.output);
    } else {
      out(
        options,
        "dry-run: 更新内容のスキーマとサービスIDを確認しました（command allowlist は API 実行時に検証されます）。\n",
      );
      out(
        options,
        `${JSON.stringify(redactEnvFields(patch, options.showEnv), null, 2)}\n`,
      );
    }
    return;
  }

  const updated = await client.request<Service>(
    "PATCH",
    `/api/services/${encodeURIComponent(id)}`,
    patch,
  );
  const revealed = await withServiceEnv(client, updated, options);
  if (options.json) {
    printJson(redactEnvFields(revealed, options.showEnv), options.output);
  } else {
    out(options, "service updated.\n");
    printService(revealed, options);
  }
}

export async function deployService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "services deploy");
  let service = await fetchService(client, id);
  if (options.dryRun) {
    service = await withServiceEnv(client, service, options);
  }
  if (!service.deploy) {
    throw new UsageError(`deploy 設定がありません: ${id}`);
  }

  const deploy = service.deploy;
  if (options.dryRun) {
    if (options.json) {
      printJson(
        redactEnvFields(
          {
            dryRun: true,
            service: {
              id: service.id,
              name: service.name,
              status: service.status,
            },
            deploy,
          },
          options.showEnv,
        ),
        options.output,
      );
    } else {
      out(
        options,
        "dry-run: deploy は実行しません（command allowlist は API 実行時に検証されます）。\n",
      );
      printDeployPlan(service, deploy, options);
    }
    return 0;
  }

  const timeoutSec = parseTimeout(options.timeout, deploy);

  if (options.request) {
    const { createDeployRequest } = await import("./deploy-requests.js");
    const request = await createDeployRequest(client, id, options);
    if (options.json) {
      printJson(request, options.output);
    } else {
      out(options, `deploy request created: ${request.id}\n`);
      out(options, `Status:  ${request.status}\n`);
      out(options, `Expires: ${request.expiresAt}\n`);
      out(
        options,
        "承認後は `sys4sys deploy-requests approve <id> --yes` を実行してください。\n",
      );
    }
    return 0;
  }

  await confirmDeploy(service, deploy, options.yes, options.json);

  let action: Action;
  try {
    action = await client.request<Action>(
      "POST",
      `/api/services/${encodeURIComponent(id)}/deploy`,
    );
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 409 &&
      (error.problem?.detail === "approval_required" ||
        error.detail.includes("approval_required"))
    ) {
      const requestId =
        error.problem && "deployRequestId" in error.problem
          ? String(error.problem.deployRequestId)
          : null;
      throw new CliError(
        `デプロイには承認が必要です。${
          requestId ? ` 既存の承認待ち: ${requestId}。` : ""
        } \`sys4sys services deploy ${id} --request\` で承認要求を作成してください。`,
        4,
      );
    }
    throw error;
  }

  if (!options.wait) {
    if (options.json) {
      printJson(action, options.output);
    } else {
      printAction(action, options);
    }
    return action.status === "failed" ? 5 : 0;
  }

  const result = await waitForDeploy(client, id, action, timeoutSec);
  const exitCode = result.action.status === "succeeded" ? 0 : 5;
  const revealed = await withServiceEnv(client, result.service, options);

  if (options.json) {
    printJson(
      {
        action: result.action,
        service: redactEnvFields(revealed, options.showEnv),
      },
      options.output,
    );
    return exitCode;
  }

  printAction(result.action, options);
  out(options, "\n");
  printService(revealed, { ...options, json: false });
  return exitCode;
}

function parseWaitTimeout(value: string | undefined, defaultSec = 60): number {
  if (value === undefined) return defaultSec;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError("--timeout は 1 以上の整数（秒）で指定してください。");
  }
  return parsed;
}

async function confirmLifecycleAction(
  service: Service,
  verb: string,
  options: CommandOptions,
): Promise<void> {
  if (options.yes) return;
  if (options.json || !process.stdin.isTTY) {
    throw new UsageError(
      `非対話環境で ${verb} を実行するには --yes を指定してください。`,
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      `service ${service.name} (${service.id}) を${verb}します。よろしいですか? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError(`${verb} をキャンセルしました。`, 1);
    }
  } finally {
    rl.close();
  }
}

function printLifecyclePlan(
  service: Service,
  verb: string,
  dryRun: boolean,
  options: CommandOptions,
): void {
  out(options, `Service: ${service.name} (${service.id})\n`);
  out(options, `Status:  ${service.status}\n`);
  out(options, `Action:  ${verb}\n`);
  if (dryRun) {
    out(options, "dry-run: API は変更しません。\n");
    if (verb === "delete" && isRunningStatus(service.status)) {
      out(
        options,
        "注意: 実行中のため、実際の削除は API が 409 Conflict を返します。\n",
      );
    }
  }
}

function isRunningStatus(status: string): boolean {
  return ["starting", "running", "degraded", "restarting"].includes(status);
}

async function waitForAction(
  client: ApiClient,
  serviceId: string,
  action: Action,
  timeoutSec: number,
): Promise<Action> {
  if (action.status === "succeeded" || action.status === "failed") {
    return action;
  }

  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = action.status;
  while (Date.now() < deadline) {
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    const page = await client.request<ActionPage>(
      "GET",
      `/api/services/${encodeURIComponent(serviceId)}/actions?limit=50`,
    );
    const current = page.items.find((candidate) => candidate.id === action.id);
    if (current) {
      lastStatus = current.status;
      if (current.status === "succeeded" || current.status === "failed") {
        return current;
      }
    }
  }

  throw new CliError(
    `アクションがタイムアウトしました (action=${action.id}, last=${lastStatus})`,
    5,
  );
}

function printLifecycleResult(
  action: Action,
  service: Service,
  options: CommandOptions,
): number {
  const exitCode = action.status === "failed" ? 5 : 0;
  if (options.json) {
    printJson(
      { action, service: redactEnvFields(service, options.showEnv) },
      options.output,
    );
    return exitCode;
  }
  printAction(action, options);
  out(options, `Service status: ${service.status}\n`);
  return exitCode;
}

async function runAction(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
  verb: "start" | "stop" | "restart",
): Promise<number> {
  const id = requireId(positionals, `services ${verb}`);
  const service = await fetchService(client, id);

  if (options.dryRun) {
    if (options.json) {
      printJson(
        {
          dryRun: true,
          action: verb,
          service: {
            id: service.id,
            name: service.name,
            status: service.status,
          },
        },
        options.output,
      );
    } else {
      printLifecyclePlan(service, verb, true, options);
    }
    return 0;
  }

  if (verb !== "start") {
    await confirmLifecycleAction(service, verb, options);
  }

  const action = await client.request<Action>(
    "POST",
    `/api/services/${encodeURIComponent(id)}/${verb}`,
  );

  if (!options.wait) {
    if (options.json) printJson(action, options.output);
    else printAction(action, options);
    return action.status === "failed" ? 5 : 0;
  }

  const timeoutSec = parseWaitTimeout(options.timeout);
  const finished = await waitForAction(client, id, action, timeoutSec);
  const updated = await fetchService(client, id);
  const revealed = await withServiceEnv(client, updated, options);
  return printLifecycleResult(finished, revealed, options);
}

async function deleteService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "services delete");
  const service = await fetchService(client, id);

  if (options.dryRun) {
    if (options.json) {
      printJson(
        {
          dryRun: true,
          action: "delete",
          service: {
            id: service.id,
            name: service.name,
            status: service.status,
          },
        },
        options.output,
      );
    } else {
      printLifecyclePlan(service, "delete", true, options);
    }
    return 0;
  }

  await confirmLifecycleAction(service, "delete", options);
  await client.request<void>(
    "DELETE",
    `/api/services/${encodeURIComponent(id)}`,
  );

  if (options.json) {
    printJson({ deleted: true, id }, options.output);
  } else {
    out(options, `service deleted: ${id}\n`);
  }
  return 0;
}

async function listServiceActions(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "services actions");
  const limit = parseLimit(options.limit, 50, 200);
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.cursor) params.set("cursor", options.cursor);

  const page = await client.request<ActionPage>(
    "GET",
    `/api/services/${encodeURIComponent(id)}/actions?${params.toString()}`,
  );

  if (options.json) {
    printJson(page, options.output);
    return 0;
  }

  if (page.items.length === 0) {
    out(options, "アクション履歴はありません。\n");
    return 0;
  }

  printTable(
    ["ID", "TYPE", "STATUS", "STARTED", "FINISHED", "ERROR"],
    page.items.map((action) => [
      shortId(action.id),
      action.type,
      action.status,
      action.startedAt ?? "-",
      action.finishedAt ?? "-",
      action.error ?? "-",
    ]),
    options.output,
  );
  if (page.nextCursor) {
    err(options, `next: --cursor ${page.nextCursor}\n`);
  }
  return 0;
}

export function parseLimit(
  value: string | undefined,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new UsageError(`--limit は 1〜${maximum} の整数で指定してください。`);
  }
  return parsed;
}

export function parseOffset(
  value: string | undefined,
  maximum = 100_000,
): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new UsageError(
      `--offset は 0〜${maximum} の整数で指定してください。`,
    );
  }
  return parsed;
}

export async function confirmNonInteractive(
  label: string,
  options: CommandOptions,
  prompt?: string,
): Promise<void> {
  if (options.yes) return;
  if (options.json || !process.stdin.isTTY) {
    throw new UsageError(
      `非対話環境で ${label} を実行するには --yes を指定してください。`,
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      prompt ?? `${label} を実行しますか? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError(`${label} をキャンセルしました。`, 1);
    }
  } finally {
    rl.close();
  }
}

export async function runServiceLifecycle(
  verb: "start" | "stop" | "restart" | "delete" | "actions",
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  switch (verb) {
    case "start":
    case "stop":
    case "restart":
      return runAction(client, positionals, options, verb);
    case "delete":
      return deleteService(client, positionals, options);
    case "actions":
      return listServiceActions(client, positionals, options);
  }
}
