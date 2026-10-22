import { and, eq, gte } from "drizzle-orm";
import { OpenAiCompatibleClient } from "@sys4sys/ai";
import type { AiSettingsInput } from "@sys4sys/shared";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { aiAnalyses, settings } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

const AI_SETTINGS_KEY = "ai";
const AI_PROVIDER = "openai-compatible";

interface StoredAiSettings {
  baseUrl: string;
  model: string;
  apiKeyCipher: string | null;
  maxInputTokens: number;
  temperature: number;
  timeoutSec: number;
  dailyRequestLimit: number;
  sendLogsExternally: boolean;
}

export interface EffectiveAiSettings {
  source: "db" | "env";
  provider: typeof AI_PROVIDER;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxInputTokens: number;
  temperature: number;
  timeoutSec: number;
  dailyRequestLimit: number;
  sendLogsExternally: boolean;
}

export interface AiSettingsView {
  configured: boolean;
  source: "db" | "env" | "none";
  provider: typeof AI_PROVIDER;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  maxInputTokens: number;
  temperature: number;
  timeoutSec: number;
  dailyRequestLimit: number;
  dailyUsed: number;
  sendLogsExternally: boolean;
  localEndpoint: boolean;
  externalLogsAllowed: boolean;
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super("AI プロバイダが設定されていません");
    this.name = "AiNotConfiguredError";
  }
}

