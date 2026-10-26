import { ZodError } from "zod";
import { parseCliArgs } from "./args.js";
import { createCredentialStore, resolveCredentials } from "./auth/store.js";
import { ApiClient, ApiError } from "./client.js";
import { authLogin, authLogout, authStatus, whoami } from "./commands/auth.js";
import * as approvalsCmd from "./commands/approvals.js";
import * as auditCmd from "./commands/audit.js";
import * as deployRequestsCmd from "./commands/deploy-requests.js";
import * as hostsCmd from "./commands/hosts.js";
import * as incidentsCmd from "./commands/incidents.js";
import * as portsCmd from "./commands/ports.js";
import * as reportsCmd from "./commands/reports.js";
import * as settingsCmd from "./commands/settings.js";
import {
  createService as createServiceCommand,
  deployService,
  getService,
  listServices,
  updateService,
  type CommandOptions,
} from "./commands/services.js";
import { CliError, UsageError } from "./errors.js";
import { printHelp } from "./help.js";
import { printError, printJson, writeOut, type CliOutput } from "./output.js";
import { CLI_VERSION, versionInfo } from "./version.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return 3;
    if (error.status === 409) return 4;
    if (error.status === 422) return 2;
    return 1;
  }
  if (error instanceof ZodError) return 2;
  if (error instanceof CliError) return error.exitCode;
  return 1;
}

export function printFailure(
  error: unknown,
  json: boolean,
  output?: CliOutput,
): void {
  if (error instanceof ApiError) {
    const scope = error.problem?.requiredScope;
    const suffix = scope ? ` (required scope: ${scope})` : "";
    printError(
      `${error.status} ${error.title}: ${error.detail}${suffix}`,
      json,
      {
        status: error.status,
        title: error.title,
        detail: error.detail,
        requiredScope: scope,
        errors: error.problem?.errors,
      },
      output,
    );
    return;
  }

  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    printError(`入力が不正です: ${details}`, json, undefined, output);
    return;
  }

  if (error instanceof UsageError && error.details) {
    printError(error.message, json, error.details, output);
    return;
  }

  if (error instanceof CliError) {
    printError(error.message, json, undefined, output);
    return;
  }

  printError(
    `予期しないエラー: ${errorMessage(error)}`,
    json,
    undefined,
    output,
  );
}

function expectNoExtraPositionals(
  positionals: string[],
  command: string,
): void {
  if (positionals.length > 0) {
    throw new UsageError(
      `${command} に不要な引数があります: ${positionals.join(" ")}`,
    );
  }
}

async function authedClient(
  parsed: ReturnType<typeof parseCliArgs>,
): Promise<ApiClient> {
  const resolved = await resolveCredentials({
    apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
  });
  if (resolved.source === "none") {
    throw new CliError(
      "認証情報がありません。`sys4sys auth login` を実行してください。",
      3,
    );
  }
  return clientFor(resolved);
}

