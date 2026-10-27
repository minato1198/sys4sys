export interface ReservationView {
  id: string;
  scope: "windows" | "wsl";
  protocol: "tcp" | "udp";
  port: number;
  serviceId: string;
  note: string | null;
  createdAt: string;
  status: "reserved" | "conflict";
  inUse: boolean;
}

export interface PortOwner {
  pid: number | null;
  pidScope: string | null;
  ppid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  startedAt: string | null;
  likelyWslForward: boolean;
}

export interface PortItem {
  id: string;
  scope: "windows" | "wsl";
  pidScope: string | null;
  seenIn: string[];
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number | null;
  ppid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  startedAt: string | null;
  likelyWslForward: boolean;
  owners?: PortOwner[];
  ownerCount?: number;
  serviceId: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  reservation: ReservationView | null;
  conflict: boolean;
  status: "in_use" | "conflict";
}
