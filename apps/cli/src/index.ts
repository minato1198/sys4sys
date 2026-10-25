import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { parseCliArgs } from "./args.js";
import { createCredentialStore, resolveCredentials } from "./auth/store.js";
import { ApiClient, ApiError } from "./client.js";
import { authLogin, authLogout, authStatus, whoami } from "./commands/auth.js";
import { listHosts } from "./commands/hosts.js";
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

export async function main(
  argv: string[],
  cliOutput?: CliOutput,
): Promise<number> {
  const parsed = parseCliArgs(argv);

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
    output: cliOutput,
  };

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
    if (sub !== "list") {
      throw new UsageError("hosts のサブコマンドは list のみです。");
    }
    expectNoExtraPositionals(rest, "hosts list");
    const resolved = await resolveCredentials({
      apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    });
    await listHosts(clientFor(resolved), options.json, options.output);
    return 0;
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

const entrypoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entrypoint && entrypoint === import.meta.url) {
  const code = await run(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}
