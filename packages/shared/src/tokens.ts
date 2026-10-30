import { z } from "zod";
import { roleSchema, type Role } from "./ports.js";

/**
 * API トークンが持てるスコープ。
 * 追加・変更はこのファイルだけで完結させる。
 */
export const TOKEN_SCOPES = [
  "services:read",
  "services:write",
  "services:operate",
  "services:secrets",
  "deploy:execute",
  "logs:read",
  "logs:manage",
  "incidents:read",
  "incidents:write",
  "approvals:read",
  "approvals:decide",
  "approvals:request",
  "hosts:read",
  "hosts:write",
  "ports:read",
  "ports:operate",
  "reports:read",
  "audit:read",
  "settings:read",
  "settings:write",
  "tokens:manage",
] as const;

export const tokenScopeSchema = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

/**
 * ロールが持てるスコープの上限。
 * トークンはこの集合の部分集合だけを持つ。
 */
export const ROLE_SCOPES: Record<Role, readonly TokenScope[]> = {
  viewer: [
    "services:read",
    "logs:read",
    "incidents:read",
    "approvals:read",
    "hosts:read",
    "ports:read",
    "reports:read",
  ],
  operator: [
    "services:read",
    "services:operate",
    "deploy:execute",
    "logs:read",
    "incidents:read",
    "incidents:write",
    "approvals:read",
    "approvals:decide",
    "approvals:request",
    "hosts:read",
    "ports:read",
    "ports:operate",
    "reports:read",
  ],
  admin: [...TOKEN_SCOPES],
};

export function scopesForRole(role: Role): TokenScope[] {
  return [...ROLE_SCOPES[role]];
}

/**
 * 将来のワイルドカード対応を 1 箇所に集約する。
 * P0 では完全一致のみ。
 */
export function scopeSatisfies(
  granted: TokenScope,
  required: TokenScope,
): boolean {
  return granted === required;
}

export function hasScope(
  granted: readonly TokenScope[],
  required: TokenScope,
): boolean {
  return granted.some((scope) => scopeSatisfies(scope, required));
}

export function hasAllScopes(
  granted: readonly TokenScope[],
  required: readonly TokenScope[],
): boolean {
  return required.every((scope) => hasScope(granted, scope));
}

export function hasAnyScope(
  granted: readonly TokenScope[],
  required: readonly TokenScope[],
): boolean {
  return required.some((scope) => hasScope(granted, scope));
}

export function isScopeSubsetOf(
  requested: readonly TokenScope[],
  allowed: readonly TokenScope[],
): boolean {
  return requested.every((scope) => hasScope(allowed, scope));
}

export function isScopeSubset(
  requested: readonly TokenScope[],
  role: Role,
): boolean {
  return isScopeSubsetOf(requested, ROLE_SCOPES[role]);
}

export function intersectScopes(
  requested: readonly TokenScope[],
  allowed: readonly TokenScope[],
): TokenScope[] {
  const seen = new Set<TokenScope>();
  return requested.filter((scope) => {
    if (!hasScope(allowed, scope) || seen.has(scope)) return false;
    seen.add(scope);
    return true;
  });
}

export const tokenCreateSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(tokenScopeSchema).min(1),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  userId: z.string().min(1).optional(),
});
export type TokenCreateInput = z.infer<typeof tokenCreateSchema>;

export const tokenListQuerySchema = z.object({
  userId: z.string().min(1).optional(),
});
export type TokenListQuery = z.infer<typeof tokenListQuerySchema>;

export const tokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(tokenScopeSchema),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
export type TokenView = z.infer<typeof tokenViewSchema>;

export const tokenCreatedSchema = tokenViewSchema.extend({
  token: z.string(),
});
export type TokenCreated = z.infer<typeof tokenCreatedSchema>;

export const authMethodSchema = z.enum(["session", "token"]);
export type AuthMethod = z.infer<typeof authMethodSchema>;

export const authTokenInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
});
export type AuthTokenInfo = z.infer<typeof authTokenInfoSchema>;

export const authMeSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  authMethod: authMethodSchema,
  scopes: z.array(tokenScopeSchema),
  token: authTokenInfoSchema.optional(),
});
export type AuthMe = z.infer<typeof authMeSchema>;
