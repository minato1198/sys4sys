import type { PortRow, PortScanResult, SkippedDistro } from "@sys4sys/shared";
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

function mergeWslRows(rows: PortRow[]): PortRow[] {
  const map = new Map<string, PortRow & { seenIn: string[] }>();

  for (const row of rows) {
    const key = `${row.protocol}|${row.address}|${row.port}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...row, seenIn: [...(row.seenIn ?? [])] });
      continue;
    }

    // PID を観測できた distro の情報を優先する
    if (!existing.pidScope && row.pidScope) {
      existing.pid = row.pid;
      existing.process = row.process;
      existing.commandLine = row.commandLine;
      existing.pidScope = row.pidScope;
    }

    for (const distro of row.seenIn ?? []) {
      if (!existing.seenIn.includes(distro)) existing.seenIn.push(distro);
    }
  }

  return [...map.values()];
}

function annotateWslForwarding(rows: PortRow[]): PortRow[] {
  const wslPorts = new Set(
    rows.filter((r) => r.scope === "wsl").map((r) => `${r.protocol}:${r.port}`),
  );
  const relayProcess = /^(system|wslrelay|wslservice|vmwp|vmmem)/i;

  return rows.map((row) => {
    if (row.scope !== "windows") return row;
    const looksLikeRelay =
      row.pid === 4 || relayProcess.test(row.process ?? "");
    if (looksLikeRelay && wslPorts.has(`${row.protocol}:${row.port}`)) {
      return { ...row, likelyWslForward: true };
    }
    return row;
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
  rows.push(...mergeWslRows(wslRows));

  return {
    scannedAt: new Date().toISOString(),
    rows: annotateWslForwarding(sortRows(rows)),
    skipped,
    distros,
    timings,
  };
}

export type { WslDistro };
