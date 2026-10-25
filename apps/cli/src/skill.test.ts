import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMANDS } from "./commands/registry.js";

const commandNames = COMMANDS.map((command) => command.name).sort(
  (a, b) => b.length - a.length,
);

function commandFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (
    !trimmed.startsWith("sys4sys ") &&
    !trimmed.startsWith("pnpm sys4sys -- ")
  )
    return null;
  if (trimmed.startsWith("#")) return null;

  const normalized = trimmed
    .replace(/^pnpm sys4sys --\s+/, "")
    .replace(/^sys4sys\s+/, "");
  if (normalized === "help" || normalized.startsWith("--help")) return "help";
  return (
    commandNames.find(
      (name) => normalized === name || normalized.startsWith(`${name} `),
    ) ?? null
  );
}

async function assertCommandLinesExist(relativePath: string): Promise<string> {
  const text = await readFile(new URL(relativePath, import.meta.url), "utf8");
  const unknown: string[] = [];
  let found = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    if (!line.trim().match(/^(sys4sys |pnpm sys4sys -- )/)) continue;
    found += 1;
    if (!commandFromLine(line)) unknown.push(line.trim());
  }
  assert.ok(found > 0, `${relativePath} にコマンド例がありません`);
  assert.deepEqual(unknown, [], `${relativePath} に未登録のコマンドがあります`);
  return text;
}

test("SKILL.md only documents registered commands", async () => {
  const text = await assertCommandLinesExist("../SKILL.md");
  assert.match(text, /docs\/cli-schema\.json/);
  assert.match(text, /--show-env/);
  assert.match(text, /exit 2/);
  assert.match(text, /exit 5/);
});

test("CLI README only documents registered commands", async () => {
  const text = await assertCommandLinesExist("../README.md");
  assert.match(text, /SKILL\.md/);
  assert.match(text, /docs\/cli-schema\.json/);
});

test("SKILL.md frontmatter is present and describes sys4sys", async () => {
  const text = await readFile(new URL("../SKILL.md", import.meta.url), "utf8");
  assert.match(text, /^---\nname: sys4sys\n/m);
  assert.match(text, /^description: .*sys4sys/m);
});
