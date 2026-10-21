import type { RestartPhase } from "@sys4sys/shared";

export type RestartAction =
  "none" | "notify" | "request_approval" | "restart" | "escalate";

export interface RestartContext {
  phase: RestartPhase;
  enabled: boolean;
  healthy: boolean;
  consecutiveFailures: number;
  failureThreshold: number;
  crashLoop: boolean;
  portConflict: boolean;
  resourceExhausted: boolean;
  attemptsInWindow: number;
  maxAttempts: number;
  cooldownRemainingSec: number;
  lastVerifyFailed?: boolean;
}

export interface RestartDecision {
  action: RestartAction;
  reason: string;
}

/**
 * 自動再起動の判断は決定論的に行う。LLM はここに関与しない。
 * 順序が重要: 安全装置（クラッシュループ・競合・上限）を昇格より先に評価する。
 */
export function evaluateRestart(context: RestartContext): RestartDecision {
  if (context.healthy) {
    return { action: "none", reason: "healthy" };
  }

  if (!context.enabled) {
    return { action: "notify", reason: "auto-restart is disabled" };
  }

  if (context.phase === "observe") {
    return { action: "notify", reason: "phase=observe (notify only)" };
  }

  if (context.consecutiveFailures < context.failureThreshold) {
    return { action: "none", reason: "below failure threshold" };
  }

  if (context.portConflict) {
    return {
      action: "escalate",
      reason: "port conflict detected; restart would not help",
    };
  }

  if (context.resourceExhausted) {
    return { action: "escalate", reason: "resource exhaustion suspected" };
  }

  if (context.crashLoop) {
    return {
      action: "escalate",
      reason: "crash loop detected; likely configuration error",
    };
  }

  if (context.lastVerifyFailed) {
    return {
      action: "escalate",
      reason: "previous restart failed verification",
    };
  }

  if (context.attemptsInWindow >= context.maxAttempts) {
    return {
      action: "escalate",
      reason: "max restart attempts reached in window",
    };
  }

  if (context.cooldownRemainingSec > 0) {
    return {
      action: "notify",
      reason: `cooldown active (${context.cooldownRemainingSec}s)`,
    };
  }

  if (context.phase === "approve") {
    return { action: "request_approval", reason: "phase=approve" };
  }

  return { action: "restart", reason: "phase=auto" };
}
