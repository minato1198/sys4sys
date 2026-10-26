import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { COMMANDS } from "./registry.js";
import {
  COMPLETION_SHELLS,
  completionScript,
  completionVocabulary,
  isCompletionShell,
} from "./completions.js";

test("generates scripts for every supported shell", () => {
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    assert.ok(script.length > 100, shell);
    assert.match(script, /sys4sys/, shell);
  }
  assert.deepEqual(COMPLETION_SHELLS, ["bash", "zsh", "fish", "powershell"]);
  assert.equal(isCompletionShell("bash"), true);
  assert.equal(isCompletionShell("cmd"), false);
});

test("completion scripts contain every command and key option", () => {
  const vocabulary = completionVocabulary();
  assert.deepEqual(
    vocabulary.commands,
    COMMANDS.map((command) => command.name),
  );
  for (const shell of COMPLETION_SHELLS) {
    const script = completionScript(shell);
    for (const name of vocabulary.commands) {
      if (shell === "fish") {
        // fish はトークン単位なので、完全名はコメントで保持する。
        assert.match(
          script,
          new RegExp(
            `commands:.*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          ),
        );
      } else {
        assert.ok(script.includes(name), `${shell} missing ${name}`);
      }
    }
    for (const option of [
      "--api",
      "--json",
      "--allow-write",
      "--strict",
      "--transport",
    ]) {
      assert.ok(script.includes(option), `${shell} missing ${option}`);
    }
  }
});

test("bash completion is valid shell syntax when bash is available", (t) => {
  const script = completionScript("bash");
  const result = spawnSync("bash", ["-n"], {
    input: script,
    encoding: "utf8",
  });
  if (
    result.error &&
    (result.error as NodeJS.ErrnoException).code === "ENOENT"
  ) {
    t.skip("bash is not installed");
    return;
  }
  assert.equal(result.status, 0, result.stderr);
});

test("rejects unsupported shells", () => {
  assert.throws(() => completionScript("cmd"));
});
