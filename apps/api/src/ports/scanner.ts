import { randomUUID } from "node:crypto";
import type { DetailedScanResult, ScanOptions } from "@sys4sys/agent";
import { scanPorts } from "@sys4sys/agent";
import {
  portOwnerFromRow,
  type PortOwner,
  type PortRow,
} from "@sys4sys/shared";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { portHistory, portReservations, ports } from "../db/schema.js";
import {
  buildReservationViews,
  findReservationForRow,
  type ReservationRow,
  type ReservationView,
} from "./reservations.js";

export interface PersistedScan {
  scan: DetailedScanResult;
  reservations: ReservationRow[];
  reservationViews: ReservationView[];
}

type PortDbRow = typeof ports.$inferSelect;
type PortHistoryDbRow = typeof portHistory.$inferSelect;

function endpointKey(row: {
  scope: string;
  protocol: string;
  address: string;
  port: number;
}): string {
  return [row.scope, row.protocol, row.address, row.port].join(":");
}

function historyKey(row: {
  scope: string;
  pidHostId: string | null;
  protocol: string;
  address: string;
  port: number;
  pid: number | null;
}): string {
  return [
    row.scope,
    row.pidHostId ?? "",
    row.protocol,
    row.address,
    row.port,
    row.pid ?? "",
  ].join("\u0000");
}

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function wasScanned(row: PortHistoryDbRow, scan: DetailedScanResult): boolean {
  if (row.scope === "windows") {
    return Boolean(scan.timings.windows);
  }
  if (!row.pidHostId) return false;
  return Boolean(scan.timings[`wsl:${row.pidHostId}`]);
}

function ownersForScanRow(row: PortRow): PortOwner[] {
  return row.owners?.length ? row.owners : [portOwnerFromRow(row)];
}

function primaryOwnerForRow(row: PortRow, owners: PortOwner[]): PortOwner {
  const rowPid = row.pid ?? null;
  const rowPidScope = row.pidScope ?? null;
  return (
    owners.find(
      (owner) => owner.pid === rowPid && owner.pidScope === rowPidScope,
    ) ??
    owners.find((owner) => owner.pid !== null) ??
    owners[0] ??
    portOwnerFromRow(row)
  );
}

async function persistScan(scan: DetailedScanResult): Promise<PersistedScan> {
  const now = toDate(scan.scannedAt) ?? new Date();
  const reservations = await db.select().from(portReservations);
  const openHistory = await db
    .select()
    .from(portHistory)
    .where(isNull(portHistory.closedAt));

  const openByKey = new Map<string, PortHistoryDbRow>();
  for (const row of openHistory) {
    openByKey.set(historyKey(row), row);
  }

  const currentKeys = new Set<string>();

  for (const row of scan.rows) {
    const reservation = findReservationForRow(reservations, row);
    const owners = ownersForScanRow(row);
    const primary = primaryOwnerForRow(row, owners);
    const pidHostId = row.pidScope ?? primary.pidScope ?? null;
    const startedAt = toDate(primary.startedAt);
    const serviceId = reservation?.serviceId ?? null;
    const key = endpointKey(row);

    await db
      .insert(ports)
      .values({
        id: `port:${key}`,
        scope: row.scope,
        pidHostId,
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid: primary.pid,
        ppid: primary.ppid,
        processName: primary.process,
        processPath: primary.processPath,
        commandLine: primary.commandLine,
        startedAt,
        serviceId,
        firstSeen: now,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [ports.scope, ports.protocol, ports.address, ports.port],
        set: {
          pidHostId,
          pid: primary.pid,
          ppid: primary.ppid,
          processName: primary.process,
          processPath: primary.processPath,
          commandLine: primary.commandLine,
          startedAt,
          serviceId,
          lastSeen: now,
        },
      });

    for (const owner of owners) {
      const ownerPidHostId = owner.pidScope ?? pidHostId;
      const ownerStartedAt = toDate(owner.startedAt) ?? startedAt;
      const hKey = historyKey({
        scope: row.scope,
        pidHostId: ownerPidHostId,
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid: owner.pid,
      });
      currentKeys.add(hKey);

      const open = openByKey.get(hKey);
      if (open) {
        if (open.serviceId !== serviceId) {
          await db
            .update(portHistory)
            .set({ serviceId })
            .where(eq(portHistory.id, open.id));
        }
        continue;
      }

      await db.insert(portHistory).values({
        id: randomUUID(),
        scope: row.scope,
        pidHostId: ownerPidHostId,
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid: owner.pid,
        ppid: owner.ppid,
        processName: owner.process,
        processPath: owner.processPath,
        commandLine: owner.commandLine,
        startedAt: ownerStartedAt,
        serviceId,
        openedAt: now,
        closedAt: null,
        releasedBy: null,
      });
    }
  }

  // スキャン対象になったホストで見えなくなったポートだけを閉じる。
  // 停止中の WSL distro やスキャン失敗した distro は「消えた」と判断しない。
  for (const open of openHistory) {
    const key = historyKey(open);
    if (currentKeys.has(key)) continue;
    if (!wasScanned(open, scan)) continue;

    await db
      .update(portHistory)
      .set({ closedAt: now })
      .where(eq(portHistory.id, open.id));
  }

  return {
    scan,
    reservations,
    reservationViews: buildReservationViews(reservations, scan.rows),
  };
}

let queue: Promise<void> = Promise.resolve();
const inFlight = new Map<string, Promise<PersistedScan>>();

function scanKey(options: ScanOptions): string {
  return JSON.stringify({
    scope: options.scope ?? "all",
    distro: options.distro ?? null,
    includeStopped: Boolean(options.includeStopped),
  });
}

/**
 * スキャンを直列化して DB に反映する。
 * 複数リクエストが同時に来ても、履歴の opened/closed が壊れないようにする。
 * 同一オプションの実行中リクエストは同じ Promise を共有する。
 */
export function scanAndPersist(
  options: ScanOptions = {},
): Promise<PersistedScan> {
  const key = scanKey(options);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const result = queue.then(async () => {
    const scan = await scanPorts(options);
    return persistScan(scan);
  });

  queue = result.then(
    () => undefined,
    () => undefined,
  );
  inFlight.set(key, result);

  const clear = () => {
    if (inFlight.get(key) === result) inFlight.delete(key);
  };
  void result.then(clear, clear);

  return result;
}

export type { PortDbRow };
