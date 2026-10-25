import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import {
  ROLE_SCOPES,
  isScopeSubsetOf,
  type TokenScope,
  type TokenView,
} from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { apiTokens, users } from "../db/schema.js";
import type { AuthUser } from "./types.js";

const TOKEN_PREFIX = "s4s_";
const TOKEN_PATTERN = /^s4s_[A-Za-z0-9_-]{43}$/;
const LAST_USED_UPDATE_MS = 60_000;

export interface CreateTokenInput {
  userId: string;
  name: string;
  scopes: TokenScope[];
  expiresInDays: number;
}

export interface CreatedToken {
  view: TokenView;
  token: string;
}

export interface VerifiedToken {
  tokenId: string;
  userId: string;
  user: AuthUser;
  name: string;
  prefix: string;
  scopes: TokenScope[];
  expiresAt: Date;
}

type TokenRow = typeof apiTokens.$inferSelect;

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function toView(row: TokenRow): TokenView {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as TokenScope[],
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function createApiToken(
  input: CreateTokenInput,
): Promise<CreatedToken> {
  if (
    input.expiresInDays < 1 ||
    input.expiresInDays > config.TOKEN_MAX_TTL_DAYS
  ) {
    throw new Error(
      `token expiry must be between 1 and ${config.TOKEN_MAX_TTL_DAYS} days`,
    );
  }

  const raw = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000,
  );
  const row: TokenRow = {
    id: `tok_${randomUUID()}`,
    userId: input.userId,
    name: input.name,
    tokenHash: hashToken(raw),
    prefix: raw.slice(0, 8),
    scopes: input.scopes,
    createdAt: now,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
  };

  await db.insert(apiTokens).values(row);
  return { view: toView(row), token: raw };
}

export async function verifyApiToken(
  raw: string,
): Promise<VerifiedToken | null> {
  if (!TOKEN_PATTERN.test(raw)) return null;

  const [row] = await db
    .select({
      token: apiTokens,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(
      and(
        eq(apiTokens.tokenHash, hashToken(raw)),
        isNull(apiTokens.revokedAt),
        gt(apiTokens.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  const scopes = row.token.scopes as TokenScope[];
  if (!isScopeSubsetOf(scopes, ROLE_SCOPES[row.role])) {
    return null;
  }

  const now = new Date();
  if (
    !row.token.lastUsedAt ||
    now.getTime() - row.token.lastUsedAt.getTime() >= LAST_USED_UPDATE_MS
  ) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: now })
      .where(eq(apiTokens.id, row.token.id));
  }

  return {
    tokenId: row.token.id,
    userId: row.userId,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
    },
    name: row.token.name,
    prefix: row.token.prefix,
    scopes,
    expiresAt: row.token.expiresAt,
  };
}

export async function listApiTokens(userId: string): Promise<TokenView[]> {
  const rows = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(apiTokens.createdAt);
  return rows.map(toView);
}

export type ApiTokenWithOwner = TokenView & { userId: string };

export async function getApiToken(
  id: string,
): Promise<ApiTokenWithOwner | null> {
  const [row] = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.id, id))
    .limit(1);
  return row ? { ...toView(row), userId: row.userId } : null;
}

/**
 * 失効は物理削除せず revokedAt を立てる。
 * userId を条件に含めることで、自分以外のトークンを誤って失効させない。
 */
export async function revokeApiToken(
  id: string,
  userId: string,
): Promise<boolean> {
  const result = await db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiTokens.id, id),
        eq(apiTokens.userId, userId),
        isNull(apiTokens.revokedAt),
      ),
    );
  return result.changes > 0;
}

export async function cleanupExpiredTokens(): Promise<number> {
  const result = await db
    .delete(apiTokens)
    .where(lt(apiTokens.expiresAt, new Date()));
  return result.changes;
}
