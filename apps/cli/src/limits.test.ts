import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CLI_LIMITS } from "./limits.js";

test("documented CLI limits match shared constants", async () => {
  const doc = await readFile(
    new URL("../../../docs/cli/PERFORMANCE.md", import.meta.url),
    "utf8",
  );

  assert.match(
    doc,
    new RegExp(
      `最大 ${CLI_LIMITS.logQueryMaxLimit}、既定 ${CLI_LIMITS.logQueryDefaultLimit}`,
    ),
  );
  assert.match(
    doc,
    new RegExp(`最大 ${CLI_LIMITS.logTailMaxReconnectAttempts} 回`),
  );
  assert.match(
    doc,
    new RegExp(`最大 ${CLI_LIMITS.logTailMaxBackoffMs / 1000} 秒`),
  );
  assert.match(doc, new RegExp(`最大 ${CLI_LIMITS.mcpLogMaxLimit} 行`));
  assert.match(doc, new RegExp(`${CLI_LIMITS.tokenMaxTtlDays} 日`));
  assert.match(
    doc,
    new RegExp(
      `${CLI_LIMITS.deployRequestTtlMinutes / 60} 時間（${CLI_LIMITS.deployRequestTtlMinutes} 分）`,
    ),
  );
});
