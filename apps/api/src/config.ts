import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().default("./data/sys4sys.db"),
  SESSION_SECRET: z
    .string()
    .min(16)
    .default("dev-only-session-secret-change-me"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(168),
  COOKIE_SECURE: z
    .string()
    .default("false")
    .transform((value) => value === "true"),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

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
  AI_DAILY_LIMIT: z.coerce.number().int().min(1).default(200),

  LOG_RETENTION_DAYS: z.coerce.number().int().min(1).default(14),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
