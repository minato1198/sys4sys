import type { ReactNode } from "react";

export function EmptyState({
  title,
  description,
  action,
  compact = false,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        compact
          ? "flex flex-col items-center gap-2 px-4 py-6 text-center"
          : "flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface-muted/50 px-6 py-10 text-center"
      }
    >
      <p className="text-sm font-medium text-fg">{title}</p>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed text-fg-muted">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
