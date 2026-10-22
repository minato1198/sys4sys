import { and, eq, inArray } from "drizzle-orm";
import type { MailSettingsInput } from "@sys4sys/shared";
import { sendMail, verifyConnection, type SmtpConfig } from "@sys4sys/mail";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { settings, users } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

const MAIL_SETTINGS_KEY = "mail";

interface StoredMailSettings {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  passwordCipher: string | null;
  from: string;
  recipients: string[];
  mode: "immediate" | "digest5m";
}

export interface EffectiveMailSettings {
  source: "db" | "env";
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
  recipients: string[];
  mode: "immediate" | "digest5m";
}

export interface MailSettingsView {
  configured: boolean;
  source: "db" | "env" | "none";
  host: string;
  port: number;
  secure: boolean;
  username: string;
  from: string;
  recipients: string[];
  mode: "immediate" | "digest5m";
  passwordSet: boolean;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super("SMTP が設定されていません");
    this.name = "MailNotConfiguredError";
  }
}

function splitRecipients(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function fallbackRecipients(): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(eq(users.isActive, true), inArray(users.role, ["admin", "operator"])),
    );
  return rows.map((row) => row.email);
}

async function readStored(): Promise<StoredMailSettings | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, MAIL_SETTINGS_KEY))
    .limit(1);
  if (!row) return null;
  const value = row.value as Partial<StoredMailSettings> | null;
  if (!value || typeof value !== "object") return null;
  if (
    typeof value.host !== "string" ||
    typeof value.from !== "string" ||
    !Array.isArray(value.recipients)
  ) {
    return null;
  }
  return {
    host: value.host,
    port: typeof value.port === "number" ? value.port : 587,
    secure: Boolean(value.secure),
    username: typeof value.username === "string" ? value.username : null,
    passwordCipher:
      typeof value.passwordCipher === "string" ? value.passwordCipher : null,
    from: value.from,
    recipients: value.recipients.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    ),
    mode: value.mode === "digest5m" ? "digest5m" : "immediate",
  };
}

function decryptPassword(stored: StoredMailSettings): string | undefined {
  if (!stored.passwordCipher) return undefined;
  try {
    return decryptSecret(stored.passwordCipher);
  } catch (error) {
    console.warn(
      `[mail] stored SMTP password could not be decrypted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function fromEnv(): EffectiveMailSettings | null {
  const host = config.SMTP_HOST?.trim() ?? "";
  const from = (config.SMTP_FROM ?? config.SMTP_USER ?? "").trim();
  if (!host || !from) return null;
  return {
    source: "env",
    host,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    username: config.SMTP_USER?.trim() || undefined,
    password: config.SMTP_PASS || undefined,
    from,
    recipients: splitRecipients(config.MAIL_RECIPIENTS),
    mode: "immediate",
  };
}

export async function getEffectiveMailSettings(): Promise<EffectiveMailSettings | null> {
  const stored = await readStored();
  if (stored) {
    return {
      source: "db",
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      username: stored.username ?? undefined,
      password: decryptPassword(stored),
      from: stored.from,
      recipients:
        stored.recipients.length > 0
          ? stored.recipients
          : await fallbackRecipients(),
      mode: stored.mode,
    };
  }

  const env = fromEnv();
  if (!env) return null;
  if (env.recipients.length === 0) {
    env.recipients = await fallbackRecipients();
  }
  return env;
}

export async function getMailSettingsView(): Promise<MailSettingsView> {
  const stored = await readStored();
  if (stored) {
    return {
      configured:
        Boolean(stored.host) &&
        Boolean(stored.from) &&
        stored.recipients.length > 0,
      source: "db",
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      username: stored.username ?? "",
      from: stored.from,
      recipients: stored.recipients,
      mode: stored.mode,
      passwordSet: Boolean(stored.passwordCipher),
    };
  }

  const env = fromEnv();
  if (env) {
    const recipients =
      env.recipients.length > 0 ? env.recipients : await fallbackRecipients();
    return {
      configured: recipients.length > 0,
      source: "env",
      host: env.host,
      port: env.port,
      secure: env.secure,
      username: env.username ?? "",
      from: env.from,
      recipients,
      mode: env.mode,
      passwordSet: Boolean(env.password),
    };
  }

  return {
    configured: false,
    source: "none",
    host: "",
    port: 587,
    secure: false,
    username: "",
    from: "",
    recipients: await fallbackRecipients(),
    mode: "immediate",
    passwordSet: false,
  };
}

export interface SaveMailSettingsInput extends MailSettingsInput {
  clearPassword?: boolean;
}

export async function saveMailSettings(
  input: SaveMailSettingsInput,
): Promise<MailSettingsView> {
  const stored = await readStored();
  let passwordCipher = stored?.passwordCipher ?? null;
  if (input.clearPassword) {
    passwordCipher = null;
  } else if (input.password) {
    passwordCipher = encryptSecret(input.password);
  }

  const value: StoredMailSettings = {
    host: input.host,
    port: input.port,
    secure: input.secure,
    username: input.username?.trim() || null,
    passwordCipher,
    from: input.from,
    recipients: input.recipients,
    mode: input.mode,
  };
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: MAIL_SETTINGS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return getMailSettingsView();
}

export async function smtpConfig(): Promise<SmtpConfig> {
  const effective = await getEffectiveMailSettings();
  if (!effective || effective.recipients.length === 0) {
    throw new MailNotConfiguredError();
  }
  return {
    host: effective.host,
    port: effective.port,
    secure: effective.secure,
    username: effective.username,
    password: effective.password,
    from: effective.from,
  };
}

export async function testMailSettings(): Promise<{
  accepted: string[];
  recipients: string[];
}> {
  const effective = await getEffectiveMailSettings();
  if (!effective || effective.recipients.length === 0) {
    throw new MailNotConfiguredError();
  }
  const smtp: SmtpConfig = {
    host: effective.host,
    port: effective.port,
    secure: effective.secure,
    username: effective.username,
    password: effective.password,
    from: effective.from,
  };
  await verifyConnection(smtp);
  const result = await sendMail(smtp, {
    to: effective.recipients,
    subject: "[sys4sys] SMTP test",
    text: [
      "sys4sys からの SMTP テストメールです。",
      "",
      `送信元: ${effective.from}`,
      `送信日時: ${new Date().toISOString()}`,
    ].join("\n"),
  });
  return { accepted: result.accepted, recipients: effective.recipients };
}
