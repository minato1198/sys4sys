import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS,
  commandNames,
  commandsInGroup,
  resolveCommand,
  validateRegistry,
} from "./registry.js";
import { formatHelp } from "../help.js";

test("registry has unique, complete definitions", () => {
  const names = commandNames();
  assert.equal(new Set(names).size, names.length);
  for (const command of COMMANDS) {
    assert.ok(command.summary.length > 0, command.name);
    assert.ok(command.examples.length > 0, command.name);
    assert.ok(["P0", "P1", "P2"].includes(command.phase), command.name);
  }
  assert.doesNotThrow(() => validateRegistry(COMMANDS));
});

test("registry resolves two-word commands and preserves rest", () => {
  const resolved = resolveCommand(["services", "get", "svc-1"]);
  assert.equal(resolved?.command.name, "services get");
  assert.deepEqual(resolved?.rest, ["svc-1"]);

  const whoami = resolveCommand(["whoami"]);
  assert.equal(whoami?.command.name, "whoami");
  assert.deepEqual(whoami?.rest, []);
});

test("registry groups commands", () => {
  assert.deepEqual(
    commandsInGroup("auth").map((command) => command.name),
    ["auth login", "auth logout", "auth status"],
  );
});

test("help includes existing and P0 commands", () => {
  const help = formatHelp();
  for (const name of [
    "whoami",
    "hosts list",
    "services list",
    "services get",
    "services create",
    "services update",
    "services deploy",
    "auth login",
    "tokens create",
    "logs query",
    "logs tail",
    "schema",
  ]) {
    assert.ok(help.includes(name), name);
  }
});

test("command help includes options and examples", () => {
  const help = formatHelp("services deploy");
  assert.match(help, /--yes/);
  assert.match(help, /--wait/);
  assert.match(help, /--timeout/);
  assert.match(help, /sys4sys services deploy <id>/);
});

test("unknown command help is explicit", () => {
  assert.match(formatHelp("not a command"), /不明なコマンド/);
});
