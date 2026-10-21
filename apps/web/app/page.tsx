"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface PortItem {
  id: string;
  scope: "windows" | "wsl";
  pidScope: string | null;
  seenIn: string[];
  protocol: "tcp" | "udp";
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
  processPath: string | null;
  commandLine: string | null;
  likelyWslForward: boolean;
}

interface PortsResponse {
  scannedAt: string;
  items: PortItem[];
}

function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string | number;
  hint: string;
  tone?: "default" | "good" | "warn";
}) {
  const valueTone =
    tone === "good"
      ? "text-signal-400"
      : tone === "warn"
        ? "text-warn-400"
        : "text-white";
  return (
    <div className="rounded-xl border border-ink-700/70 bg-ink-900/60 p-4 shadow-[0_1px_0_rgba(255,255,255,0.03)_inset]">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-mist-400">
        {label}
      </div>
      <div className={`mt-2 font-mono text-2xl tabular-nums ${valueTone}`}>
        {value}
      </div>
      <div className="mt-1 text-xs text-mist-400">{hint}</div>
    </div>
  );
}

function ScopeBadge({ item }: { item: PortItem }) {
  if (item.scope === "windows") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-sky-400/20 bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
        WIN
        {item.likelyWslForward ? (
          <span className="rounded bg-warn-400/15 px-1 text-[10px] text-warn-400">
            WSL relay
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-signal-400/20 bg-signal-400/10 px-2 py-0.5 text-[11px] font-medium text-signal-400">
      WSL
      {item.pidScope ? (
        <span className="text-[10px] text-mist-400">{item.pidScope}</span>
      ) : null}
    </span>
  );
}

export default function DashboardPage() {
  const [data, setData] = useState<PortsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/ports", { cache: "no-store" });
      if (!response.ok) throw new Error(`API ${response.status}`);
      const json = (await response.json()) as PortsResponse;
      setData(json);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const items = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!data) return [];
    if (!needle) return data.items;
    return data.items.filter((item) =>
      [
        item.process,
        item.commandLine,
        item.address,
        String(item.port),
        item.pidScope,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [data, filter]);

  const wslCount =
    data?.items.filter((item) => item.scope === "wsl").length ?? 0;
  const relayCount =
    data?.items.filter((item) => item.likelyWslForward).length ?? 0;
  const scannedAt = data
    ? new Date(data.scannedAt).toLocaleTimeString("ja-JP", { hour12: false })
    : "—";

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-lg border border-signal-400/30 bg-signal-400/10">
            <span className="font-mono text-sm font-bold text-signal-400">
              s4s
            </span>
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white">
              sys4sys
            </h1>
            <p className="text-xs text-mist-400">
              backend operations / M1 scaffold
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-xs text-mist-400">
            <span
              className={`size-1.5 rounded-full ${error ? "bg-danger-400" : "bg-signal-400"} ${
                error ? "" : "animate-pulse"
              }`}
            />
            {error ? "API 接続エラー" : `最終スキャン ${scannedAt}`}
          </span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 transition hover:border-mist-400/40 hover:text-white"
          >
            再スキャン
          </button>
        </div>
      </header>

      {error ? (
        <div className="mt-6 rounded-lg border border-danger-400/30 bg-danger-400/10 px-4 py-3 text-sm text-danger-400">
          API に接続できません（{error}）。`pnpm dev:api`
          が起動しているか確認してください。
        </div>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Listening ports"
          value={data?.items.length ?? "—"}
          hint="TCP + UDP / 全ホスト"
        />
        <StatCard
          label="WSL ports"
          value={wslCount}
          hint="WSL 共有ネットワーク"
          tone="good"
        />
        <StatCard
          label="WSL relay"
          value={relayCount}
          hint="Windows 側のフォワーディング"
          tone="warn"
        />
        <StatCard label="Refresh" value="10s" hint="ポーリング間隔" />
      </section>

      <section className="mt-6 overflow-hidden rounded-xl border border-ink-700/70 bg-ink-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-white">待受ポート</h2>
            <p className="text-[11px] text-mist-400">
              Windows と WSL を 1 つのビューに統合。WSL は distro
              間でネットワークを共有します。
            </p>
          </div>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="プロセス / ポート / コマンドで絞り込み"
            className="w-full max-w-xs rounded-md border border-ink-700 bg-ink-950/70 px-3 py-1.5 text-xs text-mist-200 placeholder:text-mist-400/60 focus:border-signal-400/40 focus:outline-none"
          />
        </div>

        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[900px] border-collapse text-left">
            <thead>
              <tr className="border-b border-ink-700/70 bg-ink-950/40 text-[10px] uppercase tracking-[0.12em] text-mist-400">
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Port</th>
                <th className="px-4 py-2 font-medium">Bind</th>
                <th className="px-4 py-2 font-medium">Process</th>
                <th className="px-4 py-2 font-medium">PID</th>
                <th className="px-4 py-2 font-medium">Command</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/40">
              {loading && !data ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-sm text-mist-400"
                  >
                    スキャン中…
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-10 text-center text-sm text-mist-400"
                  >
                    該当するポートがありません
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className="group transition hover:bg-ink-800/40"
                  >
                    <td className="whitespace-nowrap px-4 py-2">
                      <ScopeBadge item={item} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-sm tabular-nums text-white">
                      {item.port}
                      <span className="ml-2 text-[10px] uppercase text-mist-400">
                        {item.protocol}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-mist-400">
                      {item.address || "*"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-sm text-mist-200">
                      {item.process ?? <span className="text-mist-400">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs tabular-nums text-mist-400">
                      {item.pid ?? "—"}
                    </td>
                    <td className="max-w-[420px] px-4 py-2">
                      <div
                        className="truncate font-mono text-[11px] text-mist-400"
                        title={item.commandLine ?? ""}
                      >
                        {item.commandLine ?? "—"}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-ink-700/70 px-4 py-2 text-[10px] text-mist-400">
          <span>
            {items.length} / {data?.items.length ?? 0} 行を表示
          </span>
          <span>WSL 3.x の共有ネットワークを考慮してマージ済み</span>
        </div>
      </section>

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 text-[11px] text-mist-400">
        <span>sys4sys v0.1 — ports / logs / incidents / AI reports</span>
        <span className="font-mono">M1: foundation + port management</span>
      </footer>
    </main>
  );
}
