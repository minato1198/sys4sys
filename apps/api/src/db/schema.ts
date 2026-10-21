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
    command: text("command", { mode: "json" }).$type<string[]>().notNull(),
    cwd: text("cwd"),
    env: text("env", { mode: "json" }).$type<Record<string, string>>(),
    expectedPorts: text("expected_ports", { mode: "json" }).$type<number[]>(),
    healthCheck: text("health_check", { mode: "json" }).$type<
      Record<string, unknown>
    >(),
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
        "degraded",
        "restarting",
        "failed",
      ],
    })
      .notNull()
      .default("stopped"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("services_host_name_uq").on(table.hostId, table.name),
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

export const logSources = sqliteTable("log_sources", {
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
});

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

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    requestedAction: text("requested_action", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired"],
    })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at"),
    note: text("note"),
  },
  (table) => [
    index("approvals_status_idx").on(table.status),
    index("approvals_incident_id_idx").on(table.incidentId),
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
      enum: ["start", "stop", "restart", "kill"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    policyId: text("policy_id"),
    startedAt: timestamp("started_at").notNull(),
    finishedAt: timestamp("finished_at"),
    error: text("error"),
  },
  (table) => [
    index("actions_service_started_idx").on(table.serviceId, table.startedAt),
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
