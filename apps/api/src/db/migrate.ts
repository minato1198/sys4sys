import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { db } from "./index.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

migrate(db, { migrationsFolder });
console.log(`migrations applied: ${migrationsFolder}`);
