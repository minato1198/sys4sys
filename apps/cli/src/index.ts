import { pathToFileURL } from "node:url";
import { ZodError } from "zod";
import { parseCliArgs } from "./args.js";
import { ApiClient, ApiError } from "./client.js";
import { whoami } from "./commands/auth.js";
import { listHosts } from "./commands/hosts.js";
import {
  createService,
  deployService,
  getService,
  listServices,
  updateService,
  type CommandOptions,
} from "./commands/services.js";
import { CliError, UsageError } from "./errors.js";
import { printHelp } from "./help.js";
import { printError } from "./output.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCodeFor(error: unknown): number {
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

function printFailure(error: unknown, json: boolean): void {
  if (error instanceof ApiError) {
    printError(`${error.status} ${error.title}: ${error.detail}`, json, {
      status: error.status,
      title: error.title,
      detail: error.detail,
      errors: error.problem?.errors,
    });
    return;
  }

  if (error instanceof ZodError) {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.join(".") || "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    printError(`入力が不正です: ${details}`, json);
    return;
  }

  if (error instanceof CliError) {
    printError(error.message, json);
    return;
  }

  printError(`予期しないエラー: ${errorMessage(error)}`, json);
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

export async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);

  if (
    parsed.values.help ||
    parsed.positionals.length === 0 ||
    parsed.positionals[0] === "help"
  ) {
    printHelp();
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
  };

  const client = new ApiClient({
    apiUrl: parsed.values.api ?? process.env.SYS4SYS_API_URL,
    email: process.env.SYS4SYS_EMAIL,
    password: process.env.SYS4SYS_PASSWORD,
    sessionCookie: process.env.SYS4SYS_SESSION_COOKIE,
  });

  if (group === "whoami") {
    const extras = [sub, ...rest].filter((value): value is string =>
      Boolean(value),
    );
    expectNoExtraPositionals(extras, "whoami");
    await whoami(client, options.json);
    return 0;
  }

  if (group === "hosts") {
    if (sub !== "list") {
      throw new UsageError("hosts のサブコマンドは list のみです。");
    }
    expectNoExtraPositionals(rest, "hosts list");
    await listHosts(client, options.json);
    return 0;
  }

  if (group === "services") {
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
        await createService(client, options);
        return 0;
      case "update":
        await updateService(client, rest, options);
        return 0;
      case "deploy":
        return await deployService(client, rest, options);
      default:
        throw new UsageError(
          "services のサブコマンドは list / get / create / update / deploy です。",
        );
    }
  }

  throw new UsageError(`不明なコマンドです: ${group}`);
}

export async function run(argv: string[]): Promise<number> {
  const json = argv.includes("--json") || argv.includes("-j");
  try {
    return await main(argv);
  } catch (error) {
    printFailure(error, json);
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
