import { createDatabaseBackup } from "./backup.js";

const result = await createDatabaseBackup();
console.log(`backup created: ${result.path} (${result.sizeBytes} bytes)`);
