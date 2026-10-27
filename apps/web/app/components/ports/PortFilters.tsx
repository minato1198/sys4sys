export type PortFilterValue =
  "all" | "conflict" | "reserved" | "windows" | "wsl";
export type PortSortValue = "port-asc" | "port-desc" | "scope" | "conflict";

const FILTERS: Array<{ value: PortFilterValue; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "conflict", label: "競合" },
  { value: "reserved", label: "予約" },
  { value: "windows", label: "Windows" },
  { value: "wsl", label: "WSL" },
];

export function PortFilters({
  query,
  filter,
  sort,
  conflictCount,
  onQueryChange,
  onFilterChange,
  onSortChange,
}: {
  query: string;
  filter: PortFilterValue;
  sort: PortSortValue;
  conflictCount: number;
  onQueryChange: (value: string) => void;
  onFilterChange: (value: PortFilterValue) => void;
  onSortChange: (value: PortSortValue) => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div
          role="group"
          aria-label="ポートの絞り込み"
          className="flex flex-wrap items-center gap-1.5"
        >
          {FILTERS.map((item) => {
            const active = filter === item.value;
            const badge =
              item.value === "conflict" && conflictCount > 0
                ? ` ${conflictCount}`
                : "";
            return (
              <button
                key={item.value}
                type="button"
                aria-pressed={active}
                onClick={() => onFilterChange(item.value)}
                className={`min-h-11 rounded-md border px-3 text-sm transition ${
                  active
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border bg-surface text-fg-muted hover:text-fg"
                }`}
              >
                {item.label}
                {badge ? (
                  <span className="ml-1 font-mono tabular-nums">{badge}</span>
                ) : null}
              </button>
            );
          })}
        </div>

        <label
          htmlFor="port-sort"
          className="text-sm font-medium text-fg-muted"
        >
          並び順
        </label>
        <select
          id="port-sort"
          value={sort}
          onChange={(event) =>
            onSortChange(event.target.value as PortSortValue)
          }
          className="min-h-11 rounded-md border border-border bg-surface px-2 text-sm text-fg"
        >
          <option value="port-asc">ポート番号（昇順）</option>
          <option value="port-desc">ポート番号（降順）</option>
          <option value="scope">スコープ（Windows / WSL）</option>
          <option value="conflict">競合を優先</option>
        </select>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-[8rem_1fr] sm:items-center">
        <label
          htmlFor="port-search"
          className="text-sm font-medium text-fg-muted"
        >
          検索
        </label>
        <input
          id="port-search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="プロセス / ポート / コマンド / 予約"
          className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
        />
      </div>
    </div>
  );
}
