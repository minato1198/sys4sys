import { describe, expect, it } from "vitest";
import { deployConfigSchema, serviceCreateSchema } from "@sys4sys/shared";

describe("deployConfigSchema", () => {
  it("applies safe defaults", () => {
    const parsed = deployConfigSchema.parse({
      command: ["pwsh.exe", "-File", "deploy.ps1"],
    });
    expect(parsed).toMatchObject({
      command: ["pwsh.exe", "-File", "deploy.ps1"],
      timeoutSec: 600,
      restartAfter: true,
      healthTimeoutSec: 120,
    });
  });

  it("rejects empty commands", () => {
    expect(() => deployConfigSchema.parse({ command: [] })).toThrow();
  });

  it("is accepted by serviceCreateSchema", () => {
    const parsed = serviceCreateSchema.parse({
      hostId: "host-1",
      name: "demo-api",
      command: ["node.exe", "dist/server.js"],
      deploy: {
        command: ["pwsh.exe", "-File", "deploy.ps1"],
        cwd: "C:\\repo\\apps\\demo-api",
        restartAfter: false,
      },
    });
    expect(parsed.deploy?.cwd).toBe("C:\\repo\\apps\\demo-api");
    expect(parsed.deploy?.restartAfter).toBe(false);
    expect(parsed.deploy?.timeoutSec).toBe(600);
  });
});
