"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "../ui/EmptyState";
import { PortCardList } from "./PortCard";
import {
  PortFilters,
  type PortFilterValue,
  type PortSortValue,
} from "./PortFilters";
import { PortTable } from "./PortTable";
import { matchesPortSearch } from "./port-utils";
import type { PortItem, PortOwner } from "./types";

export function PortLedger({
  items,
  loading,
  refreshing,
  canOperate,
  killBusyKey,
  onRescan,
  onHistory,
  onKillOwner,
}: {
  items: PortItem[];
  loading: boolean;
  refreshing: boolean;
  canOperate: boolean;
  killBusyKey: string | null;
  onRescan: () => void;
  onHistory: (item: PortItem) => void;
  onKillOwner: (item: PortItem, owner: PortOwner) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PortFilterValue>("all");
  const [sort, setSort] = useState<PortSortValue>("port-asc");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const conflictCount = items.filter((item) => item.conflict).length;
  const windowsCount = items.filter((item) => item.scope === "windows").length;
  const wslCount = items.filter((item) => item.scope === "wsl").length;
  const relayCount = items.filter((item) => item.likelyWslForward).length;

  const visibleItems = useMemo(() => {
    const filtered = items.filter((item) => {
      if (filter === "conflict") return item.conflict;
      if (filter === "reserved") return item.reservation !== null;
      if (filter === "windows") return item.scope === "windows";
      if (filter === "wsl") return item.scope === "wsl";
      return true;
    });

    return filtered
      .filter((item) => matchesPortSearch(item, query))
      .sort((a, b) => {
        if (sort === "scope") {
          if (a.scope !== b.scope) return a.scope === "windows" ? -1 : 1;
          return a.port - b.port;
        }
        if (sort === "conflict") {
          if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
          return a.port - b.port;
        }
        if (sort === "port-desc") return b.port - a.port;
        return a.port - b.port;
      });
  }, [filter, items, query, sort]);

  function toggleExpanded(item: PortItem) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
  }

  function resetFilters() {
    setQuery("");
    setFilter("all");
    setSort("port-asc");
  }

  const hasActiveFilters = query.trim() !== "" || filter !== "all";

  return (
    <section
      aria-busy={refreshing}
      className="mt-6 overflow-hidden rounded-lg border-2 border-border bg-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-base font-semibold text-fg">待受ポート</h2>
          <p className="mt-1 text-sm text-fg-muted">
            Windows と WSL を 1 つのビューに統合。WSL は distro
            間でネットワークを共有します。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-info/30 bg-info/10 px-2 py-1 text-sm text-info">
            Windows {windowsCount}
          </span>
          <span className="rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-sm text-accent">
            WSL {wslCount}
          </span>
          <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-sm text-warning">
            Relay {relayCount}
          </span>
          <span className="font-mono text-sm tabular-nums text-fg-muted">
            {visibleItems.length} / {items.length}
          </span>
        </div>
      </div>

      <PortFilters
        query={query}
        filter={filter}
        sort={sort}
        conflictCount={conflictCount}
        onQueryChange={setQuery}
        onFilterChange={setFilter}
        onSortChange={setSort}
      />

      {loading && items.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-fg-muted">
          スキャン中…
        </div>
      ) : visibleItems.length === 0 ? (
        <EmptyState
          title={
            hasActiveFilters
              ? "条件に一致するポートがありません"
              : "待受ポートが見つかりません"
          }
          description={
            hasActiveFilters
              ? "絞り込み条件を変えるか、解除して再表示してください。"
              : "再スキャンして最新の状態を確認してください。"
          }
          action={
            hasActiveFilters ? (
              <button
                type="button"
                onClick={resetFilters}
                className="min-h-11 rounded-md border border-border px-3 text-sm font-medium text-fg transition hover:bg-surface-muted"
              >
                絞り込みを解除
              </button>
            ) : (
              <button
                type="button"
                onClick={onRescan}
                disabled={refreshing}
                className="min-h-11 rounded-md border border-border px-3 text-sm font-medium text-fg transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {refreshing ? "スキャン中…" : "再スキャン"}
              </button>
            )
          }
        />
      ) : (
        <>
          <PortTable
            items={visibleItems}
            expandedIds={expandedIds}
            canOperate={canOperate}
            killBusyKey={killBusyKey}
            onToggle={toggleExpanded}
            onHistory={onHistory}
            onKillOwner={onKillOwner}
          />
          <PortCardList
            items={visibleItems}
            expandedIds={expandedIds}
            canOperate={canOperate}
            killBusyKey={killBusyKey}
            onToggle={toggleExpanded}
            onHistory={onHistory}
            onKillOwner={onKillOwner}
          />
        </>
      )}
    </section>
  );
}
