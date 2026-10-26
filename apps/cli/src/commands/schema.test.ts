import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UsageError } from "../errors.js";
import { CLI_VERSION } from "../version.js";
import { COMMANDS } from "./registry.js";
import {
  formatSchemaJson,
  formatSchemaMarkdown,
  generateSchema,
  printSchema,
} from "./schema.js";

test("generates a schema for every registered command", () => {
  const schema = generateSchema();
  assert.equal(schema.schemaVersion, "1");
  assert.equal(schema.cliVersion, CLI_VERSION);
  assert.equal(schema.commands.length, COMMANDS.length);
  assert.deepEqual(
    schema.commands.map((command) => command.name),
    COMMANDS.map((command) => command.name),
  );
  assert.deepEqual(schema.auth.methods, ["token", "session"]);
  assert.equal(schema.exitCodes["5"], "async failure");
});

test("filters to a single command", () => {
  const schema = generateSchema("services list");
  assert.equal(schema.commands.length, 1);
  assert.equal(schema.commands[0]?.name, "services list");
  assert.deepEqual(schema.commands[0]?.requiredScopes, ["services:read"]);
  assert.equal(schema.commands[0]?.options.properties.json?.type, "boolean");
});

test("rejects unknown command names", () => {
  assert.throws(() => generateSchema("services nope"), UsageError);
});

test("markdown contains usage and required scopes", () => {
  const markdown = formatSchemaMarkdown(generateSchema("tokens create"));
  assert.match(markdown, /sys4sys tokens create/);
  assert.match(markdown, /tokens:manage/);
  assert.match(markdown, /--scope/);
});

test("schema output does not contain secrets or environment values", () => {
  const json = formatSchemaJson(generateSchema());
  assert.doesNotMatch(json, /SYS4SYS_PASSWORD|SYS4SYS_TOKEN/);
  assert.doesNotMatch(json, /top-secret/);
});

test("printSchema returns JSON or Markdown", () => {
  const markdown = printSchema(undefined, {
    json: false,
    showEnv: false,
    dryRun: false,
    yes: false,
    wait: false,
  });
  assert.match(markdown, /sys4sys CLI schema/);

  const json = printSchema("hosts list", {
    json: true,
    showEnv: false,
    dryRun: false,
    yes: false,
    wait: false,
  });
  const parsed = JSON.parse(json) as { commands: { name: string }[] };
  assert.equal(parsed.commands[0]?.name, "hosts list");
});

test("checked-in schema matches the generator", async () => {
  const checkedIn = await readFile(
    new URL("../../../../docs/cli-schema.json", import.meta.url),
    "utf8",
  );
  assert.equal(checkedIn, formatSchemaJson(generateSchema()));
});
