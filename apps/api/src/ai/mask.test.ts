import { describe, expect, it } from "vitest";
import { maskText, truncateLine } from "./mask.js";

describe("AI masking", () => {
  it("masks bearer tokens and api keys", () => {
    const masked = maskText(
      "Authorization: Bearer abcdefghijklmnop123456\napi_key=sk-1234567890abcdefghij",
    );
    expect(masked).not.toContain("abcdefghijklmnop123456");
    expect(masked).not.toContain("sk-1234567890abcdefghij");
    expect(masked).toContain("***");
  });

  it("masks database credentials but keeps the scheme", () => {
    const masked = maskText("postgres://app:s3cret@db.internal:5432/app");
    expect(masked).toContain("postgres://***:***@");
    expect(masked).not.toContain("s3cret");
  });

  it("masks password assignments in logs", () => {
    expect(maskText("DB_PASSWORD=hunter2")).toBe("DB_PASSWORD=***");
    expect(maskText('password: "hunter2"')).toBe("password: ***");
    expect(maskText("token=abcd1234")).toBe("token=***");
  });

  it("masks private key blocks and JWTs", () => {
    const masked = maskText(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123",
    );
    expect(masked).toContain("[REDACTED PRIVATE KEY]");
    expect(masked).toContain("[REDACTED JWT]");
    expect(masked).not.toContain("MIIE");
  });

  it("truncates long lines", () => {
    expect(truncateLine("abcdef", 4)).toBe("abc…");
    expect(truncateLine("abc", 4)).toBe("abc");
  });
});
