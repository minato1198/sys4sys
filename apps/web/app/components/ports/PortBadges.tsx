import type { PortItem, ReservationView } from "./types";

export function ScopeBadge({ item }: { item: PortItem }) {
  if (item.scope === "windows") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-info/30 bg-info/10 px-2 py-1 text-xs font-medium text-info">
        Windows
        {item.likelyWslForward ? (
          <span className="rounded bg-warning/15 px-1 text-warning">
            WSL relay
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
      WSL
      {item.pidScope ? (
        <span className="text-xs text-fg-muted">{item.pidScope}</span>
      ) : null}
    </span>
  );
}

export function ReservationBadge({
  reservation,
}: {
  reservation: ReservationView | null;
}) {
  if (!reservation) {
    return <span className="text-xs text-fg-muted">—</span>;
  }

  const tone =
    reservation.status === "conflict"
      ? "bg-danger/15 text-danger"
      : "bg-accent/15 text-accent";

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="font-mono text-xs text-fg">{reservation.serviceId}</span>
      <span
        className={`inline-flex w-fit rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}
      >
        {reservation.status === "conflict" ? "競合" : "予約済み"}
      </span>
    </span>
  );
}
