import { randomBytes, randomUUID } from "node:crypto";
import { count } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { hashPassword } from "./password.js";

export interface AdminBootstrapResult {
  created: boolean;
  email: string;
  generatedPassword?: string;
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

  return {
    created: true,
    email,
    ...(generated ? { generatedPassword: password } : {}),
  };
}
