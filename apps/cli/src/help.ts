import {
  COMMANDS,
  GLOBAL_OPTIONS,
  allOptionsFor,
  findCommand,
  type CommandDefinition,
  type CommandOption,
} from "./commands/registry.js";

function usageFor(command: CommandDefinition): string {
  const parts = ["sys4sys", command.name];
  for (const positional of command.positionals) {
    parts.push(
      positional.required ? `<${positional.name}>` : `[${positional.name}]`,
    );
  }
  if (command.options.length > 0) parts.push("[options]");
  return parts.join(" ");
}

function optionLabel(option: CommandOption): string {
  const flag = `${option.short ? `-${option.short}, ` : ""}--${option.name}`;
  return option.type === "boolean"
    ? flag
    : `${flag} <${option.valueName ?? option.name}>`;
}

function optionLine(option: CommandOption): string {
  const suffix = [
    option.required ? "required" : null,
    option.default ? `default: ${option.default}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const description = suffix
    ? `${option.description} (${suffix})`
    : option.description;
  return `  ${optionLabel(option).padEnd(28)} ${description}`;
}

function commandHelpLines(command: CommandDefinition): string[] {
  const lines = [`sys4sys ${command.name}`, "", command.summary];
  if (command.description) lines.push("", command.description);
  lines.push("", "Usage:", `  ${usageFor(command)}`);

  if (command.positionals.length > 0) {
    lines.push("", "Arguments:");
    for (const positional of command.positionals) {
      lines.push(
        `  ${positional.name.padEnd(12)} ${positional.description}${positional.required ? " (required)" : ""}`,
      );
    }
  }

  lines.push("", "Options:");
  for (const option of allOptionsFor(command)) lines.push(optionLine(option));

  lines.push("", "Examples:");
  for (const example of command.examples) lines.push(`  ${example}`);
  return lines;
}

function globalHelpLines(): string[] {
  const lines = [
    "sys4sys CLI",
    "",
    "Usage:",
    "  sys4sys <command> [options]",
    "  sys4sys <group> <subcommand> [options]",
    "  sys4sys --help",
    "  sys4sys help <command>",
    "",
    "Commands:",
  ];
  for (const command of COMMANDS) {
    lines.push(`  ${command.name.padEnd(28)} ${command.summary}`);
  }
  lines.push("", "Options:");
  for (const option of GLOBAL_OPTIONS) lines.push(optionLine(option));
  lines.push(
    "",
    "Environment:",
    "  SYS4SYS_API_URL           API のルート URL",
    "  SYS4SYS_TOKEN             API トークン（最優先）",
    "  SYS4SYS_TOKEN_FILE        API トークンを書いたファイル",
    "  SYS4SYS_EMAIL             ログインメール",
    "  SYS4SYS_PASSWORD          ログインパスワード",
    "  SYS4SYS_SESSION_COOKIE    既存の sys4sys_session Cookie",
    "  SYS4SYS_CONFIG_DIR        資格情報ファイルの保存先",
    "",
    "Examples:",
    "  pnpm sys4sys -- whoami --json",
    "  pnpm sys4sys -- services list",
    "  pnpm sys4sys -- logs query --service <id> --level error --since 2h",
  );
  return lines;
}

export function formatHelp(commandName?: string): string {
  if (commandName) {
    const command = findCommand(commandName);
    if (!command) return `不明なコマンドです: ${commandName}\n`;
    return `${commandHelpLines(command).join("\n")}\n`;
  }
  return `${globalHelpLines().join("\n")}\n`;
}

export function printHelp(commandName?: string): void {
  process.stdout.write(formatHelp(commandName));
}
