import { describe, expect, it } from "vitest";
import { evaluateRestart, type RestartContext } from "./index.js";

const base: RestartContext = {
  phase: "auto",
  enabled: true,
  healthy: false,
  consecutiveFailures: 3,
  failureThreshold: 3,
  crashLoop: false,
  portConflict: false,
  resourceExhausted: false,
  attemptsInWindow: 0,
  maxAttempts: 3,
  cooldownRemainingSec: 0,
};

describe("evaluateRestart", () => {
  it("does nothing when the service is healthy", () => {
    expect(evaluateRestart({ ...base, healthy: true }).action).toBe("none");
  });

  it("only notifies in observe phase", () => {
    const decision = evaluateRestart({ ...base, phase: "observe" });
    expect(decision.action).toBe("notify");
  });

  it("requests approval in approve phase", () => {
    const decision = evaluateRestart({ ...base, phase: "approve" });
    expect(decision.action).toBe("request_approval");
  });

  it("restarts in auto phase when all guards pass", () => {
    expect(evaluateRestart(base).action).toBe("restart");
  });

  it("waits for the failure threshold", () => {
    expect(evaluateRestart({ ...base, consecutiveFailures: 2 }).action).toBe(
      "none",
    );
  });

  it("escalates on crash loop instead of restarting", () => {
    expect(evaluateRestart({ ...base, crashLoop: true }).action).toBe(
      "escalate",
    );
  });

  it("escalates on port conflict", () => {
    expect(evaluateRestart({ ...base, portConflict: true }).action).toBe(
      "escalate",
    );
  });

  it("escalates after max attempts", () => {
    expect(evaluateRestart({ ...base, attemptsInWindow: 3 }).action).toBe(
      "escalate",
    );
  });

  it("escalates when the previous restart failed verification", () => {
    expect(evaluateRestart({ ...base, lastVerifyFailed: true }).action).toBe(
      "escalate",
    );
  });

  it("notifies while cooling down", () => {
    expect(evaluateRestart({ ...base, cooldownRemainingSec: 30 }).action).toBe(
      "notify",
    );
  });
});
