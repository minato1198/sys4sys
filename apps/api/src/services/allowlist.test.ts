import { describe, expect, it } from "vitest";
import { allowedCommands, isCommandAllowed } from "./allowlist.js";

describe("isCommandAllowed", () => {
  it("allows the default developer commands", () => {
    expect(isCommandAllowed(["node.exe", "worker.js"]).ok).toBe(true);
    expect(isCommandAllowed(["node", "worker.js"]).ok).toBe(true);
    expect(isCommandAllowed(["python.exe", "app.py"]).ok).toBe(true);
  });

  it("allows an executable with an absolute path", () => {
    expect(
      isCommandAllowed(["C:\\Program Files\\nodejs\\node.exe", "app.js"]).ok,
    ).toBe(true);
    expect(isCommandAllowed(["/usr/bin/node", "app.js"]).ok).toBe(true);
  });

  it("rejects shells and unknown binaries", () => {
    expect(isCommandAllowed(["powershell.exe", "-Command", "x"]).ok).toBe(
      false,
    );
    expect(isCommandAllowed(["cmd.exe", "/c", "x"]).ok).toBe(false);
    expect(isCommandAllowed(["unknown-binary"]).ok).toBe(false);
  });

  it("rejects empty commands", () => {
    expect(isCommandAllowed([]).ok).toBe(false);
    expect(isCommandAllowed(["   "]).ok).toBe(false);
  });

  it("normalizes allowlist entries", () => {
    expect(allowedCommands()).toContain("node");
    expect(allowedCommands()).toContain("python");
  });
});
