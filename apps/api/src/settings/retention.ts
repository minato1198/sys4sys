import { eq } from "drizzle-orm";
import type { RetentionSettingsInput } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";

const RETENTION_SETTINGS_KEY = "retention";

export interface RetentionSettingsView {
  logDays: number;
  source: "db" | "env";
  updatedAt: string | null;
}

interface StoredRetentionSettings {
  logDays: number;
}

async function readStored(): Promise<{
  value: StoredRetentionSettings;
  updatedAt: Date;
} | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, RETENTION_SETTINGS_KEY))
    .limit(1);
  if (!row) return null;
  const value = row.value as Partial<StoredRetentionSettings> | null;
  if (!value || typeof value.logDays !== "number") return null;
  return {
    value: {
      logDays: Math.max(1, Math.round(value.logDays)),
    },
    updatedAt: row.updatedAt,
  };
}

export async function getRetentionSettings(): Promise<RetentionSettingsView> {
  const stored = await readStored();
  if (stored) {
    return {
      logDays: stored.value.logDays,
      source: "db",
      updatedAt: stored.updatedAt.toISOString(),
    };
  }
  return {
    logDays: config.LOG_RETENTION_DAYS,
    source: "env",
    updatedAt: null,
  };
}

export async function saveRetentionSettings(
  input: RetentionSettingsInput,
): Promise<RetentionSettingsView> {
  const now = new Date();
  const value: StoredRetentionSettings = { logDays: input.logDays };
  await db
    .insert(settings)
    .values({ key: RETENTION_SETTINGS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return getRetentionSettings();
}

export async function getLogRetentionDays(): Promise<number> {
  return (await getRetentionSettings()).logDays;
}
