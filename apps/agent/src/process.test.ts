import { afterEach, describe, expect, it, vi } from "vitest";
import { runFile, ExternalCommandError } from "./exec.js";
import { isProcessAlive } from "./process.js";

vi.mock("./exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec.js")>();
  return { ...actual, runFile: vi.fn() };
});

const runFileMock = vi.mocked(runFile);

function commandError(code: number | string, killed = false) {
  return new ExternalCommandError(
    "wsl.exe",
    { code, killed, message: "failed" } as never,
    Buffer.alloc(0),
    Buffer.alloc(0),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  runFileMock.mockReset();
});

describe("isProcessAlive", () => {
  it("returns dead for an invalid pid", async () => {
    expect(await isProcessAlive({ scope: "windows", pid: 0 })).toBe("dead");
  });

  it("returns alive when kill -0 exits 0", async () => {
    runFileMock.mockResolvedValue(Buffer.alloc(0));
    expect(
      await isProcessAlive({ scope: "wsl", pidScope: "Ubuntu", pid: 123 }),
    ).toBe("alive");
  });

  it("returns dead only for kill -0 exit code 1", async () => {
    runFileMock.mockRejectedValue(commandError(1));
    expect(
      await isProcessAlive({ scope: "wsl", pidScope: "Ubuntu", pid: 123 }),
    ).toBe("dead");
  });

  it("returns unknown for WSL command failures and timeouts", async () => {
    runFileMock.mockRejectedValueOnce(commandError("ENOENT"));
    expect(
      await isProcessAlive({ scope: "wsl", pidScope: "Ubuntu", pid: 123 }),
    ).toBe("unknown");

    runFileMock.mockRejectedValueOnce(commandError("ETIMEDOUT", true));
    expect(
      await isProcessAlive({ scope: "wsl", pidScope: "Ubuntu", pid: 123 }),
    ).toBe("unknown");
  });

  it("returns unknown when a WSL pidScope is missing", async () => {
    expect(await isProcessAlive({ scope: "wsl", pid: 123 })).toBe("unknown");
  });

  it("treats Windows EPERM as alive and ESRCH as dead", async () => {
    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(await isProcessAlive({ scope: "windows", pid: 123 })).toBe("alive");

    vi.spyOn(process, "kill").mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    expect(await isProcessAlive({ scope: "windows", pid: 123 })).toBe("dead");
  });
});
