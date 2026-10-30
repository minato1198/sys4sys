import { analyzeIncident } from "./analysis.js";

interface AnalysisQueueItem {
  incidentId: string;
  trigger: "auto" | "manual";
  actorUserId: string | null;
  actorLabel: string;
}

const queue: AnalysisQueueItem[] = [];
const queued = new Set<string>();
let running = false;
let stopped = false;

function drain(): void {
  if (running || stopped) return;
  running = true;
  void (async () => {
    while (queue.length > 0 && !stopped) {
      const item = queue.shift();
      if (!item) continue;
      queued.delete(item.incidentId);
      try {
        await analyzeIncident(item.incidentId, {
          trigger: item.trigger,
          actorUserId: item.actorUserId,
          actorLabel: item.actorLabel,
        });
      } catch (error) {
        console.warn(
          `[ai] analysis failed for incident ${item.incidentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  })().finally(() => {
    running = false;
    if (queue.length > 0 && !stopped) drain();
  });
}

export interface EnqueueAnalysisOptions {
  trigger?: "auto" | "manual";
  actorUserId?: string | null;
  actorLabel?: string;
}

/**
 * インシデント作成時に非同期で分析を投入する。同じ ID はキュー内で重複させない。
 * 手動分析の場合は実行者 metadata を保持し、four-eyes 判定に使う。
 */
export function enqueueIncidentAnalysis(
  incidentId: string,
  options: EnqueueAnalysisOptions = {},
): boolean {
  if (stopped || queued.has(incidentId)) return false;
  queued.add(incidentId);
  queue.push({
    incidentId,
    trigger: options.trigger ?? "auto",
    actorUserId: options.actorUserId ?? null,
    actorLabel: options.actorLabel ?? "system:ai",
  });
  drain();
  return true;
}

export function analysisQueueStatus(): {
  queued: number;
  running: boolean;
  stopped: boolean;
} {
  return { queued: queue.length, running, stopped };
}

export function stopAnalysisQueue(): void {
  stopped = true;
  queue.length = 0;
  queued.clear();
}

/** テスト・スモーク用。キューが空になり実行中ジョブが終わるまで待つ。 */
export async function waitForAnalysisIdle(
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!running && queue.length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
