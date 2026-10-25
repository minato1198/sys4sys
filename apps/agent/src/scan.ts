import {
  aggregatePortRows,
  type PortOwner,
  type PortRow,
  type PortScanResult,
  type SkippedDistro,
} from "@sys4sys/shared";
import { scanWindows } from "./windows.js";
import { listDistroStates, scanWslDistro, type WslDistro } from "./wsl.js";

export type ScanScope = "all" | "windows" | "wsl";

export interface ScanOptions {
  scope?: ScanScope;
  /** WSL の特定 distro のみスキャン */
  distro?: string;
  /** 停止中の distro も起動してスキャンする（明示操作） */
  includeStopped?: boolean;
}

export interface ScanTiming {
  rows: number;
  elapsedMs: number;
  shell?: string;
}

export interface DetailedScanResult extends PortScanResult {
  distros: WslDistro[];
  timings: Record<string, ScanTiming>;
}

const relayProcess = /^(system|wslrelay|wslservice|vmwp|vmmem)/i;

function ownerLooksLikeRelay(owner: PortOwner): boolean {
  return owner.pid === 4 || relayProcess.test(owner.process ?? "");
}

function rowLooksLikeWslRelay(row: PortRow): boolean {
  if (row.owners?.length) {
    return row.owners.some(ownerLooksLikeRelay);
  }
  return row.pid === 4 || relayProcess.test(row.process ?? "");
}

function annotateWslForwarding(rows: PortRow[]): PortRow[] {
  const wslPorts = new Set(
    rows.filter((r) => r.scope === "wsl").map((r) => `${r.protocol}:${r.port}`),
  );

  return rows.map((row) => {
    if (row.scope !== "windows") return row;
    if (!rowLooksLikeWslRelay(row)) return row;
    if (!wslPorts.has(`${row.protocol}:${row.port}`)) return row;

    return {
      ...row,
      likelyWslForward: true,
      owners: row.owners?.map((owner) =>
        ownerLooksLikeRelay(owner)
          ? { ...owner, likelyWslForward: true }
          : owner,
      ),
    };
  });
}

function sortRows(rows: PortRow[]): PortRow[] {
  return [...rows].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.port - b.port ||
      a.protocol.localeCompare(b.protocol) ||
      a.address.localeCompare(b.address),
  );
}

export async function scanPorts(
  options: ScanOptions = {},
): Promise<DetailedScanResult> {
  const scope = options.scope ?? "all";
  const distros = await listDistroStates();
  const skipped: SkippedDistro[] = [];
  const timings: Record<string, ScanTiming> = {};
  const rows: PortRow[] = [];
  const wslRows: PortRow[] = [];
  const tasks: Promise<void>[] = [];

  if (scope === "all" || scope === "windows") {
    tasks.push(
      scanWindows().then((result) => {
        rows.push(...result.rows);
        timings["windows"] = {
          rows: result.rows.length,
          elapsedMs: result.elapsedMs,
          shell: result.shell,
        };
      }),
    );
  }

  if (scope === "all" || scope === "wsl") {
    const wanted = options.distro
      ? distros.filter((d) => d.name === options.distro)
      : distros;

    if (options.distro && wanted.length === 0) {
      skipped.push({ distro: options.distro, error: "distro not found" });
    }

    for (const distro of wanted) {
      if (distro.state !== "Running" && !options.includeStopped) {
        skipped.push({
          distro: distro.name,
          error: `not running (${distro.state})`,
        });
        continue;
      }

      tasks.push(
        scanWslDistro(distro.name)
          .then((result) => {
            wslRows.push(...result.rows);
            timings[`wsl:${distro.name}`] = {
              rows: result.rows.length,
              elapsedMs: result.elapsedMs,
            };
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error
                ? error.message.split("\n")[0]
                : String(error);
            skipped.push({
              distro: distro.name,
              error: message ?? "scan failed",
            });
          }),
      );
    }
  }

  await Promise.all(tasks);
  const aggregatedRows = aggregatePortRows([...rows, ...wslRows]);

  return {
    scannedAt: new Date().toISOString(),
    rows: annotateWslForwarding(sortRows(aggregatedRows)),
    skipped,
    distros,
    timings,
  };
}

export type { WslDistro };
