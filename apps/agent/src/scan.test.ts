import type { PortRow } from "@sys4sys/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanPorts } from "./scan.js";
import { listDistroStates, scanWslDistro } from "./wsl.js";
import { scanWindows } from "./windows.js";

vi.mock("./windows.js", () => ({ scanWindows: vi.fn() }));
vi.mock("./wsl.js", () => ({
  listDistroStates: vi.fn(),
  scanWslDistro: vi.fn(),
}));

const scanWindowsMock = vi.mocked(scanWindows);
const listDistroStatesMock = vi.mocked(listDistroStates);
const scanWslDistroMock = vi.mocked(scanWslDistro);

function row(scope: "windows" | "wsl", port: number): PortRow {
  return {
    scope,
    pidScope: scope === "wsl" ? "Ubuntu" : null,
    seenIn: scope === "wsl" ? ["Ubuntu"] : undefined,
    protocol: "tcp",
    address: "127.0.0.1",
    port,
    pid: 100,
    process: "node",
    commandLine: "node server.js",
  };
}

const distros = [
  { name: "Ubuntu", state: "Running", version: 2, isDefault: true },
];

beforeEach(() => {
  vi.resetAllMocks();
});

describe("scanPorts scope isolation", () => {
  it("does not call WSL detection for a Windows-only scan", async () => {
    scanWindowsMock.mockResolvedValue({
      rows: [row("windows", 3000)],
      elapsedMs: 1,
      shell: "pwsh.exe",
    });

    const result = await scanPorts({ scope: "windows" });

    expect(listDistroStatesMock).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.timings.windows).toBeTruthy();
    expect(result.scanErrors).toEqual([]);
  });

  it("keeps Windows working when WSL is unavailable", async () => {
    listDistroStatesMock.mockRejectedValue(new Error("wsl.exe not found"));
    scanWindowsMock.mockResolvedValue({
      rows: [row("windows", 3000)],
      elapsedMs: 1,
      shell: "pwsh.exe",
    });

    const result = await scanPorts({ scope: "all" });

    expect(result.rows).toHaveLength(1);
    expect(result.timings.windows).toBeTruthy();
    expect(result.timings["wsl:Ubuntu"]).toBeUndefined();
    expect(result.scanErrors).toEqual([
      expect.objectContaining({ scope: "wsl" }),
    ]);
  });

  it("reports WSL-only failure without throwing", async () => {
    listDistroStatesMock.mockRejectedValue(new Error("wsl.exe not found"));

    const result = await scanPorts({ scope: "wsl" });

    expect(result.rows).toEqual([]);
    expect(result.timings).toEqual({});
    expect(result.scanErrors).toEqual([
      expect.objectContaining({ scope: "wsl" }),
    ]);
  });

  it("does not treat zero running distros as a WSL failure", async () => {
    listDistroStatesMock.mockResolvedValue([
      { name: "Ubuntu", state: "Stopped", version: 2, isDefault: true },
    ]);

    const result = await scanPorts({ scope: "wsl" });

    expect(result.scanErrors).toEqual([]);
    expect(result.timings).toEqual({});
    expect(result.skipped).toEqual([
      { distro: "Ubuntu", error: "not running (Stopped)" },
    ]);
  });

  it("keeps WSL rows when the Windows scan fails", async () => {
    listDistroStatesMock.mockResolvedValue(distros);
    scanWslDistroMock.mockResolvedValue({
      rows: [row("wsl", 4000)],
      elapsedMs: 1,
      warnings: [],
    });
    scanWindowsMock.mockRejectedValue(new Error("powershell failed"));

    const result = await scanPorts({ scope: "all" });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.scope).toBe("wsl");
    expect(result.timings.windows).toBeUndefined();
    expect(result.timings["wsl:Ubuntu"]).toBeTruthy();
    expect(result.scanErrors).toEqual([
      expect.objectContaining({ scope: "windows" }),
    ]);
  });

  it("reports a WSL distro scan failure without a timing", async () => {
    listDistroStatesMock.mockResolvedValue(distros);
    scanWslDistroMock.mockRejectedValue(new Error("ss failed"));

    const result = await scanPorts({ scope: "wsl" });

    expect(result.timings["wsl:Ubuntu"]).toBeUndefined();
    expect(result.skipped).toEqual([{ distro: "Ubuntu", error: "ss failed" }]);
    expect(result.scanErrors).toEqual([
      expect.objectContaining({ scope: "wsl", distro: "Ubuntu" }),
    ]);
  });

  it("surfaces partial WSL warnings", async () => {
    listDistroStatesMock.mockResolvedValue(distros);
    scanWslDistroMock.mockResolvedValue({
      rows: [row("wsl", 4000)],
      elapsedMs: 1,
      warnings: ["ps failed: missing"],
    });

    const result = await scanPorts({ scope: "wsl" });

    expect(result.warnings).toEqual(["wsl:Ubuntu: ps failed: missing"]);
    expect(result.scanErrors).toEqual([]);
  });
});
