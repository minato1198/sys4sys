import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCommand } from "./command-check.js";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-command-check-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("runCommand", () => {
  it("passes cwd and env to the child process", async () => {
    await runCommand(
      [
        process.execPath,
        "-e",
        "if(process.cwd()!==process.env.SYS4SYS_CWD)process.exit(2);if(process.env.SYS4SYS_TEST_ENV!=='ok')process.exit(3)",
      ],
      {
        cwd: tempDir,
        env: {
          ...process.env,
          SYS4SYS_CWD: tempDir,
          SYS4SYS_TEST_ENV: "ok",
        },
        timeoutMs: 5000,
      },
    );
  });

  it("rejects a non-zero exit code", async () => {
    await expect(
      runCommand([process.execPath, "-e", "process.exit(5)"], {
        timeoutMs: 5000,
      }),
    ).rejects.toThrow("code=5");
  });

  it("rejects and terminates on timeout", async () => {
    await expect(
      runCommand(
        [process.execPath, "-e", "setTimeout(() => undefined, 10000)"],
        { timeoutMs: 100 },
      ),
    ).rejects.toThrow("タイムアウト");
  });

  it.runIf(process.platform === "win32")(
    "runs a .cmd command on Windows",
    async () => {
      const script = join(tempDir, "health.cmd");
      await writeFile(script, "@echo off\r\nexit /b 0\r\n", "utf8");
      await runCommand([script], { timeoutMs: 5000 });
    },
  );
});
