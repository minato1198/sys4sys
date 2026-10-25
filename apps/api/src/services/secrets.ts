import { and, eq, gt } from "drizzle-orm";
import type { DeployConfigInput } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { services } from "../db/schema.js";
import {
  decryptValue,
  deriveEncryptionKey,
  encryptValue,
} from "../settings/crypto.js";

export const ENCRYPTED_VALUE_PREFIX = "v1:";
export const SERVICE_ENV_DECRYPTION_ERROR = "秘密値の復号に失敗しました";

export interface EnvMigrationResult {
  servicesChecked: number;
  servicesUpdated: number;
  envValuesEncrypted: number;
  failed: number;
}

type EnvRecord = Record<string, string> | null | undefined;

function serviceEncryptionKey(): Buffer {
  return deriveEncryptionKey(
    config.SECRET_ENCRYPTION_KEY ?? config.SESSION_SECRET,
  );
}

function isEncryptedValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

function plaintextValueCount(env: EnvRecord): number {
  if (!env) return 0;
  return Object.values(env).filter((value) => !isEncryptedValue(value)).length;
}

function encryptEnvValues(env: Record<string, string>): Record<string, string> {
  const key = serviceEncryptionKey();
  return Object.fromEntries(
    Object.entries(env).map(([envKey, value]) => [
      envKey,
      isEncryptedValue(value) ? value : encryptValue(value, key),
    ]),
  );
}

export function encryptServiceEnv(
  env: EnvRecord,
): Record<string, string> | null {
  if (!env) return null;
  return encryptEnvValues(env);
}

export function encryptServiceDeploy(
  deploy: DeployConfigInput | null | undefined,
): DeployConfigInput | null | undefined {
  if (!deploy) return deploy ?? null;
  if (
    !Object.hasOwn(deploy, "env") ||
    deploy.env === undefined ||
    deploy.env === null
  ) {
    return deploy;
  }
  return {
    ...deploy,
    env: encryptEnvValues(deploy.env),
  };
}

export function decryptServiceEnv(
  env: EnvRecord,
): Record<string, string> | null {
  if (!env) return null;
  const key = serviceEncryptionKey();
  try {
    return Object.fromEntries(
      Object.entries(env).map(([envKey, value]) => [
        envKey,
        isEncryptedValue(value) ? decryptValue(value, key) : value,
      ]),
    );
  } catch {
    throw new Error(SERVICE_ENV_DECRYPTION_ERROR);
  }
}

export function decryptServiceDeployEnv(
  deploy: DeployConfigInput | null | undefined,
): Record<string, string> | null {
  return decryptServiceEnv(deploy?.env);
}

function deployEnvNeedsEncryption(
  deploy: DeployConfigInput | null | undefined,
): boolean {
  return plaintextValueCount(deploy?.env) > 0;
}

export async function migratePlaintextServiceEnv(
  options: {
    batchSize?: number;
  } = {},
): Promise<EnvMigrationResult> {
  const batchSize = Math.max(1, options.batchSize ?? 100);
  const result: EnvMigrationResult = {
    servicesChecked: 0,
    servicesUpdated: 0,
    envValuesEncrypted: 0,
    failed: 0,
  };
  let after = "";

  while (true) {
    const rows = await db
      .select({
        id: services.id,
        env: services.env,
        deploy: services.deploy,
      })
      .from(services)
      .where(gt(services.id, after))
      .orderBy(services.id)
      .limit(batchSize);

    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;

    for (const row of rows) {
      result.servicesChecked += 1;
      const plaintextCount =
        plaintextValueCount(row.env) + plaintextValueCount(row.deploy?.env);
      if (plaintextCount === 0) continue;

      try {
        const updates: Partial<typeof services.$inferInsert> = {};
        if (row.env && plaintextValueCount(row.env) > 0) {
          updates.env = encryptServiceEnv(row.env);
        }
        if (deployEnvNeedsEncryption(row.deploy)) {
          const deploy = row.deploy!;
          updates.deploy = {
            ...deploy,
            env: encryptEnvValues(deploy.env!),
          };
        }
        if (Object.keys(updates).length === 0) continue;

        updates.updatedAt = new Date();
        await db
          .update(services)
          .set(updates)
          .where(and(eq(services.id, row.id)));
        result.servicesUpdated += 1;
        result.envValuesEncrypted += plaintextCount;
      } catch {
        result.failed += 1;
      }
    }

    if (rows.length < batchSize) break;
  }

  return result;
}
