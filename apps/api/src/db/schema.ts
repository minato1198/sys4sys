import type { DeployConfigInput, DeployRequestSnapshot } from "@sys4sys/shared";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "operator", "viewer"] })
    .notNull()
    .default("viewer"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["windows", "wsl"] }).notNull(),
    name: text("name").notNull(),
    distro: text("distro"),
    defaultUser: text("default_user"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [uniqueIndex("hosts_kind_distro_uq").on(table.kind, table.distro)],
);

export const services = sqliteTable(
  "services",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id").notNull(),
    name: text("name").notNull(),
    controlMode: text("control_mode", {
      enum: ["spawn", "windows-service"],
    })
      .notNull()
      .default("spawn"),
    serviceName: text("service_name"),
    command: text("command", { mode: "json" }).$type<string[]>().notNull(),
    cwd: text("cwd"),
    env: text("env", { mode: "json" }).$type<Record<string, string>>(),
    expectedPorts: text("expected_ports", { mode: "json" }).$type<number[]>(),
    healthCheck: text("health_check", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    deploy: text("deploy", { mode: "json" }).$type<DeployConfigInput>(),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>(),
    autoStart: integer("auto_start", { mode: "boolean" })
      .notNull()
      .default(false),
    autoRestartPhase: text("auto_restart_phase", {
      enum: ["observe", "approve", "auto"],
    })
      .notNull()
      .default("observe"),
    status: text("status", {
      enum: [
        "stopped",
        "starting",
        "running",
        "stopping",
        "degraded",
        "restarting",
        "failed",
      ],
    })
      .notNull()
      .default("stopped"),
    pid: integer("pid"),
    pidScope: text("pid_scope"),
    lastStartedAt: timestamp("last_started_at"),
    lastExitedAt: timestamp("last_exited_at"),
    lastExitCode: integer("last_exit_code"),
    lastError: text("last_error"),
    lastDeployAt: timestamp("last_deploy_at"),
    lastDeployStatus: text("last_deploy_status", {
      enum: ["running", "succeeded", "failed"],
    }),
    lastDeployError: text("last_deploy_error"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("services_host_name_uq").on(table.hostId, table.name),
    uniqueIndex("services_host_service_name_uq")
      .on(table.hostId, sql`lower(${table.serviceName})`)
      .where(sql`${table.serviceName} is not null`),
  ],
);

export const ports = sqliteTable(
  "ports",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["windows", "wsl"] }).notNull(),
    pidHostId: text("pid_host_id"),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    address: text("address").notNull(),
    port: integer("port").notNull(),
    pid: integer("pid"),
    ppid: integer("ppid"),
    processName: text("process_name"),
    processPath: text("process_path"),
    commandLine: text("command_line"),
    startedAt: timestamp("started_at"),
    serviceId: text("service_id"),
    firstSeen: timestamp("first_seen").notNull(),
    lastSeen: timestamp("last_seen").notNull(),
  },
  (table) => [
    uniqueIndex("ports_endpoint_uq").on(
      table.scope,
      table.protocol,
      table.address,
      table.port,
    ),
    index("ports_port_idx").on(table.port),
    index("ports_service_id_idx").on(table.serviceId),
  ],
);

export const portHistory = sqliteTable(
  "port_history",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["windows", "wsl"] }).notNull(),
    pidHostId: text("pid_host_id"),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    address: text("address").notNull(),
    port: integer("port").notNull(),
    pid: integer("pid"),
    ppid: integer("ppid"),
    processName: text("process_name"),
    processPath: text("process_path"),
    commandLine: text("command_line"),
    startedAt: timestamp("started_at"),
    serviceId: text("service_id"),
    openedAt: timestamp("opened_at").notNull(),
    closedAt: timestamp("closed_at"),
    releasedBy: text("released_by"),
  },
  (table) => [
    index("port_history_scope_port_opened_idx").on(
      table.scope,
      table.port,
      table.openedAt,
    ),
    index("port_history_closed_at_idx").on(table.closedAt),
  ],
);

export const portReservations = sqliteTable(
  "port_reservations",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["windows", "wsl"] }).notNull(),
    port: integer("port").notNull(),
    protocol: text("protocol", { enum: ["tcp", "udp"] }).notNull(),
    serviceId: text("service_id").notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("port_reservations_endpoint_uq").on(table.protocol, table.port),
  ],
);

export const logSources = sqliteTable(
  "log_sources",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id").notNull(),
    serviceId: text("service_id"),
    type: text("type", {
      enum: ["file", "stdout", "wsl_file", "eventlog"],
    }).notNull(),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    index("log_sources_host_service_idx").on(table.hostId, table.serviceId),
  ],
);

export const logEvents = sqliteTable(
  "log_events",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id").notNull(),
    serviceId: text("service_id").notNull(),
    ts: timestamp("ts").notNull(),
    level: text("level", {
      enum: ["debug", "info", "warn", "error", "fatal"],
    }).notNull(),
    stream: text("stream", {
      enum: ["stdout", "stderr", "file", "eventlog"],
    }).notNull(),
    message: text("message").notNull(),
    fields: text("fields", { mode: "json" }).$type<Record<string, unknown>>(),
    fingerprint: text("fingerprint").notNull(),
  },
  (table) => [
    index("log_events_host_service_ts_idx").on(
      table.hostId,
      table.serviceId,
      table.ts,
    ),
    index("log_events_fingerprint_ts_idx").on(table.fingerprint, table.ts),
    index("log_events_ts_idx").on(table.ts),
  ],
);

