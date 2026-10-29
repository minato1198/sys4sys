import { z } from "zod";

export const hostKindSchema = z.enum(["windows", "wsl"]);
export type HostKind = z.infer<typeof hostKindSchema>;

export const portScopeSchema = z.enum(["windows", "wsl"]);
export type PortScope = z.infer<typeof portScopeSchema>;

export const protocolSchema = z.enum(["tcp", "udp"]);
export type Protocol = z.infer<typeof protocolSchema>;

export const portOwnerSchema = z.object({
  /** WSL のとき、この PID を観測できた distro */
  pidScope: z.string().nullable(),
  pid: z.number().int().nullable(),
  ppid: z.number().int().nullable(),
  process: z.string().nullable(),
  processPath: z.string().nullable(),
  commandLine: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  likelyWslForward: z.boolean(),
});
export type PortOwner = z.infer<typeof portOwnerSchema>;

export const portRowSchema = z.object({
  scope: portScopeSchema,
  /** WSL のとき、代表 PID を観測できた distro */
  pidScope: z.string().nullable().optional(),
  /** WSL のとき、同じポートが見えた distro 一覧 */
  seenIn: z.array(z.string()).optional(),
  protocol: protocolSchema,
  address: z.string(),
  port: z.number().int().min(1).max(65535),
  /** 代表オーナー。複数 PID が同じ endpoint を掴んでいる場合は owners[] を使う */
  pid: z.number().int().nullable(),
  ppid: z.number().int().nullable().optional(),
  process: z.string().nullable(),
  processPath: z.string().nullable().optional(),
  commandLine: z.string().nullable(),
  startedAt: z.string().datetime().nullable().optional(),
  likelyWslForward: z.boolean().optional(),
  /** 同じ endpoint に紐づくプロセス一覧。重複観測はマージする */
  owners: z.array(portOwnerSchema).optional(),
});
export type PortRow = z.infer<typeof portRowSchema>;

export const skippedDistroSchema = z.object({
  distro: z.string(),
  error: z.string(),
});
export type SkippedDistro = z.infer<typeof skippedDistroSchema>;

export const scanErrorCodeSchema = z.enum([
  "not_available",
  "timeout",
  "command_failed",
  "invalid_output",
]);
export type ScanErrorCode = z.infer<typeof scanErrorCodeSchema>;

export const scanErrorSchema = z.object({
  scope: portScopeSchema,
  distro: z.string().optional(),
  code: scanErrorCodeSchema.optional(),
  message: z.string(),
});
export type ScanError = z.infer<typeof scanErrorSchema>;

export const portScanResultSchema = z.object({
  scannedAt: z.string(),
  rows: z.array(portRowSchema),
  skipped: z.array(skippedDistroSchema),
  scanErrors: z.array(scanErrorSchema).default([]),
});
export type PortScanResult = z.infer<typeof portScanResultSchema>;

export function portEndpointKey(row: PortRow): string {
  return [row.scope, row.protocol, row.address, row.port].join(":");
}

export function portOwnerFromRow(row: PortRow): PortOwner {
  return {
    pidScope: row.pidScope ?? null,
    pid: row.pid ?? null,
    ppid: row.ppid ?? null,
    process: row.process ?? null,
    processPath: row.processPath ?? null,
    commandLine: row.commandLine ?? null,
    startedAt: row.startedAt ?? null,
    likelyWslForward: row.likelyWslForward ?? false,
  };
}

export function hasPortOwnerDetails(owner: PortOwner): boolean {
  return (
    owner.pid !== null ||
    owner.process !== null ||
    owner.processPath !== null ||
    owner.commandLine !== null ||
    owner.startedAt !== null
  );
}

export function portOwnerKey(owner: PortOwner): string {
  if (owner.pid !== null) {
    return `pid\u0000${owner.pidScope ?? ""}\u0000${owner.pid}`;
  }
  if (!hasPortOwnerDetails(owner)) return "empty\u0000";
  return [
    "detail",
    owner.pidScope ?? "",
    owner.process ?? "",
    owner.processPath ?? "",
    owner.commandLine ?? "",
    owner.startedAt ?? "",
  ].join("\u0000");
}

function fillPortOwner(existing: PortOwner, incoming: PortOwner): void {
  if (existing.pidScope === null && incoming.pidScope !== null) {
    existing.pidScope = incoming.pidScope;
  }
  if (existing.pid === null && incoming.pid !== null) {
    existing.pid = incoming.pid;
  }
  if (existing.ppid === null && incoming.ppid !== null) {
    existing.ppid = incoming.ppid;
  }
  if (existing.process === null && incoming.process !== null) {
    existing.process = incoming.process;
  }
  if (existing.processPath === null && incoming.processPath !== null) {
    existing.processPath = incoming.processPath;
  }
  if (existing.commandLine === null && incoming.commandLine !== null) {
    existing.commandLine = incoming.commandLine;
  }
  if (existing.startedAt === null && incoming.startedAt !== null) {
    existing.startedAt = incoming.startedAt;
  }
  existing.likelyWslForward =
    existing.likelyWslForward || incoming.likelyWslForward;
}

