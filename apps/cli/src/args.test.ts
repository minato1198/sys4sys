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

test("parses repeatable token scopes and auth flags", () => {
  const parsed = parseCliArgs([
    "tokens",
    "create",
    "--name",
    "ci",
    "--scope",
    "services:read",
    "--scope",
    "logs:read",
    "--expires-in",
    "30",
    "--save",
  ]);

  assert.deepEqual(parsed.values.scope, ["services:read", "logs:read"]);
  assert.equal(parsed.values.name, "ci");
  assert.equal(parsed.values["expires-in"], "30");
  assert.equal(parsed.values.save, true);

  const login = parseCliArgs(["auth", "login", "--password-stdin"]);
  assert.equal(login.values["password-stdin"], true);
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseCliArgs(["services", "list", "--unknown"]),
    UsageError,
  );
});
