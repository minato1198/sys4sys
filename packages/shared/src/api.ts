import { z } from "zod";
import {
  approvalStatusSchema,
  hostKindSchema,
  incidentSeveritySchema,
  incidentStatusSchema,
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

export const portHistoryQuerySchema = z.object({
  scope: portScopeSchema,
  port: z.coerce.number().int().min(1).max(65535),
  protocol: protocolSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type PortHistoryQuery = z.infer<typeof portHistoryQuerySchema>;

export const killTokenQuerySchema = z.object({
  scope: portScopeSchema,
  pidScope: z.string().optional(),
  pid: z.coerce.number().int().min(1).optional(),
});
export type KillTokenQuery = z.infer<typeof killTokenQuerySchema>;

export const hostCreateSchema = z
  .object({
    kind: hostKindSchema,
    name: z.string().min(1).max(100),
    distro: z.string().min(1).max(100).optional(),
    defaultUser: z.string().min(1).max(100).optional(),
    enabled: z.boolean().default(true),
  })
  .refine((value) => value.kind !== "wsl" || Boolean(value.distro), {
    message: "WSL ホストには distro が必要です",
    path: ["distro"],
  });
export type HostCreateInput = z.infer<typeof hostCreateSchema>;

export const hostUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  defaultUser: z.string().max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type HostUpdateInput = z.infer<typeof hostUpdateSchema>;

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

export const serviceUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  command: z.array(z.string().min(1)).min(1).optional(),
  cwd: z.string().max(4096).nullable().optional(),
  env: z.record(z.string(), z.string()).nullable().optional(),
  expectedPorts: z
    .array(z.number().int().min(1).max(65535))
    .nullable()
    .optional(),
  healthCheck: healthCheckSchema.nullable().optional(),
  dependsOn: z.array(z.string()).nullable().optional(),
  autoStart: z.boolean().optional(),
  autoRestartPhase: restartPhaseSchema.optional(),
});
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>;

export const serviceListQuerySchema = z.object({
  hostId: z.string().optional(),
  status: z
    .enum([
      "stopped",
      "starting",
      "running",
      "degraded",
      "restarting",
      "failed",
    ])
    .optional(),
});
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;

export const approvalDecisionSchema = z.object({
  note: z.string().max(500).optional(),
});
export type ApprovalDecisionInput = z.infer<typeof approvalDecisionSchema>;

export const incidentQuerySchema = z.object({
  status: incidentStatusSchema.optional(),
  severity: incidentSeveritySchema.optional(),
  serviceId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type IncidentQuery = z.infer<typeof incidentQuerySchema>;

export const incidentActionSchema = z.object({
  note: z.string().max(500).optional(),
});
export type IncidentActionInput = z.infer<typeof incidentActionSchema>;

export const approvalQuerySchema = z.object({
  status: approvalStatusSchema.default("pending"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ApprovalQuery = z.infer<typeof approvalQuerySchema>;

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

export const logStreamQuerySchema = logQuerySchema.omit({
  limit: true,
  cursor: true,
});
export type LogStreamQuery = z.infer<typeof logStreamQuerySchema>;

export const logSourceConfigSchema = z
  .object({
    path: z.string().min(1).max(4096),
  })
  .catchall(z.unknown());
export type LogSourceConfig = z.infer<typeof logSourceConfigSchema>;

export const logSourceCreateSchema = z.object({
  hostId: z.string().min(1),
  serviceId: z.string().min(1).nullable().optional(),
  type: z.enum(["file", "wsl_file", "eventlog"]),
  config: logSourceConfigSchema,
  enabled: z.boolean().default(true),
});
export type LogSourceCreateInput = z.infer<typeof logSourceCreateSchema>;

export const logSourceUpdateSchema = z.object({
  serviceId: z.string().min(1).nullable().optional(),
  config: logSourceConfigSchema.optional(),
  enabled: z.boolean().optional(),
});
export type LogSourceUpdateInput = z.infer<typeof logSourceUpdateSchema>;

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

export const aiSettingsUpdateSchema = aiSettingsSchema.extend({
  clearApiKey: z.boolean().optional(),
});
export type AiSettingsUpdateInput = z.infer<typeof aiSettingsUpdateSchema>;

export const reportQuerySchema = z.object({
  incidentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportExportQuerySchema = z.object({
  format: z.enum(["md", "json"]).default("md"),
});
export type ReportExportQuery = z.infer<typeof reportExportQuerySchema>;

export const auditLogQuerySchema = z.object({
  actor: z.string().optional(),
  action: z.string().optional(),
  target: z.string().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export const retentionSettingsSchema = z.object({
  logDays: z.number().int().min(1).max(3650).default(14),
});
export type RetentionSettingsInput = z.infer<typeof retentionSettingsSchema>;