function scorePortOwner(owner: PortOwner): number {
  let score = 0;
  if (owner.pid !== null) score += 4;
  if (owner.commandLine !== null) score += 3;
  if (owner.processPath !== null) score += 2;
  if (owner.process !== null) score += 1;
  if (owner.startedAt !== null) score += 1;
  return score;
}

function emptyPortOwner(
  pidScope: string | null,
  likelyWslForward: boolean,
): PortOwner {
  return {
    pidScope,
    pid: null,
    ppid: null,
    process: null,
    processPath: null,
    commandLine: null,
    startedAt: null,
    likelyWslForward,
  };
}

/**
 * endpoint を主キーとして、同じ endpoint に紐づく複数プロセスを owners[] に集約する。
 * 同じ PID・同じ観測内容の重複行は 1 件にまとめ、PID が異なるオーナーは保持する。
 */
export function aggregatePortRows(rows: PortRow[]): PortRow[] {
  const endpoints = new Map<
    string,
    {
      scope: PortRow["scope"];
      protocol: Protocol;
      address: string;
      port: number;
      pidScope: string | null;
      seenIn: string[];
      likelyWslForward: boolean;
      owners: Map<string, PortOwner>;
    }
  >();

  for (const row of rows) {
    const key = portEndpointKey(row);
    const endpoint = endpoints.get(key) ?? {
      scope: row.scope,
      protocol: row.protocol,
      address: row.address,
      port: row.port,
      pidScope: row.pidScope ?? null,
      seenIn: [],
      likelyWslForward: false,
      owners: new Map<string, PortOwner>(),
    };
    endpoints.set(key, endpoint);

    if (!endpoint.pidScope && row.pidScope) {
      endpoint.pidScope = row.pidScope;
    }
    for (const distro of row.seenIn ?? []) {
      if (!endpoint.seenIn.includes(distro)) {
        endpoint.seenIn.push(distro);
      }
    }
    if (row.likelyWslForward) {
      endpoint.likelyWslForward = true;
    }

    const incomingOwners = row.owners?.length
      ? row.owners
      : [portOwnerFromRow(row)];

    for (const incoming of incomingOwners) {
      const key = portOwnerKey(incoming);
      const existing = endpoint.owners.get(key);
      if (existing) {
        fillPortOwner(existing, incoming);
      } else {
        endpoint.owners.set(key, { ...incoming });
      }
    }
  }

  const aggregated: PortRow[] = [];

  for (const endpoint of endpoints.values()) {
    let owners = [...endpoint.owners.values()];
    if (owners.some(hasPortOwnerDetails)) {
      owners = owners.filter(hasPortOwnerDetails);
    }
    if (owners.length === 0) {
      owners = [emptyPortOwner(endpoint.pidScope, endpoint.likelyWslForward)];
    }

    let primary = owners[0] ?? emptyPortOwner(endpoint.pidScope, false);
    let primaryScore = scorePortOwner(primary);
    for (const owner of owners) {
      const score = scorePortOwner(owner);
      if (score > primaryScore) {
        primary = owner;
        primaryScore = score;
      }
    }

    const primaryKey = portOwnerKey(primary);
    const outputOwners = [
      primary,
      ...owners.filter((owner) => portOwnerKey(owner) !== primaryKey),
    ];
    for (const owner of outputOwners) {
      if (owner.pidScope === null && endpoint.pidScope !== null) {
        owner.pidScope = endpoint.pidScope;
      }
    }

    aggregated.push({
      scope: endpoint.scope,
      protocol: endpoint.protocol,
      address: endpoint.address,
      port: endpoint.port,
      pidScope: primary.pidScope ?? endpoint.pidScope,
      seenIn: endpoint.seenIn,
      pid: primary.pid,
      ppid: primary.ppid,
      process: primary.process,
      processPath: primary.processPath,
      commandLine: primary.commandLine,
      startedAt: primary.startedAt,
      likelyWslForward: endpoint.likelyWslForward || primary.likelyWslForward,
      owners: outputOwners,
    });
  }

  return aggregated;
}

export const serviceStatusSchema = z.enum([
  "stopped",
  "starting",
  "running",
  "stopping",
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
