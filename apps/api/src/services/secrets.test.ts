import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

let tempDir: string;
let db: any;
let services: any;
let secrets: any;

function tamperCiphertext(payload: string): string {
  const parts = payload.split(":");
  const data = Buffer.from(parts[3]!, "base64");
  data[0] = data[0]! ^ 0xff;
  parts[3] = data.toString("base64");
  return parts.join(":");
}

async function insertService(
  name: string,
  env: Record<string, string> | null,
  deployEnv: Record<string, string> | null,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.insert(services).values({
    id,
    hostId: "host-secrets-test",
    name,
    command: ["node", "server.js"],
    env,
    deploy: deployEnv
      ? {
          command: ["node", "deploy.js"],
          timeoutSec: 600,
          restartAfter: true,
          healthTimeoutSec: 120,
          env: deployEnv,
        }
      : null,
    createdAt: now,
    updatedAt: now,
    isActive: true,
  });
  return id;
}

async function selectService(id: string) {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, id))
    .limit(1);
  return row;
}

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-secrets-"));
  process.env.DATABASE_URL = join(tempDir, "secrets.db");
  process.env.SESSION_SECRET = "unit-secret-key-0123456789abcdef";
  process.env.LOG_LEVEL = "silent";

  const migrateModule = await import("../db/migrate.js");
  migrateModule.migrateDb();

  secrets = await import("./secrets.js");
  db = (await import("../db/index.js")).db;
  services = (await import("../db/schema.js")).services;
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("service env secret storage", () => {
  it("encrypts env values and decrypts them for runtime use", () => {
    const encrypted: Record<string, string> = secrets.encryptServiceEnv({
      DATABASE_URL: "secret-value",
      EMPTY: "",
    });

    expect(Object.keys(encrypted)).toEqual(["DATABASE_URL", "EMPTY"]);
    expect(
      Object.values(encrypted).every((value) => value.startsWith("v1:")),
    ).toBe(true);
    expect(
      Object.values(encrypted).every(
        (value) => !value.includes("secret-value"),
      ),
    ).toBe(true);
    expect(secrets.decryptServiceEnv(encrypted)).toEqual({
      DATABASE_URL: "secret-value",
      EMPTY: "",
    });
  });

  it("uses a fresh IV for each encryption call", () => {
    const first: { TOKEN: string } = secrets.encryptServiceEnv({
      TOKEN: "same-plaintext",
    });
    const second: { TOKEN: string } = secrets.encryptServiceEnv({
      TOKEN: "same-plaintext",
    });

    expect(first.TOKEN).not.toBe(second.TOKEN);
    expect(first.TOKEN.startsWith("v1:")).toBe(true);
    expect(second.TOKEN.startsWith("v1:")).toBe(true);
    expect(secrets.decryptServiceEnv(first)).toEqual({
      TOKEN: "same-plaintext",
    });
    expect(secrets.decryptServiceEnv(second)).toEqual({
      TOKEN: "same-plaintext",
    });
  });

  it("does not double-encrypt values already marked as encrypted", () => {
    const alreadyEncrypted = "v1:not-really-encrypted";
    const encrypted: Record<string, string> = secrets.encryptServiceEnv({
      TOKEN: alreadyEncrypted,
    });
    expect(encrypted).toEqual({ TOKEN: alreadyEncrypted });
  });

  it("rejects tampered ciphertext without exposing plaintext", () => {
    const encrypted: { TOKEN: string } = secrets.encryptServiceEnv({
      TOKEN: "plaintext-secret",
    });
    const tampered = tamperCiphertext(encrypted.TOKEN);

    expect(() => secrets.decryptServiceEnv({ TOKEN: tampered })).toThrow(
      secrets.SERVICE_ENV_DECRYPTION_ERROR,
    );
    expect(() => secrets.decryptServiceEnv({ TOKEN: tampered })).not.toThrow(
      "plaintext-secret",
    );
  });

  it("encrypts deploy env values with the same envelope", () => {
    const encryptedDeploy: Record<string, any> = secrets.encryptServiceDeploy({
      command: ["node", "deploy.js"],
      timeoutSec: 600,
      restartAfter: true,
      healthTimeoutSec: 120,
      env: { DEPLOY_TOKEN: "deploy-secret" },
    });

    expect(encryptedDeploy.env.DEPLOY_TOKEN.startsWith("v1:")).toBe(true);
    expect(encryptedDeploy.env.DEPLOY_TOKEN).not.toContain("deploy-secret");
    expect(secrets.decryptServiceDeployEnv(encryptedDeploy)).toEqual({
      DEPLOY_TOKEN: "deploy-secret",
    });
  });

  it("omits deploy.env encryption when the deploy object has no env property", () => {
    const deploy = {
      command: ["node", "deploy.js"],
      timeoutSec: 600,
      restartAfter: true,
      healthTimeoutSec: 120,
    } as const;
    const encrypted = secrets.encryptServiceDeploy(deploy);
    expect(Object.hasOwn(encrypted, "env")).toBe(false);
  });

  it("migrates existing plaintext env values idempotently", async () => {
    const id = await insertService(
      "plaintext-secret-service",
      { DATABASE_URL: "migrate-me" },
      { DEPLOY_TOKEN: "migrate-deploy-me" },
    );

    const first = await secrets.migratePlaintextServiceEnv();
    expect(first.failed).toBe(0);
    expect(first.envValuesEncrypted).toBeGreaterThanOrEqual(2);

    let row = await selectService(id);
    expect(row.env.DATABASE_URL.startsWith("v1:")).toBe(true);
    expect(row.deploy.env.DEPLOY_TOKEN.startsWith("v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain("migrate-me");
    expect(JSON.stringify(row)).not.toContain("migrate-deploy-me");
    expect(secrets.decryptServiceEnv(row.env)).toEqual({
      DATABASE_URL: "migrate-me",
    });
    expect(secrets.decryptServiceDeployEnv(row.deploy)).toEqual({
      DEPLOY_TOKEN: "migrate-deploy-me",
    });

    const second = await secrets.migratePlaintextServiceEnv();
    expect(second.failed).toBe(0);
    expect(second.servicesUpdated).toBe(0);
    expect(second.envValuesEncrypted).toBe(0);

    row = await selectService(id);
    expect(row.env.DATABASE_URL.startsWith("v1:")).toBe(true);
    expect(row.deploy.env.DEPLOY_TOKEN.startsWith("v1:")).toBe(true);
  });
});
