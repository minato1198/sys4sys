#!/usr/bin/env node
/**
 * sys4sys M1 spike: Windows + WSL port scanner
 *
 * 目的:
 *  - Windows / WSL の待受ポートとプロセスを 1 つの形に正規化できるか検証する
 *  - wsl.exe の出力エンコーディング（UTF-16LE）と PID 名前空間の扱いを確認する
 *  - WSL2 の localhost フォワーディングが Windows 側からどう見えるかを確認する
 *
 * 使い方:
 *   node spike/portscan.mjs                 # 全ホストをテーブル表示
 *   node spike/portscan.mjs --json          # JSON のみ
 *   node spike/portscan.mjs --host windows
 *   node spike/portscan.mjs --host wsl:OpenClaw
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const includeStopped = args.includes("--start-stopped");
const hostFilter = (() => {
  const i = args.indexOf("--host");
  return i >= 0 ? args[i + 1] : "all";
})();

// ---------------------------------------------------------------------------
// wsl.exe の出力はパイプ経由だと UTF-16LE + BOM になることがある。
// BOM / NUL の密度から判定してデコードする。
// ---------------------------------------------------------------------------
export function decodeWslOutput(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  let nul = 0;
  const sample = Math.min(buf.length, 4096);
  for (let i = 0; i < sample; i++) if (buf[i] === 0) nul++;
  const text =
    nul > sample * 0.25 ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

function stripAnsi(s) {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const WINDOWS_SCRIPT = fileURLToPath(
  new URL("./scan-windows.ps1", import.meta.url),
);

async function scanWindows() {
  const started = performance.now();
  const candidates = ["pwsh.exe", "powershell.exe"];
  let lastError;

  for (const exe of candidates) {
    try {
      const { stdout } = await execFileAsync(
        exe,
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          WINDOWS_SCRIPT,
        ],
        {
          maxBuffer: 32 * 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
          encoding: "buffer",
        },
      );
      const text = decodeWslOutput(
        Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      ).trim();
      if (!text) return { rows: [], elapsedMs: performance.now() - started };
      const parsed = JSON.parse(text);
      const rows = (Array.isArray(parsed) ? parsed : [parsed])
        .filter((r) => r && typeof r.port === "number")
        .map((r) => ({
          scope: "windows",
          protocol: r.protocol,
          address: r.address ?? "",
          port: r.port,
          pid: r.pid ?? null,
          process: r.process ?? null,
          commandLine: r.commandLine ?? null,
          path: r.path ?? null,
        }));
      return { rows, elapsedMs: performance.now() - started, exe };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Windows scan failed: ${lastError?.message ?? "unknown"}`);
}

// ---------------------------------------------------------------------------
// WSL
// ---------------------------------------------------------------------------
async function wsl(args, { timeout = 30_000 } = {}) {
  const { stdout } = await execFileAsync("wsl.exe", args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    windowsHide: true,
    encoding: "buffer",
  });
  return decodeWslOutput(
    Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
  );
}

export async function listDistroStates() {
  const raw = await wsl(["-l", "-v"]);
  const states = [];
  for (const line of raw.split(/\r?\n/)) {
    const clean = stripAnsi(line)
      .replace(/\uFEFF/g, "")
      .trimEnd();
    if (!clean.trim()) continue;
    if (/^NAME\s+STATE\b/i.test(clean.trim())) continue;
    const m = clean.match(
      /^(\*)?\s*(.+?)\s+(Running|Stopped|Installing|Uninstalling|Converting|Starting|Not installed)\s+(\d+)\s*$/i,
    );
    if (!m) continue;
    states.push({
      name: m[2].trim(),
      state: m[3],
      version: Number(m[4]),
      isDefault: Boolean(m[1]),
    });
  }
  return states;
}

export async function listDistros() {
  return (await listDistroStates()).map((d) => d.name);
}

async function scanWsl(distro) {
  const started = performance.now();
  const [ssOut, psOut] = await Promise.all([
    wsl(["-d", distro, "--", "ss", "-H", "-tulpn"]),
    wsl(["-d", distro, "--", "ps", "-eo", "pid=,ppid=,args="]),
  ]);

  const procs = new Map();
  for (const line of psOut.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.set(Number(m[1]), { ppid: Number(m[2]), commandLine: m[3].trim() });
  }

  const rows = [];
  for (const line of ssOut.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [protocol, , , , local] = parts;
    if (protocol !== "tcp" && protocol !== "udp") continue;

    const idx = local.lastIndexOf(":");
    if (idx < 0) continue;
    const address = local.slice(0, idx);
    const port = Number(local.slice(idx + 1));
    if (!Number.isInteger(port)) continue;

    const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    const pid = pm ? Number(pm[2]) : null;
    const proc = pid != null ? procs.get(pid) : undefined;

    rows.push({
      // WSL 3.x では distro 間でネットワーク名前空間が共有されるため、
      // ポートの scope は "wsl" に統一し、PID の帰属先を pidScope に持つ。
      scope: "wsl",
      pidScope: distro,
      protocol,
      address,
      port,
      pid,
      process: pm ? pm[1] : (proc?.commandLine?.split(/\s+/)[0] ?? null),
      commandLine: proc?.commandLine ?? null,
      ppid: proc?.ppid ?? null,
    });
  }

  return { rows, elapsedMs: performance.now() - started };
}

/**
 * 共有ネットワーク名前空間のため、同じポートが複数 distro から見える。
 * 1 ポート 1 行にまとめ、PID を観測できた distro を pidScope として残す。
 */
function mergeWslRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = `${r.protocol}|${r.address}|${r.port}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...r, seenIn: [r.pidScope] });
      continue;
    }
    if (!cur.pidScope && r.pidScope) {
      Object.assign(cur, {
        pid: r.pid,
        process: r.process,
        commandLine: r.commandLine,
        ppid: r.ppid,
        pidScope: r.pidScope,
      });
    }
    if (r.pidScope && !cur.seenIn.includes(r.pidScope))
      cur.seenIn.push(r.pidScope);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// 正規化・重複除去・WSL フォワーディング推定
// ---------------------------------------------------------------------------
function normalize(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const key = [r.scope, r.protocol, r.address, r.port, r.pid].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function annotateWslForwarding(all) {
  const wslPorts = new Set(
    all.filter((r) => r.scope === "wsl").map((r) => `${r.protocol}:${r.port}`),
  );
  const forwarderNames = /^(system|wslrelay|wslservice|vmwp|vmmem)/i;

  return all.map((r) => {
    if (r.scope !== "windows") return r;
    const looksLikeRelay =
      r.pid === 4 || (r.process && forwarderNames.test(r.process));
    if (looksLikeRelay && wslPorts.has(`${r.protocol}:${r.port}`)) {
      return { ...r, likelyWslForward: true };
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------
function printTable(rows, results) {
  const pad = (s, n) => {
    const str = String(s ?? "-");
    // 全角文字は幅 2 として概算
    const width = [...str].reduce(
      (w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1),
      0,
    );
    return str + " ".repeat(Math.max(0, n - width));
  };

  const header = [
    pad("SCOPE", 9),
    pad("PID_SCOPE", 14),
    pad("PROTO", 5),
    pad("ADDRESS", 18),
    pad("PORT", 6),
    pad("PID", 7),
    pad("PROCESS", 22),
    "COMMAND",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  const sorted = [...rows].sort(
    (a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.port - b.port ||
      a.protocol.localeCompare(b.protocol) ||
      String(a.address).localeCompare(String(b.address)),
  );
  for (const r of sorted) {
    console.log(
      [
        pad(r.scope, 9),
        pad(r.pidScope, 14),
        pad(r.protocol, 5),
        pad(r.address, 18),
        pad(r.port, 6),
        pad(r.pid, 7),
        pad(r.process, 22),
        `${r.commandLine ?? ""}${r.likelyWslForward ? "  [likely WSL forward]" : ""}`.trim(),
      ].join(" "),
    );
  }

  console.log("");
  console.log("scan times:");
  for (const [scope, r] of Object.entries(results)) {
    console.log(
      `  ${scope}: ${r.rows.length} rows, ${r.elapsedMs.toFixed(0)} ms`,
    );
  }
  const wsl = sorted.filter((r) => r.scope === "wsl");
  const fwd = sorted.filter((r) => r.likelyWslForward);
  console.log(
    `  total: ${sorted.length} rows (wsl: ${wsl.length}, likely WSL forward: ${fwd.length})`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const results = {};
  const all = [];

  const wantWindows = hostFilter === "all" || hostFilter === "windows";
  if (wantWindows) {
    const r = await scanWindows();
    results.windows = r;
    all.push(...r.rows);
  }

  const distroStates = await listDistroStates();
  const skipped = [];
  let wantedDistros = [];

  if (hostFilter === "all") {
    for (const d of distroStates) {
      if (d.state === "Running" || includeStopped) wantedDistros.push(d.name);
      else skipped.push({ distro: d.name, error: `not running (${d.state})` });
    }
  } else if (hostFilter.startsWith("wsl:")) {
    const name = hostFilter.slice(4);
    const st = distroStates.find((d) => d.name === name);
    if (!st) {
      skipped.push({ distro: name, error: "distro not found" });
    } else if (st.state !== "Running" && !includeStopped) {
      skipped.push({
        distro: name,
        error: `not running (${st.state}); use --start-stopped`,
      });
    } else {
      wantedDistros = [name];
    }
  }

  const wslRows = [];
  for (const distro of wantedDistros) {
    try {
      const r = await scanWsl(distro);
      results[`wsl:${distro}`] = r;
      wslRows.push(...r.rows);
    } catch (err) {
      skipped.push({ distro, error: err.message.split("\n")[0] });
    }
  }
  all.push(...mergeWslRows(wslRows));

  const rows = annotateWslForwarding(normalize(all));
  if (jsonOnly) {
    console.log(
      JSON.stringify(
        {
          scannedAt: new Date().toISOString(),
          distroStates,
          results,
          skipped,
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`sys4sys portscan spike — ${new Date().toISOString()}`);
  console.log(
    `distros: ${distroStates.map((d) => `${d.name}(${d.state})`).join(", ") || "(none)"}`,
  );
  if (skipped.length) {
    console.log("skipped:");
    for (const s of skipped) console.log(`  ${s.distro}: ${s.error}`);
  }
  console.log("");
  printTable(rows, results);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack ?? err.message);
    process.exit(1);
  });
}
