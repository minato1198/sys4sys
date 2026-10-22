import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./crypto.js";

describe("settings secret encryption", () => {
  it("round-trips a plaintext secret", () => {
    const plain = "smtp-password-123!";
    const encrypted = encryptSecret(plain);
    expect(encrypted).not.toContain(plain);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe(plain);
  });

  it("uses a fresh IV for every encryption", () => {
    const first = encryptSecret("same-value");
    const second = encryptSecret("same-value");
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe("same-value");
    expect(decryptSecret(second)).toBe("same-value");
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptSecret("secret");
    const parts = encrypted.split(":");
    const data = Buffer.from(parts[3]!, "base64");
    data[0] = data[0]! ^ 0xff;
    parts[3] = data.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects malformed payloads", () => {
    expect(() => decryptSecret("not-encrypted")).toThrow();
    expect(() => decryptSecret("v2:a:b:c")).toThrow();
  });
});