function todayStart(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

async function usedToday(): Promise<number> {
  const rows = await db
    .select({ id: aiAnalyses.id })
    .from(aiAnalyses)
    .where(
      and(
        gte(aiAnalyses.createdAt, todayStart()),
        eq(aiAnalyses.provider, AI_PROVIDER),
      ),
    );
  return rows.filter((row) => row.id).length;
}

/**
 * ローカル / プライベートネットワーク上の OpenAI 互換 API か。
 * 外部送信の既定禁止を「どの宛先なら安全か」で判定するために使う。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  // Node は IPv6 を [::1] の形で返す。ブラケットを外してから判定する。
  hostname = hostname.replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    hostname === "::ffff:127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "host.docker.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const [first = 0, second = 0] = hostname.split(".").map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }

  // ULA (fc00::/7) とリンクローカル (fe80::/10)。
  if (
    hostname.includes(":") &&
    (hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe8") ||
      hostname.startsWith("fe9") ||
      hostname.startsWith("fea") ||
      hostname.startsWith("feb"))
  ) {
    return true;
  }

  // Docker Compose / LAN の短いホスト名（例: ollama, lmstudio）。
  if (!hostname.includes(".") && !hostname.includes(":")) return true;
  return false;
}

export function externalLogsAllowed(settings: EffectiveAiSettings): boolean {
  return isLocalEndpoint(settings.baseUrl) || settings.sendLogsExternally;
}

async function readStored(): Promise<StoredAiSettings | null> {
  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, AI_SETTINGS_KEY))
    .limit(1);
  if (!row) return null;
  const value = row.value as Partial<StoredAiSettings> | null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.baseUrl !== "string" || typeof value.model !== "string") {
    return null;
  }
  return {
    baseUrl: value.baseUrl,
    model: value.model,
    apiKeyCipher:
      typeof value.apiKeyCipher === "string" ? value.apiKeyCipher : null,
    maxInputTokens:
      typeof value.maxInputTokens === "number"
        ? value.maxInputTokens
        : config.AI_MAX_INPUT_TOKENS,
    temperature:
      typeof value.temperature === "number"
        ? value.temperature
        : config.AI_TEMPERATURE,
    timeoutSec:
      typeof value.timeoutSec === "number"
        ? value.timeoutSec
        : config.AI_TIMEOUT_SEC,
    dailyRequestLimit:
      typeof value.dailyRequestLimit === "number"
        ? value.dailyRequestLimit
        : config.AI_DAILY_LIMIT,
    sendLogsExternally: Boolean(value.sendLogsExternally),
  };
}

function decryptApiKey(stored: StoredAiSettings): string | undefined {
  if (!stored.apiKeyCipher) return undefined;
  try {
    return decryptSecret(stored.apiKeyCipher);
  } catch (error) {
    console.warn(
      `[ai] stored API key could not be decrypted: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function fromEnv(): EffectiveAiSettings | null {
  const model = config.AI_MODEL.trim();
  if (!model) return null;
  return {
    source: "env",
    provider: AI_PROVIDER,
    baseUrl: config.AI_BASE_URL,
    model,
    apiKey: config.AI_API_KEY || undefined,
    maxInputTokens: config.AI_MAX_INPUT_TOKENS,
    temperature: config.AI_TEMPERATURE,
    timeoutSec: config.AI_TIMEOUT_SEC,
    dailyRequestLimit: config.AI_DAILY_LIMIT,
    sendLogsExternally: config.AI_SEND_LOGS_EXTERNALLY,
  };
}

export async function getEffectiveAiSettings(): Promise<EffectiveAiSettings | null> {
  const stored = await readStored();
  if (stored) {
    return {
      source: "db",
      provider: AI_PROVIDER,
      baseUrl: stored.baseUrl,
      model: stored.model,
      apiKey: decryptApiKey(stored),
      maxInputTokens: stored.maxInputTokens,
      temperature: stored.temperature,
      timeoutSec: stored.timeoutSec,
      dailyRequestLimit: stored.dailyRequestLimit,
      sendLogsExternally: stored.sendLogsExternally,
    };
  }
  return fromEnv();
}

export async function getAiSettingsView(): Promise<AiSettingsView> {
  const effective = await getEffectiveAiSettings();
  const used = await usedToday();

  if (effective) {
    return {
      configured: Boolean(effective.baseUrl && effective.model),
      source: effective.source,
      provider: effective.provider,
      baseUrl: effective.baseUrl,
      model: effective.model,
      apiKeySet: Boolean(effective.apiKey),
      maxInputTokens: effective.maxInputTokens,
      temperature: effective.temperature,
      timeoutSec: effective.timeoutSec,
      dailyRequestLimit: effective.dailyRequestLimit,
      dailyUsed: used,
      sendLogsExternally: effective.sendLogsExternally,
      localEndpoint: isLocalEndpoint(effective.baseUrl),
      externalLogsAllowed: externalLogsAllowed(effective),
    };
  }

  return {
    configured: false,
    source: "none",
    provider: AI_PROVIDER,
    baseUrl: config.AI_BASE_URL,
    model: "",
    apiKeySet: false,
    maxInputTokens: config.AI_MAX_INPUT_TOKENS,
    temperature: config.AI_TEMPERATURE,
    timeoutSec: config.AI_TIMEOUT_SEC,
    dailyRequestLimit: config.AI_DAILY_LIMIT,
    dailyUsed: used,
    sendLogsExternally: config.AI_SEND_LOGS_EXTERNALLY,
    localEndpoint: isLocalEndpoint(config.AI_BASE_URL),
    externalLogsAllowed:
      isLocalEndpoint(config.AI_BASE_URL) || config.AI_SEND_LOGS_EXTERNALLY,
  };
}

export async function saveAiSettings(
  input: AiSettingsInput & { clearApiKey?: boolean },
): Promise<AiSettingsView> {
  const stored = await readStored();
  let apiKeyCipher = stored?.apiKeyCipher ?? null;
  if (input.clearApiKey) {
    apiKeyCipher = null;
  } else if (input.apiKey) {
    apiKeyCipher = encryptSecret(input.apiKey);
  }

  const value: StoredAiSettings = {
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    model: input.model.trim(),
    apiKeyCipher,
    maxInputTokens: input.maxInputTokens,
    temperature: input.temperature,
    timeoutSec: input.timeoutSec,
    dailyRequestLimit: input.dailyRequestLimit,
    sendLogsExternally: input.sendLogsExternally,
  };
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: AI_SETTINGS_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    });
  return getAiSettingsView();
}

export async function testAiSettings(): Promise<{
  models: string[];
  latencyMs: number;
  baseUrl: string;
  model: string;
}> {
  const effective = await getEffectiveAiSettings();
  if (!effective || !effective.model) throw new AiNotConfiguredError();
  const client = new OpenAiCompatibleClient({
    baseUrl: effective.baseUrl,
    model: effective.model,
    apiKey: effective.apiKey,
    timeoutSec: effective.timeoutSec,
    temperature: effective.temperature,
  });
  const started = performance.now();
  const models = await client.listModels();
  return {
    models,
    latencyMs: Math.round(performance.now() - started),
    baseUrl: effective.baseUrl,
    model: effective.model,
  };
}

export { AI_PROVIDER };
