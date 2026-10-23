import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "./args.js";
import { UsageError } from "./errors.js";

test("parses service list flags", () => {
  const parsed = parseCliArgs([
    "services",
    "list",
    "--host",
    "host-1",
    "--json",
  ]);

  assert.deepEqual(parsed.positionals, ["services", "list"]);
  assert.equal(parsed.values.host, "host-1");
  assert.equal(parsed.values.json, true);
});

test("parses deploy flags", () => {
  const parsed = parseCliArgs([
    "services",
    "deploy",
    "service-1",
    "--wait",
    "--yes",
    "--timeout",
    "120",
  ]);

  assert.deepEqual(parsed.positionals, ["services", "deploy", "service-1"]);
  assert.equal(parsed.values.wait, true);
  assert.equal(parsed.values.yes, true);
  assert.equal(parsed.values.timeout, "120");
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseCliArgs(["services", "list", "--unknown"]),
    UsageError,
  );
});
