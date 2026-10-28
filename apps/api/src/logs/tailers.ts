import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { decodeWslOutput, listDistroStates, runFile } from "@sys4sys/agent";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { hosts, logSources } from "../db/schema.js";
import { ingestLogs } from "./ingest.js";
import { ProcessLineDecoder } from "./process-lines.js";

type LogSourceRow = typeof logSources.$inferSelect;

interface TailerState {
  sourceId: string;
  hostId: string;
  serviceId: string | null;
  type: "file" | "wsl_file";
  path: string;
  distro: string | null;
  offset: number;
  decoder: ProcessLineDecoder;
  initialized: boolean;
  running: boolean;
  timer?: NodeJS.Timeout;
}

interface ReadResult {
  bytes: Buffer;
  size: number;
  dropped: boolean;
}

const tailers = new Map<string, TailerState>();
const DISTRO_CACHE_TTL_MS = 30_000;

let distroCache: {
  at: number;
  states: Map<string, string>;
  error: string | null;
} | null = null;
let lastDistroWarning: string | null = null;

async function distroRunning(distro: string): Promise<boolean> {
  if (!distroCache || Date.now() - distroCache.at > DISTRO_CACHE_TTL_MS) {
    try {
      const distros = await listDistroStates();
      distroCache = {
        at: Date.now(),
        states: new Map(distros.map((item) => [item.name, item.state])),
        error: null,
      };
      lastDistroWarning = null;
    } catch (error) {
      const message =
        error instanceof Error
          ? (error.message.split("\n")[0] ?? error.message)
          : String(error);
      distroCache = {
        at: Date.now(),
        states: new Map(),
        error: message,
      };
      if (lastDistroWarning !== message) {
        console.warn(`[logs] WSL distro detection failed: ${message}`);
        lastDistroWarning = message;
      }
    }
  }
  if (distroCache.error) return false;
  return distroCache.states.get(distro) === "Running";
}

async function statWindows(path: string): Promise<number> {
  try {
    return (await fs.stat(path)).size;
  } catch {
    return 0;
  }
}

async function statWsl(distro: string, path: string): Promise<number> {
  const output = decodeWslOutput(
    await runFile(
      "wsl.exe",
      ["-d", distro, "--", "stat", "-c", "%s", "--", path],
      10_000,
    ),
  );
  const size = Number(output.trim());
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

async function readWindows(path: string, offset: number): Promise<ReadResult> {
  const size = await statWindows(path);
  let start = offset;
  let dropped = false;
  if (size < start) {
    start = 0;
    dropped = true;
  }
  if (size - start > config.LOG_MAX_TAIL_BYTES) {
    start = size - config.LOG_MAX_TAIL_BYTES;
    dropped = true;
  }
  if (size <= start) return { bytes: Buffer.alloc(0), size, dropped };

  const length = size - start;
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { bytes: buffer, size, dropped };
  } finally {
    await handle.close();
  }
}

/**
 * wsl.exe がファイル内容を UTF-16LE に変換して返す環境があるため、
 * その場合だけ UTF-8 バイト列へ正規化する。Shift-JIS などの生バイトは
 * そのまま ProcessLineDecoder に渡す。
 */
function normalizeWslLogBytes(buffer: Buffer): Buffer {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return Buffer.from(decodeWslOutput(buffer), "utf8");
  }
  const sample = Math.min(buffer.length, 4096);
  let nul = 0;
  for (let i = 0; i < sample; i += 1) {
    if (buffer[i] === 0) nul += 1;
  }
  if (nul > sample * 0.1) {
    return Buffer.from(decodeWslOutput(buffer), "utf8");
  }
  return buffer;
}

async function readWsl(
  distro: string,
  path: string,
  offset: number,
): Promise<ReadResult> {
  const size = await statWsl(distro, path);
  let start = offset;
  let dropped = false;
  if (size < start) {
    start = 0;
    dropped = true;
  }
  if (size - start > config.LOG_MAX_TAIL_BYTES) {
    start = size - config.LOG_MAX_TAIL_BYTES;
    dropped = true;
  }
  if (size <= start) return { bytes: Buffer.alloc(0), size, dropped };

  const output = await runFile(
    "wsl.exe",
    ["-d", distro, "--", "tail", "-c", `+${start + 1}`, "--", path],
    15_000,
  );
  return { bytes: normalizeWslLogBytes(output), size, dropped };
}

