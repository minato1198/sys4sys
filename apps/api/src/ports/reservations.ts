import type { PortRow, Protocol } from "@sys4sys/shared";
import type { portReservations } from "../db/schema.js";

export type ReservationRow = typeof portReservations.$inferSelect;

export type ReservationStatus = "reserved" | "conflict";

export interface ReservationView {
  id: string;
  scope: "windows" | "wsl";
  protocol: Protocol;
  port: number;
  serviceId: string;
  note: string | null;
  createdAt: string;
  status: ReservationStatus;
  inUse: boolean;
}

export interface ReservationListener {
  scope: "windows" | "wsl";
  pidScope: string | null;
  protocol: Protocol;
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
  commandLine: string | null;
  likelyWslForward: boolean;
}

/**
 * Windows と WSL 3.x はネットワークを共有する。
 * そのため予約の競合判定は scope をまたいで protocol + port で行う。
 * scope は「どのホストで動かす予定か」を表すメタデータとして保持する。
 */
export function findReservationForEndpoint(
  reservations: ReservationRow[],
  protocol: Protocol,
  port: number,
): ReservationRow | undefined {
  return reservations.find(
    (reservation) =>
      reservation.protocol === protocol && reservation.port === port,
  );
}

export function isEndpointInUse(
  rows: PortRow[],
  protocol: Protocol,
  port: number,
): boolean {
  return rows.some((row) => row.protocol === protocol && row.port === port);
}

export function findReservationForRow(
  reservations: ReservationRow[],
  row: PortRow,
): ReservationRow | undefined {
  return findReservationForEndpoint(reservations, row.protocol, row.port);
}

export function toReservationListener(row: PortRow): ReservationListener {
  return {
    scope: row.scope,
    pidScope: row.pidScope ?? null,
    protocol: row.protocol,
    address: row.address,
    port: row.port,
    pid: row.pid,
    process: row.process,
    commandLine: row.commandLine,
    likelyWslForward: row.likelyWslForward ?? false,
  };
}

export function toReservationView(
  reservation: ReservationRow,
  rows: PortRow[],
): ReservationView {
  const inUse = isEndpointInUse(rows, reservation.protocol, reservation.port);
  return {
    id: reservation.id,
    scope: reservation.scope,
    protocol: reservation.protocol,
    port: reservation.port,
    serviceId: reservation.serviceId,
    note: reservation.note,
    createdAt: reservation.createdAt.toISOString(),
    status: inUse ? "conflict" : "reserved",
    inUse,
  };
}

export function buildReservationViews(
  reservations: ReservationRow[],
  rows: PortRow[],
): ReservationView[] {
  return reservations
    .map((reservation) => toReservationView(reservation, rows))
    .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

export function findReservationView(
  views: ReservationView[],
  protocol: Protocol,
  port: number,
): ReservationView | undefined {
  return views.find((view) => view.protocol === protocol && view.port === port);
}
