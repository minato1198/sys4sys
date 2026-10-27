"use client";

import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

export interface ConfirmRequest {
  title: string;
  description?: string;
  target?: ReactNode;
  impact?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
}

type HandlerResult = string | null | undefined;
type ConfirmHandler = () => Promise<HandlerResult> | HandlerResult;

export function useConfirmDialog() {
  const [action, setAction] = useState<{
    request: ConfirmRequest;
    handler: ConfirmHandler;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setAction(null);
    setError(null);
  }, []);

  const requestConfirm = useCallback(
    (request: ConfirmRequest, handler: ConfirmHandler) => {
      setError(null);
      setAction({ request, handler });
    },
    [],
  );

  const run = useCallback(async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const result = await action.handler();
      setBusy(false);
      if (typeof result === "string" && result) {
        setError(result);
      } else {
        close();
      }
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [action, close]);

  const cancel = useCallback(() => {
    if (!busy) close();
  }, [busy, close]);

  const dialog = action ? (
    <ConfirmDialog
      open
      title={action.request.title}
      description={action.request.description}
      target={action.request.target}
      impact={action.request.impact}
      confirmLabel={action.request.confirmLabel}
      cancelLabel={action.request.cancelLabel}
      busy={busy}
      error={error}
      onConfirm={() => void run()}
      onCancel={cancel}
    />
  ) : null;

  return { requestConfirm, dialog };
}
