import { hostCreateSchema, hostUpdateSchema } from "@sys4sys/shared";
import { ZodError } from "zod";
import type { ApiClient } from "../client.js";
import { UsageError } from "../errors.js";
import { printJson, printTable, shortId, writeOut } from "../output.js";
import { confirmNonInteractive, type CommandOptions } from "./services.js";
import type { Host } from "../types.js";

interface WslDetection {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
  registered: boolean;
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

function requireId(positionals: string[], command: string): string {
  const id = positionals[0]?.trim();
  if (!id) throw new UsageError(`${command} にはホストIDが必要です。`);
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} にはホストID以外の引数を指定できません: ${positionals
        .slice(1)
        .join(" ")}`,
    );
  }
  return id;
}

function printHost(host: Host, options: CommandOptions): void {
  if (options.json) {
    printJson(host, options.output);
    return;
  }
  out(options, `ID:     ${host.id}\n`);
  out(options, `Kind:   ${host.kind}\n`);
  out(options, `Name:   ${host.name}\n`);
  out(options, `Distro: ${host.distro ?? "-"}\n`);
  out(options, `User:   ${host.defaultUser ?? "-"}\n`);
  out(options, `State:  ${host.state ?? "unknown"}\n`);
  out(options, `Enabled:${host.enabled ? "yes" : "no"}\n`);
}

export async function listHosts(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const hosts = await client.request<Host[]>("GET", "/api/hosts");

  if (options.json) {
    printJson(hosts, options.output);
    return;
  }

  printTable(
    ["ID", "KIND", "NAME", "STATE", "DISTRO"],
    hosts.map((host) => [
      shortId(host.id),
      host.kind,
      host.name,
      host.state ?? "-",
      host.distro ?? "-",
    ]),
    options.output,
  );
}

export async function getHost(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "hosts get");
  const host = await client.request<Host>(
    "GET",
    `/api/hosts/${encodeURIComponent(id)}`,
  );
  printHost(host, options);
}

export async function detectHosts(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  const distros = await client.request<WslDetection[]>(
    "POST",
    "/api/hosts/wsl/detect",
  );

  if (options.json) {
    printJson(distros, options.output);
    return;
  }

  printTable(
    ["DISTRO", "STATE", "VERSION", "DEFAULT", "REGISTERED"],
    distros.map((distro) => [
      distro.name,
      distro.state,
      String(distro.version),
      distro.isDefault ? "yes" : "no",
      distro.registered ? "yes" : "no",
    ]),
    options.output,
  );
}

export async function createHost(
  client: ApiClient,
  options: CommandOptions,
): Promise<void> {
  if (!options.kind) {
    throw new UsageError("hosts create には --kind が必要です。");
  }
  if (!options.name) {
    throw new UsageError("hosts create には --name が必要です。");
  }

  let input;
  try {
    input = hostCreateSchema.parse({
      kind: options.kind,
      name: options.name,
      distro: options.distro,
      defaultUser: options.user,
      enabled: !options.disabled,
    });
  } catch (error) {
    throw zodUsage(error);
  }

  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: hosts は作成しません。\n");
    }
    printJson({ dryRun: true, host: input }, options.output);
    return;
  }

  const created = await client.request<Host>("POST", "/api/hosts", input);
  if (options.json) {
    printJson(created, options.output);
  } else {
    out(options, "host created.\n");
    printHost(created, options);
  }
}

export async function updateHost(
  client: ApiClient,
  positionals: string[],
  options: CommandOptions,
): Promise<void> {
  const id = requireId(positionals, "hosts update");
  if (options.enable && options.disable) {
    throw new UsageError("--enable と --disable は同時に指定できません。");
  }

  const patch = {
    ...(options.name ? { name: options.name } : {}),
    ...(options.user ? { defaultUser: options.user } : {}),
    ...(options.enable ? { enabled: true } : {}),
    ...(options.disable ? { enabled: false } : {}),
  };

  if (Object.keys(patch).length === 0) {
    throw new UsageError(
      "更新する項目がありません。--name / --user / --enable / --disable を指定してください。",
    );
  }

  let body;
  try {
    body = hostUpdateSchema.parse(patch);
  } catch (error) {
    throw zodUsage(error);
  }

  if (options.dryRun) {
    if (!options.json) {
      out(options, "dry-run: hosts は更新しません。\n");
    }
    printJson({ dryRun: true, hostId: id, patch: body }, options.output);
    return;
  }

  if (options.disable) {
    await confirmNonInteractive(
      `host ${id} の disable（サービス停止につながる）`,
      options,
    );
  }

  const updated = await client.request<Host>(
    "PATCH",
    `/api/hosts/${encodeURIComponent(id)}`,
    body,
  );
  if (options.json) {
    printJson(updated, options.output);
  } else {
    out(options, "host updated.\n");
    printHost(updated, options);
  }
}
