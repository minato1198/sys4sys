import { z } from "zod";
import {
  logLevelSchema,
  portScopeSchema,
  protocolSchema,
  restartPhaseSchema,
  roleSchema,
} from "./ports.js";

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(8).max(200),
  newPassword: z.string().min(12).max(200),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(12).max(200),
  role: roleSchema,
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(12).max(200).optional(),
});
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

export const reservationCreateSchema = z.object({
  scope: portScopeSchema,
  port: z.number().int().min(1).max(65535),
  protocol: protocolSchema,
  serviceId: z.string().min(1),
  note: z.string().max(500).optional(),
});
export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;

export const killRequestSchema = z.object({
  scope: portScopeSchema,
  pidScope: z.string().nullable().optional(),
  confirmToken: z.string().min(1),
  signal: z.enum(["TERM", "KILL"]).default("TERM"),
  force: z.boolean().default(false),
});
export type KillRequestInput = z.infer<typeof killRequestSchema>;

export const healthCheckSchema = z.object({
  type: z.enum(["http", "tcp", "process", "command"]),
  url: z.string().url().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  command: z.array(z.string().min(1)).optional(),
  intervalSec: z.number().int().min(1).max(3600).default(10),
  timeoutSec: z.number().int().min(1).max(300).default(3),
  failures: z.number().int().min(1).max(100).default(3),
});
export type HealthCheckInput = z.infer<typeof healthCheckSchema>;

export const serviceCreateSchema = z.object({
  hostId: z.string().min(1),
  name: z.string().min(1).max(100),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  expectedPorts: z.array(z.number().int().min(1).max(65535)).optional(),
  healthCheck: healthCheckSchema.optional(),
  dependsOn: z.array(z.string()).optional(),
  autoStart: z.boolean().default(false),
  autoRestartPhase: restartPhaseSchema.default("observe"),
});
export type ServiceCreateInput = z.infer<typeof serviceCreateSchema>;

export const serviceUpdateSchema = serviceCreateSchema
  .omit({ hostId: true, name: true })
  .partial()
  .extend({
    name: z.string().min(1).max(100).optional(),
  });
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>;

export const approvalDecisionSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const logQuerySchema = z.object({
  hostId: z.string().optional(),
  serviceId: z.string().optional(),
  level: logLevelSchema.optional(),
  q: z.string().max(500).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type LogQuery = z.infer<typeof logQuerySchema>;

export const mailSettingsSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  username: z.string().optional(),
  password: z.string().optional(),
  from: z.string().email(),
  recipients: z.array(z.string().email()).min(1),
  mode: z.enum(["immediate", "digest5m"]).default("immediate"),
});
export type MailSettingsInput = z.infer<typeof mailSettingsSchema>;

export const aiSettingsSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  apiKey: z.string().optional(),
  maxInputTokens: z.number().int().min(256).max(200_000).default(8000),
  temperature: z.number().min(0).max(2).default(0.2),
  timeoutSec: z.number().int().min(5).max(600).default(60),
  dailyRequestLimit: z.number().int().min(0).max(100_000).default(200),
  sendLogsExternally: z.boolean().default(false),
});
export type AiSettingsInput = z.infer<typeof aiSettingsSchema>;
