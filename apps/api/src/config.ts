import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

// pnpm --filter は cwd を apps/api にするため、ワークスペース直下の .env を明示的に読む。
// 既に設定済みの環境変数は dotenv が上書きしないので、テストや CI の指定が優先される。
loadEnv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
  quiet: true,
});

const DEFAULT_SESSION_SECRET = "dev-only-session-secret-change-me";
const INSECURE_SESSION_SECRETS = new Set([
  DEFAULT_SESSION_SECRET,
  "change-me-to-a-long-random-string",
]);

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().default("./data/sys4sys.db"),
  SESSION_SECRET: z.string().min(16).default(DEFAULT_SESSION_SECRET),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  TOKEN_DEFAULT_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  TOKEN_MAX_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(365),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  ALLOWED_ORIGINS: z
    .string()
    .default(
      "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:8787,http://localhost:8787",
    ),

  ADMIN_EMAIL: z.string().email().default("admin@sys4sys.local"),
  ADMIN_PASSWORD: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(12).optional(),
  ),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  MAIL_RECIPIENTS: z.string().optional(),

  AI_BASE_URL: z.string().url().default("http://127.0.0.1:1234/v1"),
  AI_MODEL: z.string().default(""),
  AI_API_KEY: z.string().optional(),
  AI_MAX_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(256)
    .max(200_000)
    .default(8000),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  AI_TIMEOUT_SEC: z.coerce.number().int().min(5).max(600).default(60),
  AI_DAILY_LIMIT: z.coerce.number().int().min(0).default(200),
  AI_SEND_LOGS_EXTERNALLY: z
    .string()
    .default("false")
    .transform((value) => value === "true"),

  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
  LOG_TAIL_POLL_MS: z.coerce.number().int().min(200).max(60_000).default(1000),
  LOG_MAX_LINE_CHARS: z.coerce
    .number()
    .int()
    .min(256)
    .max(100_000)
    .default(8000),
  LOG_MAX_TAIL_BYTES: z.coerce
    .number()
    .int()
    .min(4096)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),

  SERVICE_COMMAND_ALLOWLIST: z
    .string()
    .default(
      "node,node.exe,pnpm,pnpm.cmd,npm,npm.cmd,npx,npx.cmd,bun,bun.exe,deno,deno.exe,python,python.exe,python3,python3.exe,uvicorn,uvicorn.exe,go,go.exe,dotnet,dotnet.exe,java,java.exe,ruby,ruby.exe,php,php.exe,sh,bash,pwsh,pwsh.exe,powershell,powershell.exe",
    ),
  SERVICE_STOP_GRACE_MS: z.coerce
    .number()
    .int()
    .min(500)
    .max(60_000)
    .default(5000),
  SERVICE_AUTOSTART_ON_BOOT: z
    .string()
    .default("false")
    .transform((value) => value === "true"),

  MONITOR_ENABLED: z
    .string()
    .default("true")
    .transform((value) => value === "true"),
  MONITOR_INTERVAL_SEC: z.coerce.number().int().min(5).max(3600).default(15),
  MONITOR_STARTUP_DELAY_SEC: z.coerce.number().int().min(0).max(600).default(5),
  MONITOR_HEARTBEAT_TIMEOUT_SEC: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(0),
  MONITOR_ERROR_LOG_WINDOW_SEC: z.coerce
    .number()
    .int()
    .min(30)
    .max(86_400)
    .default(300),
  MONITOR_ERROR_LOG_THRESHOLD: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0),
  MONITOR_LOG_PATTERN: z.string().default(""),

  INCIDENT_DEDUPE_MINUTES: z.coerce.number().int().min(1).max(1440).default(10),
  AUTO_RESTART_COOLDOWN_SEC: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(60),
  AUTO_RESTART_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(3),
  AUTO_RESTART_WINDOW_SEC: z.coerce
    .number()
    .int()
    .min(60)
    .max(86_400)
    .default(600),
  AUTO_RESTART_BACKOFF_SEC: z.string().default("10,30,90"),
  AUTO_RESTART_VERIFY_TIMEOUT_SEC: z.coerce
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30),

  APP_BASE_URL: z.string().url().default("http://127.0.0.1:3000"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

if (
  process.env.NODE_ENV === "production" &&
  (INSECURE_SESSION_SECRETS.has(parsed.data.SESSION_SECRET) ||
    parsed.data.SESSION_SECRET.length < 32)
) {
  console.error(
    "SESSION_SECRET must be a random value of at least 32 characters in production",
  );
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
