import { once } from "node:events";

export interface CliOutput {
  out(text: string): void | Promise<void>;
  err(text: string): void;
}

export const defaultOutput: CliOutput = {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
};

export async function writeOut(
  output: CliOutput | undefined,
  text: string,
): Promise<void> {
  if (output) {
    await output.out(text);
    return;
  }
  if (process.stdout.write(text)) return;
  await once(process.stdout, "drain");
}

export function writeErr(output: CliOutput | undefined, text: string): void {
  (output ?? defaultOutput).err(text);
}

export function printJson(value: unknown, output?: CliOutput): void {
  void writeOut(output, `${JSON.stringify(value, null, 2)}\n`);
}

export function printError(
  message: string,
  json: boolean,
  details?: Record<string, unknown>,
  output?: CliOutput,
): void {
  if (json) {
    printJson(
      {
        error: {
          message,
          ...details,
        },
      },
      output,
    );
    return;
  }
  writeErr(output, `${message}\n`);
}

/**
 * `env` / `deploy.env` の値だけを再帰的に伏せる。
 * 秘密値を見せる必要がある場合は showEnv=true を明示する。
 */
export function redactEnvFields<T>(value: T, showEnv: boolean): T {
  if (showEnv) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactEnvFields(item, false)) as T;
  }

  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "env" &&
        child !== null &&
        typeof child === "object" &&
        !Array.isArray(child)
      ) {
        output[key] = Object.fromEntries(
          Object.keys(child).map((name) => [name, "***"]),
        );
      } else {
        output[key] = redactEnvFields(child, false);
      }
    }
    return output as T;
  }

  return value;
}

export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) : id;
}

export function printTable(
  headers: string[],
  rows: string[][],
  output?: CliOutput,
): void {
  const widths = headers.map((header, index) =>
    rows.reduce(
      (max, row) => Math.max(max, (row[index] ?? "").length),
      header.length,
    ),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length))
      .join("  ")
      .trimEnd();

  const lines = [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map((row) => line(row)),
  ];
  void writeOut(output, `${lines.join("\n")}\n`);
}
