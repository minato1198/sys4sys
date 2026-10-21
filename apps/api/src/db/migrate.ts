import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { db } from "./index.js";

export const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export function migrateDb(): string {
  migrate(db, { migrationsFolder });
  return migrationsFolder;
}
