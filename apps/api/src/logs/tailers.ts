import { promises as fs } from "node:fs";
import { eq } from "drizzle-orm";
import { decodeWslOutput, listDistroStates, runFile } from "@sys4sys/agent";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { hosts, logSources } from "../db/schema.js";
import { ingestLogs } from "./ingest.js";

type LogSourceRow = typeof logSources.$inferSelect;

interface TailerState {
  sourceId: string;
  hostId: string;
  serviceId: string | null;
  type: "file" | "wsl_file";
  path: string;
  distro: string | null;
  offset: number;
  carry: string;
  initialized: boolean;
  running: boolean;
  timer?: NodeJS.Timeout;
}

interface ReadResult {
  text: string;
  size: number;
  dropped: boolean;
}

const tailers = new Map<string, TailerState>();

let distroCache: { at: number; states: Map<string, string> } | null = null;

async function distroRunning(distro: string): Promise<boolean> {
  if (!distroCache || Date.now() - distroCache.at > 5000) {
    try {
      const distros = await listDistroStates();
      distroCache = {
        at: Date.now(),
        states: new Map(distros.map((item) => [item.name, item.state])),
      };
    } catch {
      return false;
    }
  }
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
  if (size <= start) return { text: "", size, dropped };

  const length = size - start;
  const handle = await fs.open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return { text: buffer.toString("utf8"), size, dropped };
  } finally {
    await handle.close();
  }
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
  if (size <= start) return { text: "", size, dropped };

  const output = await runFile(
    "wsl.exe",
    ["-d", distro, "--", "tail", "-c", `+${start + 1}`, "--", path],
    15_000,
  );
  return { text: decodeWslOutput(output), size, dropped };
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

    if (result.text.length === 0) {
      if (result.size !== state.offset) {
        state.offset = result.size;
        if (result.dropped) state.carry = "";
      }
      return;
    }

    const combined = (result.dropped ? "" : state.carry) + result.text;
    const lines = combined.split(/\r?\n/);
    const carry = lines.pop() ?? "";
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
    state.carry =
      carry.length > 64 * 1024 ? carry.slice(carry.length - 64 * 1024) : carry;
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
    carry: "",
    initialized: false,
    running: false,
  };
  tailers.set(row.id, state);

  // 既存のログを大量に取り込まないよう、初期位置はファイル末尾。
  await initialize(state);

  const timer = setInterval(() => {
    void tick(state);
  }, config.LOG_TAIL_POLL_MS);
  timer.unref();
  state.timer = timer;
}

export async function refreshLogTailer(sourceId: string): Promise<void> {
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
    await startTailer(row);
  }
}

export function stopAllLogTailers(): void {
  for (const sourceId of [...tailers.keys()]) stopTailer(sourceId);
}

export function activeTailerCount(): number {
  return tailers.size;
}
