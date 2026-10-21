import type { PortRow } from "@sys4sys/shared";
import { decodeWslOutput, runFile, stripAnsi } from "./exec.js";

export interface WslDistro {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

async function wsl(args: string[], timeoutMs = 30_000): Promise<string> {
  return decodeWslOutput(await runFile("wsl.exe", args, timeoutMs));
}

export async function listDistroStates(): Promise<WslDistro[]> {
  const raw = await wsl(["-l", "-v"], 10_000);
  const distros: WslDistro[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const clean = stripAnsi(line)
      .replace(/\uFEFF/g, "")
      .trimEnd();
    if (!clean.trim()) continue;
    if (/^NAME\s+STATE\b/i.test(clean.trim())) continue;

    const match = clean.match(
      /^(\*)?\s*(.+?)\s+(Running|Stopped|Installing|Uninstalling|Converting|Starting|Not installed)\s+(\d+)\s*$/i,
    );
    if (!match) continue;

    const [, star, name, state, version] = match;
    distros.push({
      name: (name ?? "").trim(),
      state: state ?? "Unknown",
      version: Number(version ?? 0),
      isDefault: Boolean(star),
    });
  }

  return distros;
}

interface WslProc {
  ppid: number;
  commandLine: string;
  startedAt: Date | null;
}

export interface WslScanResult {
  rows: PortRow[];
  elapsedMs: number;
}

export async function scanWslDistro(distro: string): Promise<WslScanResult> {
  const started = performance.now();
  const [ssOut, psOut] = await Promise.all([
    wsl(["-d", distro, "--", "ss", "-H", "-tulpn"]),
    wsl(["-d", distro, "--", "ps", "-eo", "pid=,ppid=,etimes=,args="]),
  ]);

  const now = Date.now();
  const procs = new Map<number, WslProc>();
  for (const line of psOut.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const elapsedSec = Number(match[3]);
    procs.set(Number(match[1]), {
      ppid: Number(match[2]),
      commandLine: (match[4] ?? "").trim(),
      startedAt: Number.isFinite(elapsedSec)
        ? new Date(now - elapsedSec * 1000)
        : null,
    });
  }

  const rows: PortRow[] = [];
  for (const line of ssOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;

    const protocol = parts[0];
    const local = parts[4];
    if ((protocol !== "tcp" && protocol !== "udp") || !local) continue;

    const separator = local.lastIndexOf(":");
    if (separator < 0) continue;

    const address = local.slice(0, separator);
    const port = Number(local.slice(separator + 1));
    if (!Number.isInteger(port)) continue;

    const processMatch = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = processMatch ? Number(processMatch[2]) : null;
    const proc = pid !== null ? procs.get(pid) : undefined;

    rows.push({
      // WSL 3.x は distro 間でネットワーク名前空間を共有する。
      // ポートの scope は "wsl" に統一し、PID の帰属先を pidScope に持つ。
      scope: "wsl",
      pidScope: distro,
      seenIn: [distro],
      protocol,
      address,
      port,
      pid,
      ppid: proc?.ppid ?? null,
      process: processMatch
        ? (processMatch[1] ?? null)
        : (proc?.commandLine.split(/\s+/)[0] ?? null),
      commandLine: proc?.commandLine ?? null,
      startedAt: proc?.startedAt?.toISOString() ?? null,
    });
  }

  return { rows, elapsedMs: performance.now() - started };
}
