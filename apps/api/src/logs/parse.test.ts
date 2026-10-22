import { describe, expect, it } from "vitest";
import { detectLevel, fingerprintOf, normalizeLine } from "./parse.js";

describe("detectLevel", () => {
  it("detects fatal, error, warn and debug", () => {
    expect(detectLevel("fatal: database is gone")).toBe("fatal");
    expect(detectLevel("connection failed")).toBe("error");
    expect(detectLevel("warning: deprecated option")).toBe("warn");
    expect(detectLevel("debug: payload", "stdout")).toBe("debug");
  });

  it("defaults stderr to warn and stdout to info", () => {
    expect(detectLevel("listening on 3000", "stdout")).toBe("info");
    expect(detectLevel("listening on 3000", "stderr")).toBe("warn");
  });
});

describe("fingerprintOf", () => {
  it("normalizes numbers and UUIDs", () => {
    const first = fingerprintOf(
      "request 123 failed for 550e8400-e29b-41d4-a716-446655440000",
    );
    const second = fingerprintOf(
      "request 456 failed for 550e8400-e29b-41d4-a716-446655440999",
    );
    expect(first).toBe(second);
  });

  it("keeps different messages different", () => {
    expect(fingerprintOf("database timeout")).not.toBe(
      fingerprintOf("database connected"),
    );
  });
});

describe("normalizeLine", () => {
  it("returns plain text unchanged", () => {
    expect(normalizeLine("hello world", "stdout")).toEqual({
      message: "hello world",
    });
  });

  it("extracts pino JSON logs", () => {
    const parsed = normalizeLine(
      '{"level":50,"msg":"boom","requestId":"abc"}',
      "stdout",
    );
    expect(parsed.message).toBe("boom");
    expect(parsed.level).toBe("error");
    expect(parsed.fields).toMatchObject({ requestId: "abc" });
  });

  it("maps textual warning levels", () => {
    const parsed = normalizeLine(
      '{"level":"warning","message":"slow"}',
      "stdout",
    );
    expect(parsed.level).toBe("warn");
    expect(parsed.message).toBe("slow");
  });

  it("treats malformed JSON as plain text", () => {
    expect(normalizeLine("{not json", "stdout")).toEqual({
      message: "{not json",
    });
  });
});
