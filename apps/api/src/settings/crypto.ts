import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "../config.js";

/**
 * 秘密情報を AES-256-GCM で暗号化する。
 * 既定の鍵は SESSION_SECRET から導出する。SESSION_SECRET を変更すると復号できない。
 * サービス env 用には SECRET_ENCRYPTION_KEY 派生の鍵を明示的に渡す。
 */
export function deriveEncryptionKey(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

function settingsEncryptionKey(): Buffer {
  return deriveEncryptionKey(config.SESSION_SECRET);
}

export function encryptValue(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decryptValue(payload: string, key: Buffer): string {
  const parts = payload.split(":");
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    !parts[1] ||
    !parts[2] ||
    parts[3] === undefined
  ) {
    throw new Error("暗号化された秘密情報の形式が不正です");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parts[1], "base64"),
  );
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function encryptSecret(plain: string): string {
  return encryptValue(plain, settingsEncryptionKey());
}

export function decryptSecret(payload: string): string {
  return decryptValue(payload, settingsEncryptionKey());
}
