export type Role = "admin" | "operator" | "viewer";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  requiredScope?: string;
  deployRequestId?: string;
  errors?: Array<{ path: string; message: string }>;
}

export interface Host {
  id: string;
  kind: "windows" | "wsl";
  name: string;
  distro: string | null;
  defaultUser: string | null;
  enabled: boolean;
  state?: string;
  distroState?: string | null;
}

export interface DeployConfig {
  command: string[];
  cwd?: string;
  env?: Record<string, string> | null;
  envKeys?: string[];
  timeoutSec: number;
  restartAfter: boolean;
  healthTimeoutSec: number;
  requireApproval?: boolean;
  serviceControlOwner?: "sys4sys" | "script" | null;
}

export interface ServiceSecrets {
  env: Record<string, string> | null;
  deployEnv: Record<string, string> | null;
}

export interface Action {
  id: string;
  incidentId: string | null;
  serviceId: string;
  type: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  policyId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface LogEvent {
  id: string;
  hostId: string;
  serviceId: string;
  ts: string;
  level: "debug" | "info" | "warn" | "error" | "fatal";
  stream: string;
  message: string;
  fields: Record<string, unknown> | null;
  fingerprint: string;
}

export interface Health {
  status?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface Service {
  id: string;
  hostId: string;
  name: string;
  controlMode: "spawn" | "windows-service";
  serviceName: string | null;
  command: string[];
  cwd: string | null;
  env?: Record<string, string> | null;
  envKeys?: string[];
  expectedPorts: number[];
  healthCheck: unknown;
  deploy: DeployConfig | null;
  dependsOn: string[];
  autoStart: boolean;
  autoRestartPhase: string;
  status: string;
  isActive: boolean;
  pid: number | null;
  pidScope: string | null;
  lastStartedAt: string | null;
  lastExitedAt: string | null;
  lastExitCode: number | null;
  lastError: string | null;
  lastDeployAt: string | null;
  lastDeployStatus: string | null;
  lastDeployError: string | null;
  createdAt: string;
  updatedAt: string;
  host: Host | null;
  health: Health;
  runtime: unknown;
  recentActions?: Action[];
}
