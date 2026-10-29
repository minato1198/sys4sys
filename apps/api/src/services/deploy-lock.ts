import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { actions } from "../db/schema.js";

const localDeploys = new Set<string>();

export function isLocalDeployRunning(serviceId: string): boolean {
  return localDeploys.has(serviceId);
}

export function tryReserveLocalDeploy(serviceId: string): boolean {
  if (localDeploys.has(serviceId)) return false;
  localDeploys.add(serviceId);
  return true;
}

export function releaseLocalDeploy(serviceId: string): void {
  localDeploys.delete(serviceId);
}

/** DB の deploy action と同一 API プロセス内の実行状態をまとめて確認する。 */
export async function hasRunningDeploy(serviceId: string): Promise<boolean> {
  if (localDeploys.has(serviceId)) return true;
  const [row] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.serviceId, serviceId),
        eq(actions.type, "deploy"),
        inArray(actions.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return Boolean(row);
}
