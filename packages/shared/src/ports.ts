import { z } from "zod";

export const hostKindSchema = z.enum(["windows", "wsl"]);
export type HostKind = z.infer<typeof hostKindSchema>;

export const portScopeSchema = z.enum(["windows", "wsl"]);
export type PortScope = z.infer<typeof portScopeSchema>;

export const protocolSchema = z.enum(["tcp", "udp"]);
export type Protocol = z.infer<typeof protocolSchema>;

export const portRowSchema = z.object({
  scope: portScopeSchema,
  /** WSL のとき、PID を観測できた distro */
  pidScope: z.string().nullable().optional(),
  /** WSL のとき、同じポートが見えた distro 一覧 */
  seenIn: z.array(z.string()).optional(),
  protocol: protocolSchema,
  address: z.string(),
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().nullable(),
  process: z.string().nullable(),
  processPath: z.string().nullable().optional(),
  commandLine: z.string().nullable(),
  likelyWslForward: z.boolean().optional(),
});
export type PortRow = z.infer<typeof portRowSchema>;

export const skippedDistroSchema = z.object({
  distro: z.string(),
  error: z.string(),
});
export type SkippedDistro = z.infer<typeof skippedDistroSchema>;

export const portScanResultSchema = z.object({
  scannedAt: z.string(),
  rows: z.array(portRowSchema),
  skipped: z.array(skippedDistroSchema),
});
export type PortScanResult = z.infer<typeof portScanResultSchema>;

export const serviceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "degraded",
  "restarting",
  "failed",
]);
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const restartPhaseSchema = z.enum(["observe", "approve", "auto"]);
export type RestartPhase = z.infer<typeof restartPhaseSchema>;

export const incidentSeveritySchema = z.enum([
  "info",
  "warning",
  "error",
  "critical",
]);
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;

export const incidentStatusSchema = z.enum([
  "open",
  "acked",
  "approval",
  "resolved",
]);
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const approvalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const roleSchema = z.enum(["admin", "operator", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const logLevelSchema = z.enum([
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
export type LogLevel = z.infer<typeof logLevelSchema>;
