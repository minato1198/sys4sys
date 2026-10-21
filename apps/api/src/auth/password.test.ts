import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("hashes with Argon2id and verifies the correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    await expect(
      verifyPassword(hash, "correct horse battery staple"),
    ).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });

  it("uses a unique salt for every hash", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same-password"),
      hashPassword("same-password"),
    ]);

    expect(first).not.toBe(second);
  });
});
