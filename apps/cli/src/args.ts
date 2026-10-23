import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export interface CliValues {
  api?: string;
  json?: boolean;
  help?: boolean;
  file?: string;
  host?: string;
  status?: string;
  "dry-run"?: boolean;
  yes?: boolean;
  wait?: boolean;
  timeout?: string;
  "show-env"?: boolean;
}

export interface ParsedCli {
  values: CliValues;
  positionals: string[];
}

const options = {
  api: { type: "string" },
  json: { type: "boolean", short: "j" },
  help: { type: "boolean", short: "h" },
  file: { type: "string", short: "f" },
  host: { type: "string" },
  status: { type: "string" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  wait: { type: "boolean" },
  timeout: { type: "string" },
  "show-env": { type: "boolean" },
} as const;

export function parseCliArgs(argv: string[]): ParsedCli {
  try {
    const parsed = parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      strict: true,
    });

    return {
      values: parsed.values as CliValues,
      positionals: parsed.positionals,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "引数を解析できませんでした";
    throw new UsageError(message);
  }
}
