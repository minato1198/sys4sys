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
  email?: string;
  "password-stdin"?: boolean;
  "revoke-token"?: boolean;
  user?: string;
  name?: string;
  scope?: string[];
  "expires-in"?: string;
  save?: boolean;
  limit?: string;
  cursor?: string;
  service?: string;
  level?: string;
  grep?: string;
  since?: string;
  until?: string;
  "no-truncate"?: boolean;
  "no-reconnect"?: boolean;
  md?: boolean;
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
  email: { type: "string" },
  "password-stdin": { type: "boolean" },
  "revoke-token": { type: "boolean" },
  user: { type: "string" },
  name: { type: "string" },
  scope: { type: "string", multiple: true },
  "expires-in": { type: "string" },
  save: { type: "boolean" },
  limit: { type: "string" },
  cursor: { type: "string" },
  service: { type: "string" },
  level: { type: "string" },
  grep: { type: "string" },
  since: { type: "string" },
  until: { type: "string" },
  "no-truncate": { type: "boolean" },
  "no-reconnect": { type: "boolean" },
  md: { type: "boolean" },
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
