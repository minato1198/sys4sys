import {
  COMMANDS,
  allOptionsFor,
  findCommand,
  type CommandDefinition,
  type CommandOption,
} from "./registry.js";
import { UsageError } from "../errors.js";
import { CLI_VERSION } from "../version.js";
import type { CommandOptions } from "./services.js";

export const CLI_SCHEMA_VERSION = "1";
export { CLI_VERSION };

export interface JsonSchemaProperty {
  type: string;
  description?: string;
  default?: string;
  items?: { type: string };
}

export interface CommandSchema {
  name: string;
  summary: string;
  description?: string;
  phase: "P0" | "P1" | "P2";
  mutating: boolean;
  requiresConfirmation: boolean;
  requiredScopes: string[];
  positionals: Array<{
    name: string;
    required: boolean;
    description: string;
  }>;
  options: {
    type: "object";
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
    additionalProperties: false;
  };
  examples: string[];
}

export interface CliSchema {
  schemaVersion: string;
  cliVersion: string;
  auth: {
    methods: string[];
    tokenHeader: string;
  };
  exitCodes: Record<string, string>;
  commands: CommandSchema[];
}

const EXIT_CODES: Record<string, string> = {
  "0": "success",
  "1": "general error",
  "2": "usage error",
  "3": "auth error",
  "4": "conflict",
  "5": "async failure",
};

function optionProperty(option: CommandOption): JsonSchemaProperty {
  const property: JsonSchemaProperty = {
    type:
      option.type === "boolean"
        ? "boolean"
        : option.type === "number"
          ? "number"
          : "string",
    description: option.description,
  };
  if (option.default !== undefined) property.default = option.default;
  if (option.multiple) {
    property.type = "array";
    property.items = { type: "string" };
  }
  return property;
}

export function commandSchema(definition: CommandDefinition): CommandSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const option of allOptionsFor(definition)) {
    properties[option.name] = optionProperty(option);
  }

  const required = definition.options
    .filter((option) => option.required)
    .map((option) => option.name);

  return {
    name: definition.name,
    summary: definition.summary,
    ...(definition.description ? { description: definition.description } : {}),
    phase: definition.phase,
    mutating: definition.mutating,
    requiresConfirmation: definition.requiresConfirmation,
    requiredScopes: [...definition.requiredScopes],
    positionals: definition.positionals.map((positional) => ({
      name: positional.name,
      required: positional.required,
      description: positional.description,
    })),
    options: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    examples: [...definition.examples],
  };
}

export function generateSchema(commandName?: string): CliSchema {
  let definitions = COMMANDS;
  if (commandName) {
    const command = findCommand(commandName.trim());
    if (!command) {
      throw new UsageError(`不明なコマンドです: ${commandName}`);
    }
    definitions = [command];
  }

  return {
    schemaVersion: CLI_SCHEMA_VERSION,
    cliVersion: CLI_VERSION,
    auth: {
      methods: ["token", "session"],
      tokenHeader: "Authorization: Bearer <token>",
    },
    exitCodes: { ...EXIT_CODES },
    commands: definitions.map(commandSchema),
  };
}

export function formatSchemaJson(schema: CliSchema): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function formatSchemaMarkdown(schema: CliSchema): string {
  const lines: string[] = [
    "# sys4sys CLI schema",
    "",
    `- schemaVersion: ${schema.schemaVersion}`,
    `- cliVersion: ${schema.cliVersion}`,
    `- auth: ${schema.auth.methods.join(", ")}`,
    `- token header: \`${schema.auth.tokenHeader}\``,
    "",
    "## Exit codes",
    "",
  ];
  for (const [code, meaning] of Object.entries(schema.exitCodes)) {
    lines.push(`- ${code}: ${meaning}`);
  }

  for (const command of schema.commands) {
    lines.push("", `## \`sys4sys ${command.name}\``, "", command.summary);
    if (command.description) lines.push("", command.description);

    const usage = [
      "sys4sys",
      command.name,
      ...command.positionals.map((positional) =>
        positional.required ? `<${positional.name}>` : `[${positional.name}]`,
      ),
      "[options]",
    ].join(" ");
    lines.push("", "```text", usage, "```");

    if (command.positionals.length > 0) {
      lines.push("", "### Arguments", "");
      for (const positional of command.positionals) {
        lines.push(
          `- \`${positional.name}\`${positional.required ? " (required)" : ""}: ${positional.description}`,
        );
      }
    }

    lines.push(
      "",
      "### Options",
      "",
      "| Option | Type | Description |",
      "| --- | --- | --- |",
    );
    for (const [name, property] of Object.entries(command.options.properties)) {
      const type = property.items
        ? `${property.type}<${property.items.type}>`
        : property.type;
      const description = property.description ?? "";
      const suffix = property.default ? ` (default: ${property.default})` : "";
      lines.push(`| \`--${name}\` | ${type} | ${description}${suffix} |`);
    }

    lines.push(
      "",
      `- mutating: ${command.mutating}`,
      `- requiresConfirmation: ${command.requiresConfirmation}`,
      `- requiredScopes: ${command.requiredScopes.length > 0 ? command.requiredScopes.join(", ") : "(none)"}`,
    );

    if (command.examples.length > 0) {
      lines.push("", "### Examples", "", "```bash");
      for (const example of command.examples) lines.push(example);
      lines.push("```");
    }
  }

  return `${lines.join("\n")}\n`;
}

export function printSchema(
  commandName: string | undefined,
  options: CommandOptions,
): string {
  const schema = generateSchema(commandName);
  return options.json ? formatSchemaJson(schema) : formatSchemaMarkdown(schema);
}
