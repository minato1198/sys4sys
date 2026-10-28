import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { count } from "drizzle-orm";
import { config } from "../config.js";
import { databasePath, db } from "../db/index.js";
import { users } from "../db/schema.js";
import { hashPassword } from "./password.js";

export interface AdminBootstrapResult {
  created: boolean;
  email: string;
  generatedPasswordFile?: string;
}

/**
 * ユーザーが 1 人もいない場合に初期管理者を作成する。
 * 本番では ADMIN_PASSWORD を必須にする（ランダム生成をログに出さない）。
 */
export async function ensureAdminUser(): Promise<AdminBootstrapResult> {
  const email = config.ADMIN_EMAIL.toLowerCase();
  const [row] = await db.select({ value: count() }).from(users);
  if ((row?.value ?? 0) > 0) {
    return { created: false, email };
  }

  let password = config.ADMIN_PASSWORD;
  let generated = false;

  if (!password) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ADMIN_PASSWORD is required to create the first admin user in production",
      );
    }
    password = randomBytes(12).toString("base64url");
    generated = true;
  }

  const passwordHash = await hashPassword(password);

  await db.insert(users).values({
    id: randomUUID(),
    email,
    name: "Administrator",
    passwordHash,
    role: "admin",
    isActive: true,
    createdAt: new Date(),
  });

  // 生成パスワードはログに出さない。開発環境では DB と同じディレクトリに
  // 制限付きファイルとして保存し、初回ログイン後に削除できるようにする。
  let generatedPasswordFile: string | undefined;
  if (generated) {
    generatedPasswordFile = resolve(
      dirname(databasePath),
      "initial-admin-password.txt",
    );
    await mkdir(dirname(generatedPasswordFile), { recursive: true });
    await writeFile(generatedPasswordFile, `${password}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  return {
    created: true,
    email,
    ...(generatedPasswordFile ? { generatedPasswordFile } : {}),
  };
}