async function initialize(state: TailerState): Promise<void> {
  if (state.initialized) return;

  if (state.type === "file") {
    state.offset = await statWindows(state.path);
    state.initialized = true;
    return;
  }

  if (!state.distro) return;
  if (!(await distroRunning(state.distro))) return;

  try {
    state.offset = await statWsl(state.distro, state.path);
  } catch {
    state.offset = 0;
  }
  state.initialized = true;
}

async function tick(state: TailerState): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    await initialize(state);
    if (!state.initialized) return;

    if (state.type === "wsl_file") {
      if (!state.distro || !(await distroRunning(state.distro))) return;
    }

    const result =
      state.type === "file"
        ? await readWindows(state.path, state.offset)
        : await readWsl(state.distro ?? "", state.path, state.offset);

    if (result.dropped) {
      state.decoder = new ProcessLineDecoder();
    }

    if (result.bytes.length === 0) {
      if (result.size !== state.offset) {
        state.offset = result.size;
      }
      return;
    }

    const lines = state.decoder.push(result.bytes);
    const serviceId = state.serviceId ?? `host:${state.hostId}`;

    const inputs = lines
      .filter((line) => line.trim().length > 0)
      .map((line) => ({
        hostId: state.hostId,
        serviceId,
        stream: "file" as const,
        message: line,
        ts: new Date(),
      }));

    if (inputs.length > 0) {
      await ingestLogs(inputs);
    }

    state.offset = result.size;
  } catch (error) {
    console.warn(
      `[logs] tail ${state.sourceId} failed: ${
        error instanceof Error ? error.message.split("\n")[0] : String(error)
      }`,
    );
  } finally {
    state.running = false;
  }
}

function stopTailer(sourceId: string): void {
  const state = tailers.get(sourceId);
  if (!state) return;
  if (state.timer) clearInterval(state.timer);
  tailers.delete(sourceId);
}

async function startTailer(row: LogSourceRow): Promise<void> {
  stopTailer(row.id);
  if (!row.enabled) return;
  if (row.type !== "file" && row.type !== "wsl_file") return;

  const path =
    typeof row.config.path === "string" ? row.config.path.trim() : "";
  if (!path) return;

  const [host] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.id, row.hostId))
    .limit(1);
  if (!host || !host.enabled) return;
  if (row.type === "file" && host.kind !== "windows") return;
  if (row.type === "wsl_file" && host.kind !== "wsl") return;

  const state: TailerState = {
    sourceId: row.id,
    hostId: row.hostId,
    serviceId: row.serviceId,
    type: row.type,
    path,
    distro: host.distro,
    offset: 0,
    decoder: new ProcessLineDecoder(),
    initialized: false,
    running: false,
  };
  tailers.set(row.id, state);

  try {
    // 既存のログを大量に取り込まないよう、初期位置はファイル末尾。
    await initialize(state);
  } catch (error) {
    stopTailer(row.id);
    throw error;
  }

  const timer = setInterval(() => {
    void tick(state);
  }, config.LOG_TAIL_POLL_MS);
  timer.unref();
  state.timer = timer;
}

export async function refreshLogTailer(sourceId: string): Promise<void> {
  // 手動 refresh は WSL 復旧直後の操作を想定しているため、
  // ネガティブキャッシュを待たずに再検出する。
  distroCache = null;
  lastDistroWarning = null;
  stopTailer(sourceId);
  const [row] = await db
    .select()
    .from(logSources)
    .where(eq(logSources.id, sourceId))
    .limit(1);
  if (row) await startTailer(row);
}

export async function startAllLogTailers(): Promise<void> {
  const rows = await db.select().from(logSources);
  for (const row of rows) {
    try {
      await startTailer(row);
    } catch (error) {
      console.warn(
        `[logs] tailer ${row.id} could not start: ${
          error instanceof Error
            ? (error.message.split("\n")[0] ?? error.message)
            : String(error)
        }`,
      );
    }
  }
}

export function stopAllLogTailers(): void {
  for (const sourceId of [...tailers.keys()]) stopTailer(sourceId);
}

export function activeTailerCount(): number {
  return tailers.size;
}
