import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CLI_NAME, CLI_VERSION, versionInfo } from "./version.js";

test("CLI version matches package.json", async () => {
  const raw = await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  );
  const pkg = JSON.parse(raw) as {
    name: string;
    version: string;
    private: boolean;
  };
  assert.equal(CLI_NAME, "sys4sys");
  assert.equal(CLI_VERSION, pkg.version);
  assert.equal(pkg.name, "sys4sys");
  assert.equal(pkg.private, false);
});

test("version info contains no secrets", () => {
  const info = versionInfo();
  assert.equal(info.name, "sys4sys");
  assert.equal(info.version, CLI_VERSION);
  assert.ok(info.node.length > 0);
  assert.ok(info.platform.length > 0);
  assert.doesNotMatch(JSON.stringify(info), /s4s_/);
});
