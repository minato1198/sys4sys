import { describe, expect, it } from "vitest";
import { signKillToken, verifyKillToken } from "./confirm-token.js";

describe("kill confirmation token", () => {
  it("round-trips a signed payload", () => {
    const signed = signKillToken({
      scope: "windows",
      pidScope: null,
      port: 3000,
      pid: 1234,
      startedAt: "2026-10-21T00:00:00.000Z",
    });
    const payload = verifyKillToken(signed.token);

    expect(payload).toMatchObject({
      scope: "windows",
      pidScope: null,
      port: 3000,
      pid: 1234,
      startedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(payload?.exp).toBe(signed.expiresAt.getTime());
  });

  it("rejects a tampered token", () => {
    const signed = signKillToken({
      scope: "wsl",
      pidScope: "Ubuntu",
      port: 8787,
      pid: 42,
      startedAt: null,
    });
    const [data, signature] = signed.token.split(".");
    expect(data && signature).toBeTruthy();
    const tampered = `${data}.${signature?.slice(0, -1)}x`;

    expect(verifyKillToken(tampered)).toBeNull();
  });

  it("rejects an expired token", () => {
    const signed = signKillToken(
      {
        scope: "windows",
        pidScope: null,
        port: 3000,
        pid: 1234,
        startedAt: "2026-10-21T00:00:00.000Z",
      },
      -1,
    );

    expect(verifyKillToken(signed.token)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyKillToken("")).toBeNull();
    expect(verifyKillToken("not-a-token")).toBeNull();
    expect(verifyKillToken("a.b.c")).toBeNull();
  });
});
