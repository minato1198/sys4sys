import { afterEach, describe, expect, it, vi } from "vitest";
import { runFile } from "./exec.js";
import { scanWslDistro } from "./wsl.js";

vi.mock("./exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec.js")>();
  return { ...actual, runFile: vi.fn() };
});

const runFileMock = vi.mocked(runFile);
const ssOutput =
  'tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=123,fd=20))\n';

function mockWsl(ps: "ok" | "fail") {
  runFileMock.mockImplementation((_cmd, args) => {
    if (args.includes("ss")) return Promise.resolve(Buffer.from(ssOutput));
    if (args.includes("ps")) {
      return ps === "ok"
        ? Promise.resolve(Buffer.from("123 1 10 node server.js\n"))
        : Promise.reject(new Error("ps failed"));
    }
    return Promise.reject(new Error(`unexpected args: ${args.join(" ")}`));
  });
}

afterEach(() => {
  runFileMock.mockReset();
});

describe("scanWslDistro", () => {
  it("returns port rows when ps fails but ss succeeds", async () => {
    mockWsl("fail");
    const result = await scanWslDistro("Ubuntu");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      scope: "wsl",
      port: 3000,
      pid: 123,
      process: "node",
      commandLine: null,
    });
    expect(result.warnings).toEqual(["ps failed: ps failed"]);
  });

  it("fails the distro when ss fails", async () => {
    runFileMock.mockRejectedValue(new Error("ss failed"));
    await expect(scanWslDistro("Ubuntu")).rejects.toThrow("ss failed");
  });

  it("enriches rows from ps when both commands succeed", async () => {
    mockWsl("ok");
    const result = await scanWslDistro("Ubuntu");

    expect(result.rows[0]?.ppid).toBe(1);
    expect(result.rows[0]?.commandLine).toBe("node server.js");
    expect(result.warnings).toEqual([]);
  });
});
