import { UsageError } from "../errors.js";
import {
  COMMANDS,
  GLOBAL_OPTIONS,
  allOptionsFor,
  type CommandDefinition,
  type CommandOption,
} from "./registry.js";

export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;

export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

function optionWords(options: CommandOption[]): string[] {
  const words: string[] = [];
  for (const option of options) {
    if (option.short) words.push(`-${option.short}`);
    words.push(`--${option.name}`);
  }
  return [...new Set(words)].sort();
}

function commandOptionWords(command: CommandDefinition): string {
  return optionWords(allOptionsFor(command)).join(" ");
}

function topLevelWords(): string[] {
  return [
    ...new Set(COMMANDS.map((command) => command.name.split(" ")[0] ?? "")),
  ]
    .filter(Boolean)
    .sort();
}

function groupsWithSubcommands(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const command of COMMANDS) {
    const parts = command.name.split(" ");
    if (parts.length < 2) continue;
    const group = parts[0];
    const sub = parts[1];
    if (!group || !sub) continue;
    const entries = groups.get(group) ?? [];
    if (!entries.includes(sub)) entries.push(sub);
    groups.set(group, entries);
  }
  return new Map(
    [...groups.entries()].map(([group, subs]) => [group, subs.sort()]),
  );
}

function bashScript(): string {
  const groups = groupsWithSubcommands();
  const cases = COMMANDS.map((command) => {
    const words = command.name.split(" ");
    const pattern = words.join(" ");
    return `    "${pattern}") opts="${commandOptionWords(command)}" ;;`;
  });
  const subCases = [...groups.entries()].map(
    ([group, subs]) =>
      `    "${group}") COMPREPLY=($(compgen -W "${subs.join(" ")}" -- "$cur")); return ;;`,
  );
  const thirdWordCases = COMMANDS.filter(
    (command) => command.name.split(" ").length === 3,
  ).map((command) => {
    const words = command.name.split(" ");
    return `    "${words[0]} ${words[1]}") COMPREPLY=($(compgen -W "${words[2]}" -- "$cur")); return ;;`;
  });

  return `# bash completion for sys4sys
# Generated from the sys4sys command registry.
_sys4sys_completions() {
  local cur opts cmd second
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  if [[ \$COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${topLevelWords().join(" ")}" -- "$cur") )
    return 0
  fi

  cmd="\${COMP_WORDS[1]}"
  second="\${COMP_WORDS[2]}"

  if [[ \$COMP_CWORD -eq 3 ]]; then
    case "$cmd $second" in
${thirdWordCases.join("\n")}
    esac
  fi

  opts=""
  case "$cmd $second" in
${cases.join("\n")}
  esac

  if [[ -n "$opts" ]]; then
    COMPREPLY=( $(compgen -W "$opts" -- "$cur") )
    return 0
  fi

  case "$cmd" in
${subCases.join("\n")}
  esac
  return 0
}
complete -F _sys4sys_completions sys4sys
`;
}

function zshScript(): string {
  const commandLines = COMMANDS.map((command) => {
    const summary = command.summary.replace(/'/g, "'\\''");
    return `    '${command.name}:${summary}'`;
  });
  const optionLines = COMMANDS.map(
    (command) => `  '${command.name}: :(${commandOptionWords(command)})'`,
  );
  return `#compdef sys4sys
# zsh completion for sys4sys (static, generated from the command registry)
_sys4sys() {
  local -a commands options_for
  commands=(
${commandLines.join("\n")}
  )
  options_for=(
${optionLines.join("\n")}
  )
  if (( CURRENT == 2 )); then
    _describe -t commands 'sys4sys command' commands
    return
  fi
  local command_name="\${words[2]}"
  if (( CURRENT >= 3 )); then
    command_name="\${words[2]} \${words[3]}"
  fi
  local entry
  for entry in "\${options_for[@]}"; do
    if [[ "\${entry%%:*}" == "$command_name" ]]; then
      local raw="\${entry#*: :(}"
      raw="\${raw%)}"
      compadd -- \${(z)raw}
      return
    fi
  done
  _files
}
compdef _sys4sys sys4sys
`;
}

function fishScript(): string {
  const groups = groupsWithSubcommands();
  const lines = [
    "# fish completion for sys4sys",
    `# commands: ${COMMANDS.map((command) => command.name).join(", ")}`,
    "complete -c sys4sys -f",
  ];
  for (const word of topLevelWords()) {
    const command = COMMANDS.find((item) => item.name === word);
    const summary = command?.summary ?? word;
    lines.push(
      `complete -c sys4sys -n '__fish_use_subcommand' -a '${word}' -d '${summary.replace(/'/g, "\\'")}'`,
    );
  }
  for (const [group, subs] of groups) {
    const subList = subs.join(" ");
    lines.push(
      `complete -c sys4sys -n '__fish_seen_subcommand_from ${group}' -a '${subList}'`,
    );
  }
  for (const command of COMMANDS) {
    const words = command.name.split(" ");
    const condition =
      words.length === 1
        ? `__fish_seen_subcommand_from ${words[0]}`
        : `__fish_seen_subcommand_from ${words[words.length - 1]}`;
    lines.push(
      `complete -c sys4sys -n '${condition}' -a '${optionWords(allOptionsFor(command)).join(" ")}'`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function powershellScript(): string {
  const names = COMMANDS.map((command) => `'${command.name}'`).join(", ");
  const options = optionWords([
    ...GLOBAL_OPTIONS,
    ...COMMANDS.flatMap((command) => command.options),
  ])
    .map((option) => `'${option}'`)
    .join(", ");
  return `# PowerShell completion for sys4sys
# Generated from the sys4sys command registry.
Register-ArgumentCompleter -Native -CommandName sys4sys -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $commands = @(${names})
    $options = @(${options})
    $candidates = if ($wordToComplete.StartsWith('-')) { $options } else { $commands }
    $candidates |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
            [System.Management.Automation.CompletionResult]::new(
                $_, $_, 'ParameterValue', $_)
        }
}
`;
}

export function completionScript(shell: string): string {
  switch (shell) {
    case "bash":
      return bashScript();
    case "zsh":
      return zshScript();
    case "fish":
      return fishScript();
    case "powershell":
      return powershellScript();
    default:
      throw new UsageError(
        `補完シェルは ${COMPLETION_SHELLS.join(" / ")} のいずれかです。`,
      );
  }
}

export function isCompletionShell(value: string): value is CompletionShell {
  return (COMPLETION_SHELLS as readonly string[]).includes(value);
}

/** PowerShell / zsh の生成結果を検証しやすくするための共通語彙。 */
export function completionVocabulary(): {
  commands: string[];
  options: string[];
} {
  return {
    commands: COMMANDS.map((command) => command.name),
    options: [
      ...new Set([
        ...optionWords(GLOBAL_OPTIONS),
        ...COMMANDS.flatMap((command) => optionWords(command.options)),
      ]),
    ].sort(),
  };
}
