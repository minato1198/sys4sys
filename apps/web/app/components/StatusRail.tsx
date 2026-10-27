"use client";

export function StatusRail({
  error,
  scannedAt,
  listeningCount,
  reservationCount,
  conflictCount,
  relayCount,
  canOperate,
  onAddReservation,
}: {
  error: string | null;
  scannedAt: string;
  listeningCount: number | string;
  reservationCount: number;
  conflictCount: number;
  relayCount: number;
  canOperate: boolean;
  onAddReservation: () => void;
}) {
  const railTone =
    conflictCount > 0
      ? "border-danger/40 bg-danger/10"
      : "border-border bg-surface";

  return (
    <section
      aria-label="ポート状態"
      className={`mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border px-4 py-3 ${railTone}`}
    >
      <div className="flex items-center gap-2 text-sm text-fg">
        <span
          aria-hidden="true"
          className={`size-2 rounded-full ${error ? "bg-danger" : "bg-success"}`}
        />
        <span className="font-medium">
          {error ? "API 接続エラー" : `最終スキャン ${scannedAt}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Metric
          label="競合"
          value={conflictCount}
          tone={conflictCount > 0 ? "danger" : "default"}
        />
        <Metric label="予約" value={reservationCount} tone="good" />
        <Metric label="待受" value={listeningCount} />
        <Metric
          label="WSL relay"
          value={relayCount}
          tone={relayCount > 0 ? "warn" : "default"}
        />
      </div>

      <div className="ml-auto flex items-center gap-3">
        {canOperate ? (
          <button
            type="button"
            onClick={onAddReservation}
            className="min-h-11 rounded-md bg-accent px-3 text-sm font-semibold text-accent-fg transition hover:bg-accent/90"
          >
            予約を追加
          </button>
        ) : (
          <span className="text-sm text-fg-muted">
            予約には operator 以上の権限が必要です。
          </span>
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "good" | "warn" | "danger";
}) {
  const valueTone =
    tone === "good"
      ? "text-success"
      : tone === "warn"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : "text-fg";

  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <span className={`font-mono text-base tabular-nums ${valueTone}`}>
        {value}
      </span>
    </div>
  );
}
