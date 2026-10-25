import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { formatSchemaJson, generateSchema } from "../commands/schema.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const writeIndex = args.indexOf("--write");
  const outputPath =
    writeIndex === -1 ? null : (args[writeIndex + 1] ?? "docs/cli-schema.json");
  if (writeIndex !== -1 && !args[writeIndex + 1]) {
    throw new Error("--write には出力先パスが必要です。");
  }

  const json = formatSchemaJson(generateSchema());
  if (!outputPath) {
    process.stdout.write(json);
    return;
  }

  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, json, "utf8");
  process.stderr.write(`wrote ${target}\n`);
}

await main();
