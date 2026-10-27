"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function ConfirmDialog({
  open,
  title,
  description,
  target,
  impact,
  confirmLabel = "実行する",
  cancelLabel = "キャンセル",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  target?: ReactNode;
  impact?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      className="w-[min(92vw,34rem)] rounded-2xl border border-border bg-surface p-0 text-fg shadow-xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? (
          <p
            id={descriptionId}
            className="mt-1 text-sm leading-relaxed text-fg-muted"
          >
            {description}
          </p>
        ) : null}
      </div>

      <div className="space-y-4 px-5 py-4">
        {target ? <div className="text-sm text-fg">{target}</div> : null}
        {impact ? (
          <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm leading-relaxed text-danger">
            {impact}
          </div>
        ) : null}
        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
        <button
          type="button"
          autoFocus
          onClick={onCancel}
          disabled={busy}
          className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-fg transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="min-h-11 rounded-lg bg-danger-solid px-4 text-sm font-semibold text-danger-solid-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "処理中…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