export async function main(
  argv: string[],
  cliOutput?: CliOutput,
): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (parsed.values.version) {
    await writeOut(cliOutput, `${CLI_VERSION}\n`);
    return 0;
  }

  if (
    parsed.values.help ||
    parsed.positionals.length === 0 ||
    parsed.positionals[0] === "help"
  ) {
    const target =
      parsed.positionals[0] === "help"
        ? parsed.positionals.slice(1).join(" ")
        : undefined;
    printHelp(target || undefined);
    return 0;
  }

  const [group, sub, ...rest] = parsed.positionals;
  if (!group) {
    printHelp();
    return 0;
  }

  const options: CommandOptions = {
    json: Boolean(parsed.values.json),
    showEnv: Boolean(parsed.values["show-env"]),
    dryRun: Boolean(parsed.values["dry-run"]),
    yes: Boolean(parsed.values.yes),
    wait: Boolean(parsed.values.wait),
    file: parsed.values.file,
    host: parsed.values.host,
    status: parsed.values.status,
    timeout: parsed.values.timeout,
    limit: parsed.values.limit,
    cursor: parsed.values.cursor,
    service: parsed.values.service,
    level: parsed.values.level,
    grep: parsed.values.grep,
    since: parsed.values.since,
    until: parsed.values.until,
    noTruncate: Boolean(parsed.values["no-truncate"]),
    noReconnect: Boolean(parsed.values["no-reconnect"]),
    md: Boolean(parsed.values.md),
    email: parsed.values.email,
    passwordStdin: Boolean(parsed.values["password-stdin"]),
    revokeToken: Boolean(parsed.values["revoke-token"]),
    user: parsed.values.user,
    name: parsed.values.name,
    scope: parsed.values.scope,
    expiresIn: parsed.values["expires-in"],
    save: Boolean(parsed.values.save),
    severity: parsed.values.severity,
    offset: parsed.values.offset,
    note: parsed.values.note,
    full: Boolean(parsed.values.full),
    kind: parsed.values.kind,
    distro: parsed.values.distro,
    disabled: Boolean(parsed.values.disabled),
    enable: Boolean(parsed.values.enable),
    disable: Boolean(parsed.values.disable),
    portScope: parsed.values.scope?.[0],
    protocol: parsed.values.protocol,
    port: parsed.values.port,
    reservations: Boolean(parsed.values.reservations),
    pid: parsed.values.pid,
    pidScope: parsed.values["pid-scope"],
    killSignal: parsed.values.signal,
    force: Boolean(parsed.values.force),
    format: parsed.values.format,
    outputPath: parsed.values.output,
    request: Boolean(parsed.values.request),
    action: parsed.values.action,
    target: parsed.values.target,
    actor: parsed.values.actor,
    incident: parsed.values.incident,
    output: cliOutput,
  };

  if (group === "version") {
    expectNoExtraPositionals(
      [sub, ...rest].filter(Boolean) as string[],
      "version",
    );
    if (options.json) {
      printJson(versionInfo(), options.output);
    } else {
      await writeOut(options.output, `${CLI_VERSION}\n`);
    }
    return 0;
  }

  if (group === "doctor") {
    expectNoExtraPositionals(
      [sub, ...rest].filter(Boolean) as string[],
      "doctor",
    );
    const { runDoctor } = await import("./commands/doctor.js");
    return await runDoctor({
      json: options.json,
      strict: Boolean(parsed.values.strict),
      output: options.output,
      env: process.env,
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    });
  }

  if (group === "completions") {
    const shell = sub?.trim();
    if (!shell) {
      throw new UsageError(
        "completions には bash / zsh / fish / powershell のいずれかを指定してください。",
      );
    }
    expectNoExtraPositionals(rest, "completions");
    const { completionScript } = await import("./commands/completions.js");
    await writeOut(options.output, completionScript(shell));
    return 0;
  }

  if (group === "mcp") {
    if (sub !== "serve") {
      throw new UsageError("mcp のサブコマンドは serve のみです。");
    }
    expectNoExtraPositionals(rest, "mcp serve");
    const { runMcpCommand } = await import("./commands/mcp.js");
    return await runMcpCommand({
      transport: parsed.values.transport,
      allowWrite: Boolean(parsed.values["allow-write"]),
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
      env: process.env,
    });
  }

  if (group === "schema") {
    const { printSchema } = await import("./commands/schema.js");
    const target = [sub, ...rest].filter(Boolean).join(" ");
    const text = printSchema(target || undefined, options);
    await writeOut(options.output, text);
    return 0;
  }

  if (group === "auth") {
    const store = createCredentialStore();
    const explicitApiUrl = parsed.values.api ?? process.env.SYS4SYS_API_URL;

    if (sub === "login") {
      expectNoExtraPositionals(rest, "auth login");
      const client = new ApiClient({ apiUrl: explicitApiUrl });
      await authLogin(client, {
        email: options.email,
        passwordStdin: Boolean(options.passwordStdin),
        json: options.json,
        store,
        output: options.output,
      });
      return 0;
    }

    if (sub === "logout") {
      expectNoExtraPositionals(rest, "auth logout");
      await authLogout({
        apiUrl: explicitApiUrl,
        revokeToken: Boolean(options.revokeToken),
        json: options.json,
        store,
        output: options.output,
      });
      return 0;
    }

    if (sub === "status") {
      expectNoExtraPositionals(rest, "auth status");
      const resolved = await resolveCredentials({
        apiUrl: explicitApiUrl,
        store,
      });
      if (resolved.source === "none") {
        if (options.json) {
          printJson(
            {
              apiUrl: resolved.apiUrl ?? null,
              authMethod: null,
              source: "none",
            },
            options.output,
          );
        } else {
          await writeOut(
            options.output,
            "未ログインです。`sys4sys auth login` を実行してください。\n",
          );
        }
        return 0;
      }
      const client = clientFor(resolved);
      await authStatus(client, resolved, options.json, options.output);
      return 0;
    }

    throw new UsageError(
      "auth のサブコマンドは login / logout / status です。",
    );
  }

  if (group === "whoami") {
    const extras = [sub, ...rest].filter((value): value is string =>
      Boolean(value),
    );
    expectNoExtraPositionals(extras, "whoami");
    const resolved = await resolveCredentials({
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    });
    await whoami(clientFor(resolved), options.json, options.output);
    return 0;
  }

  if (group === "tokens") {
    const store = createCredentialStore();
    const resolved = await resolveCredentials({
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
      store,
    });
    if (resolved.source === "none") {
      throw new CliError(
        "認証情報がありません。`sys4sys auth login` を実行してください。",
        3,
      );
    }
    const client = clientFor(resolved);
    const tokens = await import("./commands/tokens.js");

    if (sub === "list") {
      expectNoExtraPositionals(rest, "tokens list");
      await tokens.listTokens(client, options);
      return 0;
    }
    if (sub === "create") {
      expectNoExtraPositionals(rest, "tokens create");
      await tokens.createToken(client, options, {
        store,
        resolved,
      });
      return 0;
    }
    if (sub === "revoke") {
      await tokens.revokeToken(client, rest, options);
      return 0;
    }

    throw new UsageError(
      "tokens のサブコマンドは list / create / revoke です。",
    );
  }

  if (group === "logs") {
    const resolved = await resolveCredentials({
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    });
    if (resolved.source === "none") {
      throw new CliError(
        "認証情報がありません。`sys4sys auth login` を実行してください。",
        3,
      );
    }
    const client = clientFor(resolved);
    const logs = await import("./commands/logs.js");

    if (sub === "query") {
      expectNoExtraPositionals(rest, "logs query");
      await logs.queryLogs(client, options);
      return 0;
    }
    if (sub === "tail") {
      expectNoExtraPositionals(rest, "logs tail");
      return await logs.tailLogs(client, options);
    }

    throw new UsageError("logs のサブコマンドは query / tail です。");
  }

  if (group === "hosts") {
    const client = await authedClient(parsed);
    switch (sub) {
      case "list":
        expectNoExtraPositionals(rest, "hosts list");
        await hostsCmd.listHosts(client, options);
        return 0;
      case "get":
        await hostsCmd.getHost(client, rest, options);
        return 0;
      case "detect":
        expectNoExtraPositionals(rest, "hosts detect");
        await hostsCmd.detectHosts(client, options);
        return 0;
      case "create":
        expectNoExtraPositionals(rest, "hosts create");
        await hostsCmd.createHost(client, options);
        return 0;
      case "update":
        await hostsCmd.updateHost(client, rest, options);
        return 0;
      default:
        throw new UsageError(
          "hosts のサブコマンドは list / get / detect / create / update です。",
        );
    }
  }

  if (group === "incidents") {
    const client = await authedClient(parsed);
    switch (sub) {
      case "list":
        expectNoExtraPositionals(rest, "incidents list");
        await incidentsCmd.listIncidents(client, options);
        return 0;
      case "get":
        await incidentsCmd.getIncident(client, rest, options);
        return 0;
      case "ack":
        await incidentsCmd.ackIncident(client, rest, options);
        return 0;
      case "resolve":
        await incidentsCmd.resolveIncident(client, rest, options);
        return 0;
      case "analyze":
        await incidentsCmd.analyzeIncident(client, rest, options);
        return 0;
      case "analysis":
        await incidentsCmd.incidentAnalysis(client, rest, options);
        return 0;
      default:
        throw new UsageError(
          "incidents のサブコマンドは list / get / ack / resolve / analyze / analysis です。",
        );
    }
  }

  if (group === "approvals") {
    const client = await authedClient(parsed);
    if (sub === "list") {
      expectNoExtraPositionals(rest, "approvals list");
      await approvalsCmd.listApprovals(client, options);
      return 0;
    }
    if (sub === "approve") {
      await approvalsCmd.approveApproval(client, rest, options);
      return 0;
    }
    if (sub === "reject") {
      await approvalsCmd.rejectApproval(client, rest, options);
      return 0;
    }
    throw new UsageError(
      "approvals のサブコマンドは list / approve / reject です。",
    );
  }

  if (group === "ports") {
    const client = await authedClient(parsed);
    switch (sub) {
      case "list":
        expectNoExtraPositionals(rest, "ports list");
        await portsCmd.listPorts(client, options);
        return 0;
      case "history":
        expectNoExtraPositionals(rest, "ports history");
        await portsCmd.portHistory(client, options);
        return 0;
      case "reserve":
        expectNoExtraPositionals(rest, "ports reserve");
        await portsCmd.reservePort(client, options);
        return 0;
      case "release":
        await portsCmd.releasePort(client, rest, options);
        return 0;
      case "kill":
        await portsCmd.killPort(client, rest, options);
        return 0;
      default:
        throw new UsageError(
          "ports のサブコマンドは list / history / reserve / release / kill です。",
        );
    }
  }

  if (group === "reports") {
    const client = await authedClient(parsed);
    if (sub === "list") {
      expectNoExtraPositionals(rest, "reports list");
      await reportsCmd.listReports(client, options);
      return 0;
    }
    if (sub === "get") {
      await reportsCmd.getReport(client, rest, options);
      return 0;
    }
    if (sub === "export") {
      await reportsCmd.exportReport(client, rest, options);
      return 0;
    }
    throw new UsageError("reports のサブコマンドは list / get / export です。");
  }

  if (group === "audit") {
    if (sub !== "list") {
      throw new UsageError("audit のサブコマンドは list のみです。");
    }
    expectNoExtraPositionals(rest, "audit list");
    const client = await authedClient(parsed);
    await auditCmd.listAudit(client, options);
    return 0;
  }

  if (group === "settings") {
    const client = await authedClient(parsed);
    const nested = [sub, ...rest].filter((value): value is string =>
      Boolean(value),
    );
    const category = nested[0];
    const actionName = nested[1];
    const extra = nested.slice(2);

    if (category === "mail") {
      if (actionName === "get") {
        expectNoExtraPositionals(extra, "settings mail get");
        await settingsCmd.getMailSettings(client, extra, options);
        return 0;
      }
      if (actionName === "set") {
        expectNoExtraPositionals(extra, "settings mail set");
        await settingsCmd.setMailSettings(client, extra, options);
        return 0;
      }
      if (actionName === "test") {
        expectNoExtraPositionals(extra, "settings mail test");
        await settingsCmd.testMailSettings(client, extra, options);
        return 0;
      }
      throw new UsageError(
        "settings mail のサブコマンドは get / set / test です。",
      );
    }

    if (category === "ai") {
      if (actionName === "get") {
        expectNoExtraPositionals(extra, "settings ai get");
        await settingsCmd.getAiSettings(client, extra, options);
        return 0;
      }
      if (actionName === "set") {
        expectNoExtraPositionals(extra, "settings ai set");
        await settingsCmd.setAiSettings(client, extra, options);
        return 0;
      }
      if (actionName === "test") {
        expectNoExtraPositionals(extra, "settings ai test");
        await settingsCmd.testAiSettings(client, extra, options);
        return 0;
      }
      throw new UsageError(
        "settings ai のサブコマンドは get / set / test です。",
      );
    }

    if (category === "retention") {
      if (actionName === "get") {
        expectNoExtraPositionals(extra, "settings retention get");
        await settingsCmd.getRetentionSettings(client, extra, options);
        return 0;
      }
      if (actionName === "set") {
        expectNoExtraPositionals(extra, "settings retention set");
        await settingsCmd.setRetentionSettings(client, extra, options);
        return 0;
      }
      throw new UsageError(
        "settings retention のサブコマンドは get / set です。",
      );
    }

    if (category === "backup" && !actionName) {
      expectNoExtraPositionals(extra, "settings backup");
      await settingsCmd.createBackup(client, extra, options);
      return 0;
    }

    throw new UsageError(
      "settings のサブコマンドは mail / ai / retention / backup です。",
    );
  }

  if (group === "deploy-requests") {
    const client = await authedClient(parsed);
    switch (sub) {
      case "list":
        expectNoExtraPositionals(rest, "deploy-requests list");
        await deployRequestsCmd.listDeployRequests(client, options);
        return 0;
      case "get":
        await deployRequestsCmd.getDeployRequest(client, rest, options);
        return 0;
      case "approve":
        return await deployRequestsCmd.approveDeployRequest(
          client,
          rest,
          options,
        );
      case "reject":
        return await deployRequestsCmd.rejectDeployRequest(
          client,
          rest,
          options,
        );
      default:
        throw new UsageError(
          "deploy-requests のサブコマンドは list / get / approve / reject です。",
        );
    }
  }

  if (group === "services") {
    const resolved = await resolveCredentials({
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    });
    if (resolved.source === "none") {
      throw new CliError(
        "認証情報がありません。`sys4sys auth login` を実行してください。",
        3,
      );
    }
    const client = clientFor(resolved);

    switch (sub) {
      case "list":
        expectNoExtraPositionals(rest, "services list");
        await listServices(client, options);
        return 0;
      case "get":
        await getService(client, rest, options);
        return 0;
      case "create":
        expectNoExtraPositionals(rest, "services create");
        await createServiceCommand(client, options);
        return 0;
      case "update":
        await updateService(client, rest, options);
        return 0;
      case "deploy":
        return await deployService(client, rest, options);
      case "start":
      case "stop":
      case "restart":
      case "delete":
      case "actions": {
        const lifecycle = await import("./commands/services.js");
        return await lifecycle.runServiceLifecycle(sub, client, rest, options);
      }
      default:
        throw new UsageError(
          "services のサブコマンドは list / get / create / update / deploy / start / stop / restart / delete / actions です。",
        );
    }
  }

  throw new UsageError(`不明なコマンドです: ${group}`);
}

function clientFor(
  resolved: Awaited<ReturnType<typeof resolveCredentials>>,
): ApiClient {
  return new ApiClient({
    apiUrl: resolved.apiUrl,
    token: resolved.token,
    sessionCookie: resolved.sessionCookie,
    email: resolved.email,
    password: resolved.password,
  });
}

export async function run(argv: string[], output?: CliOutput): Promise<number> {
  const json = argv.includes("--json") || argv.includes("-j");
  try {
    return await main(argv, output);
  } catch (error) {
    printFailure(error, json, output);
    return exitCodeFor(error);
  }
}

export { CLI_VERSION } from "./version.js";
