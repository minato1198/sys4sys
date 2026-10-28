import { afterEach, describe, expect, it, vi } from "vitest";
import { runFile } from "./exec.js";
import { scanWindows } from "./windows.js";

vi.mock("./exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec.js")>();
  return { ...actual, runFile: vi.fn() };
});

const runFileMock = vi.mocked(runFile);

afterEach(() => {
  runFileMock.mockReset();
});

describe("scanWindows output validation", () => {
  it("accepts an explicit empty array", async () => {
    runFileMock.mockResolvedValue(Buffer.from("[]", "utf8"));
    const result = await scanWindows();
    expect(result.rows).toEqual([]);
    expect(result.shell).toBe("pwsh.exe");
  });

  it("treats empty stdout as a failure instead of zero ports", async () => {
    runFileMock.mockResolvedValue(Buffer.alloc(0));
    await expect(scanWindows()).rejects.toThrow(
      "Windows port scan failed (pwsh / powershell)",
    );
    expect(runFileMock).toHaveBeenCalledTimes(2);
  });

  it("treats null JSON as invalid output", async () => {
    runFileMock.mockResolvedValue(Buffer.from("null", "utf8"));
    await expect(scanWindows()).rejects.toThrow(
      "Windows port scan failed (pwsh / powershell)",
    );
  });

  it("falls back to powershell when pwsh fails", async () => {
    runFileMock
      .mockRejectedValueOnce(new Error("pwsh missing"))
      .mockResolvedValueOnce(
        Buffer.from(
          JSON.stringify([
            {
              protocol: "tcp",
              address: "127.0.0.1",
              port: 3000,
              pid: 123,
              process: "node",
            },
          ]),
          "utf8",
        ),
      );

    const result = await scanWindows();
    expect(result.shell).toBe("powershell.exe");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.port).toBe(3000);
  });
});
