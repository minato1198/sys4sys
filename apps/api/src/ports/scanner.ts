import { randomUUID } from "node:crypto";
import type { DetailedScanResult, ScanOptions } from "@sys4sys/agent";
import { scanPorts } from "@sys4sys/agent";
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
    const pidHostId = row.pidScope ?? null;
    const startedAt = toDate(row.startedAt ?? null);
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
        pid: row.pid,
        ppid: row.ppid ?? null,
        processName: row.process,
        processPath: row.processPath ?? null,
        commandLine: row.commandLine,
        startedAt,
        serviceId,
        firstSeen: now,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: [ports.scope, ports.protocol, ports.address, ports.port],
        set: {
          pidHostId,
          pid: row.pid,
          ppid: row.ppid ?? null,
          processName: row.process,
          processPath: row.processPath ?? null,
          commandLine: row.commandLine,
          startedAt,
          serviceId,
          lastSeen: now,
        },
      });

    const hKey = historyKey({
      scope: row.scope,
      pidHostId,
      protocol: row.protocol,
      address: row.address,
      port: row.port,
      pid: row.pid,
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
      pidHostId,
      protocol: row.protocol,
      address: row.address,
      port: row.port,
      pid: row.pid,
      ppid: row.ppid ?? null,
      processName: row.process,
      processPath: row.processPath ?? null,
      commandLine: row.commandLine,
      startedAt,
      serviceId,
      openedAt: now,
      closedAt: null,
      releasedBy: null,
    });
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

/**
 * スキャンを直列化して DB に反映する。
 * 複数リクエストが同時に来ても、履歴の opened/closed が壊れないようにする。
 */
export function scanAndPersist(
  options: ScanOptions = {},
): Promise<PersistedScan> {
  const result = queue.then(async () => {
    const scan = await scanPorts(options);
    return persistScan(scan);
  });

  queue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

export type { PortDbRow };
