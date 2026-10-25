import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./client.js";
import { CliError, UsageError } from "./errors.js";
import { exitCodeFor, printFailure } from "./index.js";
import { memoryOutput } from "./test-output.js";

test("maps HTTP and CLI errors to documented exit codes", () => {
  assert.equal(exitCodeFor(new ApiError(401, "Unauthorized", "")), 3);
  assert.equal(exitCodeFor(new ApiError(403, "Forbidden", "")), 3);
  assert.equal(exitCodeFor(new ApiError(409, "Conflict", "")), 4);
  assert.equal(exitCodeFor(new ApiError(422, "Unprocessable", "")), 2);
  assert.equal(exitCodeFor(new ApiError(500, "Error", "")), 1);
  assert.equal(exitCodeFor(new UsageError("bad")), 2);
  assert.equal(exitCodeFor(new CliError("failed", 5)), 5);
  assert.equal(exitCodeFor(new Error("unexpected")), 1);
});

test("prints requiredScope in human and JSON errors", () => {
  const error = new ApiError(403, "Forbidden", "denied", {
    requiredScope: "services:write",
  });

  const human = memoryOutput();
  printFailure(error, false, human.output);
  assert.match(human.err, /required scope: services:write/);

  const json = memoryOutput();
  printFailure(error, true, json.output);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.error.requiredScope, "services:write");
  assert.equal(parsed.error.status, 403);
});
