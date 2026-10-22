import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { backupDatabaseTo, databasePath } from "./index.js";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * SQLite のオンラインバックアップを作成する。
 * DB と同じディレクトリの backups/ に保存する（WAL 中でも整合性を保つ）。
 */
export async function createDatabaseBackup(): Promise<BackupResult> {
  const backupDir = join(dirname(databasePath), "backups");
  await mkdir(backupDir, { recursive: true });
  const destination = join(backupDir, `sys4sys-${timestamp()}.db`);
  await backupDatabaseTo(destination);
  const info = await stat(destination);
  return {
    path: destination,
    sizeBytes: info.size,
    createdAt: new Date().toISOString(),
  };
}
