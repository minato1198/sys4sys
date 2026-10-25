import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import type { DeployConfigInput, DeployRequestSnapshot } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { deployRequests } from "../db/schema.js";
import { ServiceError } from "./manager.js";
import { decryptServiceEnv, SERVICE_ENV_DECRYPTION_ERROR } from "./secrets.js";
import type { ServiceRow } from "./manager.js";

export type DeployRequestRow = typeof deployRequests.$inferSelect;

function stableEnvJson(env: Record<string, string> | null | undefined): string {
  const sorted = Object.entries(env ?? {})
    .sort(([a], [b]) => a.localeCompare(b, "en"))
    .reduce<Record<string, string>>((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

export function hashEnv(
  env: Record<string, string> | null | undefined,
): string {
  return createHash("sha256").update(stableEnvJson(env)).digest("hex");
}

export function requiresDeployApproval(
  deploy: DeployConfigInput | null | undefined,
): boolean {
  return deploy?.requireApproval === true;
}

function canonicalSnapshot(snapshot: DeployRequestSnapshot): string {
  return JSON.stringify({
    command: snapshot.command,
    cwd: snapshot.cwd ?? null,
    timeoutSec: snapshot.timeoutSec,
    restartAfter: snapshot.restartAfter,
    healthTimeoutSec: snapshot.healthTimeoutSec,
    envHash: snapshot.envHash,
    deployEnvHash: snapshot.deployEnvHash,
  });
}

export function snapshotsEqual(
  a: DeployRequestSnapshot,
  b: DeployRequestSnapshot,
): boolean {
  return canonicalSnapshot(a) === canonicalSnapshot(b);
}

export function buildDeployRequestSnapshot(
  service: ServiceRow,
  deploy: DeployConfigInput,
): DeployRequestSnapshot {
  let serviceEnv: Record<string, string> | null;
  let deployEnv: Record<string, string> | undefined;
  try {
    serviceEnv = decryptServiceEnv(service.env) ?? null;
    deployEnv = decryptServiceEnv(deploy.env) ?? undefined;
  } catch {
    throw new ServiceError(500, SERVICE_ENV_DECRYPTION_ERROR);
  }

  return {
    command: deploy.command,
    cwd: deploy.cwd ?? service.cwd ?? null,
    timeoutSec: deploy.timeoutSec,
    restartAfter: deploy.restartAfter,
    healthTimeoutSec: deploy.healthTimeoutSec,
    envHash: hashEnv(serviceEnv),
    deployEnvHash: hashEnv(deployEnv),
  };
}

export async function expirePendingDeployRequests(
  serviceId?: string,
): Promise<number> {
  const conditions = [
    eq(deployRequests.status, "pending"),
    lt(deployRequests.expiresAt, new Date()),
  ];
  if (serviceId) conditions.push(eq(deployRequests.serviceId, serviceId));

  const rows = await db
    .update(deployRequests)
    .set({ status: "expired" })
    .where(and(...conditions))
    .returning({ id: deployRequests.id });
  return rows.length;
}

export async function findPendingDeployRequest(
  serviceId: string,
): Promise<DeployRequestRow | null> {
  const [row] = await db
    .select()
    .from(deployRequests)
    .where(
      and(
        eq(deployRequests.serviceId, serviceId),
        eq(deployRequests.status, "pending"),
      ),
    )
    .orderBy(deployRequests.requestedAt)
    .limit(1);
  return row ?? null;
}

export function deployRequestExpiresAt(): Date {
  return new Date(Date.now() + config.DEPLOY_REQUEST_TTL_MINUTES * 60_000);
}

export async function approvePendingDeployRequestAtomically(
  id: string,
  actorEmail: string,
  note: string | null,
): Promise<DeployRequestRow | null> {
  const [updated] = await db
    .update(deployRequests)
    .set({
      status: "approved",
      decidedBy: actorEmail,
      decidedAt: new Date(),
      note,
    })
    .where(
      and(
        eq(deployRequests.id, id),
        eq(deployRequests.status, "pending"),
        gt(deployRequests.expiresAt, new Date()),
      ),
    )
    .returning();
  return updated ?? null;
}
