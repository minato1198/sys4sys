import { migrateDb } from "./migrate.js";

console.log(`migrations applied: ${migrateDb()}`);
