import { describe, expect, it } from "vitest";
import {
  decodeCommandOutput,
  decodeWslOutput,
  ExternalCommandError,
  runFile,
} from "./exec.js";

describe("external command decoding", () => {
  it("keeps UTF-8 Japanese output", () => {
    expect(decodeCommandOutput(Buffer.from("日本語テスト 成功", "utf8"))).toBe(
      "日本語テスト 成功",
    );
  });

  it("decodes UTF-16LE without a BOM", () => {
    expect(
      decodeCommandOutput(Buffer.from("日本語テスト 成功", "utf16le")),
    ).toBe("日本語テスト 成功");
  });

  it("decodes ASCII UTF-16LE without a BOM", () => {
    expect(decodeCommandOutput(Buffer.from("hello", "utf16le"))).toBe("hello");
  });

  it("keeps the legacy decodeWslOutput export working", () => {
    expect(decodeWslOutput(Buffer.from("成功", "utf16le"))).toBe("成功");
  });
});

describe("runFile errors", () => {
  it("preserves stdout, stderr, and exit code", async () => {
    const error = await runFile(process.execPath, [
      "-e",
      "process.stdout.write('stdout-value');process.stderr.write('stderr-value');process.exit(7)",
    ]).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExternalCommandError);
    const commandError = error as ExternalCommandError;
    expect(commandError.exitCode).toBe(7);
    expect(commandError.stdout.toString("utf8")).toBe("stdout-value");
    expect(commandError.stderr.toString("utf8")).toBe("stderr-value");
    expect(commandError.message).toContain("stderr-value");
  });

  it("marks missing executables as not found", async () => {
    const error = await runFile("__sys4sys_missing_command__", []).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ExternalCommandError);
    expect((error as ExternalCommandError).code).toBe("ENOENT");
  });
});
