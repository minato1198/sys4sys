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
  severity?: string;
  offset?: string;
  note?: string;
  full?: boolean;
  kind?: string;
  distro?: string;
  disabled?: boolean;
  enable?: boolean;
  disable?: boolean;
  protocol?: string;
  port?: string;
  reservations?: boolean;
  pid?: string;
  "pid-scope"?: string;
  signal?: string;
  force?: boolean;
  format?: string;
  output?: string;
  request?: boolean;
  action?: string;
  target?: string;
  actor?: string;
  incident?: string;
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
  severity: { type: "string" },
  offset: { type: "string" },
  note: { type: "string" },
  full: { type: "boolean" },
  kind: { type: "string" },
  distro: { type: "string" },
  disabled: { type: "boolean" },
  enable: { type: "boolean" },
  disable: { type: "boolean" },
  protocol: { type: "string" },
  port: { type: "string" },
  reservations: { type: "boolean" },
  pid: { type: "string" },
  "pid-scope": { type: "string" },
  signal: { type: "string" },
  force: { type: "boolean" },
  format: { type: "string" },
  output: { type: "string" },
  request: { type: "boolean" },
  action: { type: "string" },
  target: { type: "string" },
  actor: { type: "string" },
  incident: { type: "string" },
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
