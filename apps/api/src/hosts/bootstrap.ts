import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts } from "../db/schema.js";

/**
 * Windows ホストは常に 1 つ存在する前提で扱う。
 * WSL は検出結果から明示的に登録する（勝手に増やさない）。
 */
export async function ensureDefaultHosts(): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.kind, "windows"))
    .limit(1);
  if (existing) return false;

  await db.insert(hosts).values({
    id: "windows",
    kind: "windows",
    name: "Windows",
    distro: null,
    defaultUser: null,
    enabled: true,
  });
  return true;
}
