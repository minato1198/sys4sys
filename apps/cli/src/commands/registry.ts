import type { z } from "zod";
import { COMMAND_DEFINITIONS } from "./metadata.js";

export interface CommandOption {
  name: string;
  type: "string" | "boolean" | "number";
  short?: string;
  description: string;
  required?: boolean;
  default?: string;
  multiple?: boolean;
  valueName?: string;
}

export interface CommandPositional {
  name: string;
  required: boolean;
  description: string;
}

export interface CommandDefinition {
  name: string;
  summary: string;
  description?: string;
  phase: "P0" | "P1" | "P2";
  positionals: CommandPositional[];
  options: CommandOption[];
  examples: string[];
  mutating: boolean;
  requiresConfirmation: boolean;
  requiredScopes: string[];
  /** P0-11 の Schema 生成で使う。registry 自体は副作用を持たない。 */
  inputSchema?: z.ZodType;
}

export interface ResolvedCommand {
  command: CommandDefinition;
  rest: string[];
}

export const GLOBAL_OPTIONS: CommandOption[] = [
  {
    name: "api",
    type: "string",
    description: "API のルート URL",
    default: "http://127.0.0.1:8787",
  },
  {
    name: "json",
    type: "boolean",
    short: "j",
    description: "JSON で出力",
  },
  {
    name: "help",
    type: "boolean",
    short: "h",
    description: "ヘルプを表示",
  },
];

export function allOptionsFor(command: CommandDefinition): CommandOption[] {
  return [...GLOBAL_OPTIONS, ...command.options];
}

export function commandNames(): string[] {
  return COMMANDS.map((command) => command.name);
}

export function findCommand(name: string): CommandDefinition | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function commandsInGroup(group: string): CommandDefinition[] {
  const prefix = `${group} `;
  return COMMANDS.filter(
    (command) =>
      command.name === group ||
      (command.name.startsWith(prefix) &&
        !command.name.slice(prefix.length).includes(" ")),
  );
}

/**
 * 完全名（2 語）を優先し、次に 1 語のコマンドを探す。
 * 余分な positional は rest として返す。
 */
export function resolveCommand(positionals: string[]): ResolvedCommand | null {
  if (positionals.length === 0) return null;

  if (positionals.length >= 2) {
    const twoWord = `${positionals[0]} ${positionals[1]}`;
    const command = findCommand(twoWord);
    if (command) {
      return { command, rest: positionals.slice(2) };
    }
  }

  const command = findCommand(positionals[0] ?? "");
  if (command) {
    return { command, rest: positionals.slice(1) };
  }

  return null;
}

export function validateRegistry(definitions: CommandDefinition[]): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.name)) {
      throw new Error(`duplicate command definition: ${definition.name}`);
    }
    seen.add(definition.name);
    if (!definition.name.trim()) {
      throw new Error("command name must not be empty");
    }
    if (!definition.summary.trim()) {
      throw new Error(`summary is required: ${definition.name}`);
    }
    if (definition.examples.length === 0) {
      throw new Error(`examples are required: ${definition.name}`);
    }
    if (!definition.phase) {
      throw new Error(`phase is required: ${definition.name}`);
    }
  }
}

export const COMMANDS: CommandDefinition[] = COMMAND_DEFINITIONS;

validateRegistry(COMMANDS);
