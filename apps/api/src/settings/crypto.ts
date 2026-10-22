import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { config } from "../config.js";

/**
 * 設定値の秘密情報（SMTP パスワードなど）を AES-256-GCM で暗号化する。
 * 鍵は SESSION_SECRET から導出する。SESSION_SECRET を変更すると復号できない。
 */
function encryptionKey(): Buffer {
  return createHash("sha256").update(config.SESSION_SECRET).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
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

export function decryptSecret(payload: string): string {
  const [version, ivText, tagText, dataText] = payload.split(":");
  if (version !== "v1" || !ivText || !tagText || !dataText) {
    throw new Error("暗号化された秘密情報の形式が不正です");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
