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
  env?: Record<string, string>;
  timeoutSec: number;
  restartAfter: boolean;
  healthTimeoutSec: number;
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

export interface Health {
  status?: string;
  detail?: string;
  [key: string]: unknown;
}

export interface Service {
  id: string;
  hostId: string;
  name: string;
  command: string[];
  cwd: string | null;
  env: Record<string, string> | null;
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
