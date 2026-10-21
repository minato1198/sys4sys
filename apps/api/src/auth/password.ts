import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";

/**
 * OWASP 推奨に近い Argon2id パラメータ。
 * memorySize は KiB 単位（19 MiB）。
 */
const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19_456,
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return argon2id({
    password,
    salt,
    ...ARGON2_PARAMS,
    outputType: "encoded",
  });
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * 存在しないメールアドレスでも同等のコストを払い、
 * 応答時間からアカウントの存在を推測されにくくする。
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("sys4sys-dummy-password-not-used");
  const hash = await dummyHash;
  await argon2Verify({ password, hash });
}