export const incidents = sqliteTable(
  "incidents",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    title: text("title").notNull(),
    severity: text("severity", {
      enum: ["info", "warning", "error", "critical"],
    }).notNull(),
    status: text("status", { enum: ["open", "acked", "approval", "resolved"] })
      .notNull()
      .default("open"),
    startedAt: timestamp("started_at").notNull(),
    resolvedAt: timestamp("resolved_at"),
    detectedBy: text("detected_by", {
      enum: ["rule", "health", "process", "ai"],
    }).notNull(),
    restartAttempts: integer("restart_attempts").notNull().default(0),
    summary: text("summary"),
  },
  (table) => [
    index("incidents_fingerprint_started_idx").on(
      table.fingerprint,
      table.startedAt,
    ),
    index("incidents_status_idx").on(table.status),
    index("incidents_service_id_idx").on(table.serviceId),
  ],
);

export const incidentEvents = sqliteTable(
  "incident_events",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    ts: timestamp("ts").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("incident_events_incident_ts_idx").on(table.incidentId, table.ts),
  ],
);

export const incidentActionProposals = sqliteTable(
  "incident_action_proposals",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    analysisId: text("analysis_id"),
    serviceId: text("service_id").notNull(),
    actionType: text("action_type", {
      enum: ["restart", "start", "stop", "deploy"],
    }).notNull(),
    status: text("status", {
      enum: [
        "proposed",
        "pending_approval",
        "approved",
        "executing",
        "succeeded",
        "failed",
        "rejected",
        "expired",
        "superseded",
      ],
    })
      .notNull()
      .default("proposed"),
    risk: text("risk", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    confidence: real("confidence").notNull().default(0),
    rationale: text("rationale"),
    parameters: text("parameters", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
    snapshot: text("snapshot", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    analysisRequestedBy: text("analysis_requested_by"),
    approvalId: text("approval_id"),
    actionId: text("action_id"),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    executedAt: timestamp("executed_at"),
    error: text("error"),
  },
  (table) => [
    index("incident_action_proposals_incident_status_idx").on(
      table.incidentId,
      table.status,
    ),
    index("incident_action_proposals_service_status_idx").on(
      table.serviceId,
      table.status,
    ),
    index("incident_action_proposals_approval_idx").on(table.approvalId),
    index("incident_action_proposals_action_idx").on(table.actionId),
    index("incident_action_proposals_incident_dedupe_idx").on(
      table.incidentId,
      table.dedupeKey,
    ),
  ],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    proposalId: text("proposal_id"),
    source: text("source", { enum: ["policy", "ai", "manual"] })
      .notNull()
      .default("policy"),
    requestedAction: text("requested_action", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    requestedBy: text("requested_by"),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired"],
    })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    note: text("note"),
    expiresAt: timestamp("expires_at"),
  },
  (table) => [
    index("approvals_status_idx").on(table.status),
    index("approvals_incident_id_idx").on(table.incidentId),
    index("approvals_proposal_id_idx").on(table.proposalId),
  ],
);

export const aiAnalyses = sqliteTable(
  "ai_analyses",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    result: text("result", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    confidence: real("confidence").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("ai_analyses_incident_id_idx").on(table.incidentId)],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    format: text("format", { enum: ["markdown", "json"] }).notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => [index("reports_incident_id_idx").on(table.incidentId)],
);

export const reportDeliveries = sqliteTable(
  "report_deliveries",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id").notNull(),
    channel: text("channel", { enum: ["email"] }).notNull(),
    toAddr: text("to_addr").notNull(),
    status: text("status", { enum: ["sent", "failed"] }).notNull(),
    error: text("error"),
    sentAt: timestamp("sent_at"),
  },
  (table) => [index("report_deliveries_report_id_idx").on(table.reportId)],
);

export const actions = sqliteTable(
  "actions",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id"),
    serviceId: text("service_id").notNull(),
    type: text("type", {
      enum: ["start", "stop", "restart", "kill", "deploy"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    policyId: text("policy_id"),
    proposalId: text("proposal_id"),
    approvalId: text("approval_id"),
    source: text("source", {
      enum: ["manual", "policy", "ai_approved"],
    })
      .notNull()
      .default("manual"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
    error: text("error"),
  },
  (table) => [
    index("actions_service_started_idx").on(table.serviceId, table.startedAt),
    index("actions_proposal_id_idx").on(table.proposalId),
    index("actions_approval_id_idx").on(table.approvalId),
    uniqueIndex("actions_one_running_deploy")
      .on(table.serviceId)
      .where(
        sql`${table.type} = 'deploy' and ${table.status} in ('pending', 'running')`,
      ),
  ],
);

export const deployRequests = sqliteTable(
  "deploy_requests",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: timestamp("requested_at").notNull(),
    status: text("status", {
      enum: [
        "pending",
        "approved",
        "rejected",
        "expired",
        "executed",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    note: text("note"),
    actionId: text("action_id"),
    snapshot: text("snapshot", { mode: "json" })
      .$type<DeployRequestSnapshot>()
      .notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => [
    index("deploy_requests_status_idx").on(table.status),
    index("deploy_requests_service_idx").on(table.serviceId, table.requestedAt),
  ],
);

export const policies = sqliteTable("policies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  scope: text("scope", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  rules: text("rules", { mode: "json" })
    .$type<Record<string, unknown>>()
    .notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  priority: integer("priority").notNull().default(100),
});

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    before: text("before", { mode: "json" }).$type<Record<string, unknown>>(),
    after: text("after", { mode: "json" }).$type<Record<string, unknown>>(),
    reason: text("reason"),
    ip: text("ip"),
    ts: timestamp("ts").notNull(),
  },
  (table) => [
    index("audit_logs_ts_idx").on(table.ts),
    index("audit_logs_actor_idx").on(table.actorUserId),
  ],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestamp("created_at").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (table) => [
    index("api_tokens_user_id_idx").on(table.userId),
    index("api_tokens_expires_at_idx").on(table.expiresAt),
  ],
);
