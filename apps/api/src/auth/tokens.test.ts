import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenScope } from "@sys4sys/shared";

type TokensModule = typeof import("./tokens.js");
type DbModule = typeof import("../db/index.js");
type SchemaModule = typeof import("../db/schema.js");

let tempDir: string;
let tokens: TokensModule;
let db: DbModule["db"];
let schema: SchemaModule;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-tokens-"));
  process.env.DATABASE_URL = join(tempDir, "tokens.db");

  const migrate = await import("../db/migrate.js");
  migrate.migrateDb();
  db = (await import("../db/index.js")).db;
  schema = await import("../db/schema.js");
  tokens = await import("./tokens.js");
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

async function createUser(role: "admin" | "operator" | "viewer" = "admin") {
  const id = `usr_${randomUUID()}`;
  await db.insert(schema.users).values({
    id,
    email: `${id}@example.local`,
    name: "Test User",
    passwordHash: "not-used",
    role,
    isActive: true,
    createdAt: new Date(),
  });
  return id;
}

async function issue(userId: string, scopes: TokenScope[] = ["services:read"]) {
  return tokens.createApiToken({
    userId,
    name: "test-token",
    scopes,
    expiresInDays: 30,
  });
}

describe("api token service", () => {
  it("issues a token that verifies and never stores the raw value", async () => {
    const userId = await createUser();
    const created = await issue(userId);

    expect(created.token.startsWith("s4s_")).toBe(true);
    expect(created.token).toHaveLength(47);
    expect(created.view.prefix).toBe(created.token.slice(0, 8));

    const verified = await tokens.verifyApiToken(created.token);
    expect(verified?.userId).toBe(userId);
    expect(verified?.user.role).toBe("admin");
    expect(verified?.scopes).toEqual(["services:read"]);

    const rows = await db.select().from(schema.apiTokens);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(created.token);
    expect(rows.some((row) => row.tokenHash === created.token)).toBe(false);
  });

  it("lists views without token hashes", async () => {
    const userId = await createUser();
    const created = await issue(userId, ["services:read", "logs:read"]);

    const list = await tokens.listApiTokens(userId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.view.id,
      name: "test-token",
      prefix: created.view.prefix,
      scopes: ["services:read", "logs:read"],
    });
    expect(JSON.stringify(list)).not.toContain("tokenHash");
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it("returns null after revocation", async () => {
    const userId = await createUser();
    const created = await issue(userId);

    expect(await tokens.verifyApiToken(created.token)).not.toBeNull();
    expect(await tokens.revokeApiToken(created.view.id, userId)).toBe(true);
    expect(await tokens.verifyApiToken(created.token)).toBeNull();
    expect(await tokens.revokeApiToken(created.view.id, userId)).toBe(false);
  });

  it("does not let another user revoke a token", async () => {
    const owner = await createUser();
    const other = await createUser();
    const created = await issue(owner);

    expect(await tokens.revokeApiToken(created.view.id, other)).toBe(false);
    expect(await tokens.verifyApiToken(created.token)).not.toBeNull();
  });

  it("returns null for expired tokens", async () => {
    const userId = await createUser();
    const created = await issue(userId);

    await db
      .update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiTokens.id, created.view.id));

    expect(await tokens.verifyApiToken(created.token)).toBeNull();
  });

  it("returns null when the user is disabled", async () => {
    const userId = await createUser();
    const created = await issue(userId);

    await db
      .update(schema.users)
      .set({ isActive: false })
      .where(eq(schema.users.id, userId));

    expect(await tokens.verifyApiToken(created.token)).toBeNull();
  });

  it("invalidates a token when a role change makes its scopes excessive", async () => {
    const userId = await createUser("admin");
    const created = await issue(userId, ["services:write"]);

    expect(await tokens.verifyApiToken(created.token)).not.toBeNull();
    await db
      .update(schema.users)
      .set({ role: "viewer" })
      .where(eq(schema.users.id, userId));

    expect(await tokens.verifyApiToken(created.token)).toBeNull();
  });

  it("generates unique token strings", async () => {
    const userId = await createUser();
    const raw = new Set<string>();
    for (let index = 0; index < 100; index += 1) {
      const created = await issue(userId);
      raw.add(created.token);
    }
    expect(raw.size).toBe(100);
  });

  it("cleans up expired tokens", async () => {
    const userId = await createUser();
    const created = await issue(userId);
    await db
      .update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.apiTokens.id, created.view.id));

    expect(await tokens.cleanupExpiredTokens()).toBeGreaterThanOrEqual(1);
    expect(await tokens.getApiToken(created.view.id)).toBeNull();
  });
});
