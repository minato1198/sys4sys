import { lt } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { logEvents } from "../db/schema.js";

export async function cleanupLogs(): Promise<number> {
  const cutoff = new Date(
    Date.now() - config.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const result = await db
    .delete(logEvents)
    .where(lt(logEvents.ts, cutoff))
    .returning({ id: logEvents.id });
  return result.length;
}

export function startLogRetention(): NodeJS.Timeout {
  const timer = setInterval(
    () => {
      void cleanupLogs().catch((error: unknown) => {
        console.warn(
          `[logs] retention cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    60 * 60 * 1000,
  );
  timer.unref();
  return timer;
}
