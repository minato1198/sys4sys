import { fileURLToPath } from "node:url";
import type { PortRow } from "@sys4sys/shared";
import { decodeWslOutput, runFile } from "./exec.js";

const SCRIPT_PATH = fileURLToPath(
  new URL("../scripts/scan-windows.ps1", import.meta.url),
);

interface RawWindowsPort {
  protocol?: string;
  address?: string;
  port?: number;
  pid?: number;
  process?: string | null;
  path?: string | null;
  commandLine?: string | null;
}

export interface WindowsScanResult {
  rows: PortRow[];
  elapsedMs: number;
  shell: string;
}

export async function scanWindows(): Promise<WindowsScanResult> {
  const started = performance.now();
  let lastError: unknown = null;

  for (const shell of ["pwsh.exe", "powershell.exe"]) {
    try {
      const stdout = await runFile(shell, [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        SCRIPT_PATH,
      ]);
      const text = decodeWslOutput(stdout).trim();
      if (!text) {
        return { rows: [], elapsedMs: performance.now() - started, shell };
      }

      const parsed: unknown = JSON.parse(text);
      const raw: RawWindowsPort[] = Array.isArray(parsed)
        ? (parsed as RawWindowsPort[])
        : [parsed as RawWindowsPort];

      const rows: PortRow[] = raw
        .filter(
          (r) =>
            (r.protocol === "tcp" || r.protocol === "udp") &&
            typeof r.port === "number",
        )
        .map((r) => ({
          scope: "windows",
          pidScope: null,
          protocol: r.protocol as "tcp" | "udp",
          address: r.address ?? "",
          port: r.port as number,
          pid: typeof r.pid === "number" ? r.pid : null,
          process: r.process ?? null,
          processPath: r.path ?? null,
          commandLine: r.commandLine ?? null,
        }));

      return { rows, elapsedMs: performance.now() - started, shell };
    } catch (error) {
      lastError = error;
    }
  }

  const message =
    lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Windows port scan failed (pwsh / powershell). ${message}`);
}
