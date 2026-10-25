import assert from "node:assert/strict";
import test from "node:test";
import { UsageError } from "./errors.js";
import {
  parseRelativeDuration,
  parseSince,
  parseUntil,
  toIso,
} from "./time.js";

test("parses relative durations", () => {
  assert.equal(parseRelativeDuration("30s"), 30_000);
  assert.equal(parseRelativeDuration("15m"), 15 * 60_000);
  assert.equal(parseRelativeDuration("2h"), 2 * 60 * 60_000);
  assert.equal(parseRelativeDuration("1d"), 24 * 60 * 60_000);
});

test("rejects ambiguous or invalid durations", () => {
  for (const value of ["0m", "m", "-5m", "1w", "1.5h", ""]) {
    assert.throws(() => parseRelativeDuration(value), UsageError);
  }
});

test("converts relative since values using the supplied now", () => {
  const now = new Date("2026-10-24T12:00:00.000Z");
  assert.equal(parseSince("2h", now), "2026-10-24T10:00:00.000Z");
  assert.equal(
    parseSince("2026-10-24T00:00:00Z", now),
    "2026-10-24T00:00:00.000Z",
  );
  assert.equal(parseSince(undefined, now), undefined);
});

test("rejects relative until values and invalid timestamps", () => {
  assert.throws(() => parseUntil("2h"), UsageError);
  assert.throws(() => toIso("not-a-time"), UsageError);
});
