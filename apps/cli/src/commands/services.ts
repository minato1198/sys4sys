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
import { CliError, UsageError } from "../errors.js";
import { printJson, printTable, redactEnvFields, shortId } from "../output.js";
import type { Action, DeployConfig, Host, Service } from "../types.js";

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
}

interface DeployResult {
  action: Action;
  service: Service;
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
    printJson(redactEnvFields(service, options.showEnv));
    return;
  }

  console.log(`ID:      ${service.id}`);
  console.log(`Name:    ${service.name}`);
  console.log(`Host:    ${service.host?.name ?? service.hostId}`);
  console.log(`Status:  ${service.status}`);
  console.log(`Health:  ${service.health?.status ?? "unknown"}`);
  console.log(`PID:     ${service.pid ?? "-"}`);
  console.log(`Command: ${service.command.join(" ")}`);
  console.log(`CWD:     ${service.cwd ?? "-"}`);
  console.log(
    `Ports:   ${service.expectedPorts.length > 0 ? service.expectedPorts.join(", ") : "-"}`,
  );
  if (options.showEnv) {
    console.log(`Env:     ${service.env ? JSON.stringify(service.env) : "-"}`);
  }
  console.log(`Deploy:  ${service.deploy ? "configured" : "not configured"}`);
  if (service.deploy) {
    console.log(`  command: ${service.deploy.command.join(" ")}`);
    console.log(`  cwd:     ${service.deploy.cwd ?? "-"}`);
    console.log(`  timeout: ${service.deploy.timeoutSec}s`);
    console.log(`  restart: ${service.deploy.restartAfter ? "yes" : "no"}`);
    console.log(`  health:  ${service.deploy.healthTimeoutSec}s`);
    if (options.showEnv) {
      console.log(
        `  env:     ${service.deploy.env ? JSON.stringify(service.deploy.env) : "-"}`,
      );
    }
  }
  console.log(`Last deploy: ${service.lastDeployStatus ?? "-"}`);
  if (service.lastDeployError) {
    console.log(`Deploy error: ${service.lastDeployError}`);
  }
}

function printServiceList(services: Service[]): void {
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
  );
}

function printDeployPlan(
  service: Service,
  deploy: DeployConfig,
  showEnv: boolean,
): void {
  console.log(`Service: ${service.name} (${service.id})`);
  console.log(`Command: ${deploy.command.join(" ")}`);
  console.log(`CWD:     ${deploy.cwd ?? "-"}`);
  console.log(`Timeout: ${deploy.timeoutSec}s`);
  console.log(`Restart: ${deploy.restartAfter ? "yes" : "no"}`);
  console.log(`Health:  ${deploy.healthTimeoutSec}s`);
  if (showEnv) {
    console.log(`Env:     ${deploy.env ? JSON.stringify(deploy.env) : "-"}`);
  }
}

function printAction(action: Action): void {
  console.log(`Action:  ${action.id}`);
  console.log(`Type:    ${action.type}`);
  console.log(`Status:  ${action.status}`);
  if (action.error) console.log(`Error:   ${action.error}`);
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
    printJson(redactEnvFields(services, options.showEnv));
    return;
  }
  printServiceList(services);
}

export async function getService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "services get");
  const service = await fetchService(client, id);
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
      printJson(redactEnvFields(preview, options.showEnv));
    } else {
      console.log(
        "dry-run: 入力スキーマと hostId を確認しました（command allowlist は API 実行時に検証されます）。",
      );
      console.log(
        JSON.stringify(redactEnvFields(input, options.showEnv), null, 2),
      );
    }
    return;
  }

  const created = await client.request<Service>("POST", "/api/services", input);
  if (options.json) {
    printJson(redactEnvFields(created, options.showEnv));
  } else {
    console.log("service created.");
    printService(created, options);
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
      printJson(redactEnvFields(preview, options.showEnv));
    } else {
      console.log(
        "dry-run: 更新内容のスキーマとサービスIDを確認しました（command allowlist は API 実行時に検証されます）。",
      );
      console.log(
        JSON.stringify(redactEnvFields(patch, options.showEnv), null, 2),
      );
    }
    return;
  }

  const updated = await client.request<Service>(
    "PATCH",
    `/api/services/${encodeURIComponent(id)}`,
    patch,
  );
  if (options.json) {
    printJson(redactEnvFields(updated, options.showEnv));
  } else {
    console.log("service updated.");
    printService(updated, options);
  }
}

export async function deployService(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<number> {
  const id = requireId(positionals, "services deploy");
  const service = await fetchService(client, id);
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
      );
    } else {
      console.log(
        "dry-run: deploy は実行しません（command allowlist は API 実行時に検証されます）。",
      );
      printDeployPlan(service, deploy, options.showEnv);
    }
    return 0;
  }

  const timeoutSec = parseTimeout(options.timeout, deploy);
  await confirmDeploy(service, deploy, options.yes, options.json);

  const action = await client.request<Action>(
    "POST",
    `/api/services/${encodeURIComponent(id)}/deploy`,
  );

  if (!options.wait) {
    if (options.json) {
      printJson(action);
    } else {
      printAction(action);
    }
    return action.status === "failed" ? 5 : 0;
  }

  const result = await waitForDeploy(client, id, action, timeoutSec);
  const exitCode = result.action.status === "succeeded" ? 0 : 5;

  if (options.json) {
    printJson({
      action: result.action,
      service: redactEnvFields(result.service, options.showEnv),
    });
    return exitCode;
  }

  printAction(result.action);
  console.log("");
  printService(result.service, { ...options, json: false });
  return exitCode;
}
