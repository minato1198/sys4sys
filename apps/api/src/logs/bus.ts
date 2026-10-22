import type { LogEventView } from "./ingest.js";

type Listener = (event: LogEventView) => void;

const listeners = new Set<Listener>();

export function subscribeLogs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLog(event: LogEventView): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // 1 つの SSE 接続の失敗で他の購読者を止めない
    }
  }
}

export function listenerCount(): number {
  return listeners.size;
}
