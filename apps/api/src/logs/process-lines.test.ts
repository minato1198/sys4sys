import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  attachProcessLineStream,
  decodeProcessBytes,
  ProcessLineDecoder,
} from "./process-lines.js";

describe("process log line decoding", () => {
  it("keeps UTF-8 logs as UTF-8", () => {
    expect(decodeProcessBytes(Buffer.from("日本語テスト 成功", "utf8"))).toBe(
      "日本語テスト 成功",
    );
  });

  it("decodes Windows Shift-JIS logs", () => {
    expect(
      decodeProcessBytes(
        Buffer.from("93fa967b8cea8365835883672090ac8cf7", "hex"),
      ),
    ).toBe("日本語テスト 成功");
  });

  it("splits lines that arrive across chunks", () => {
    const decoder = new ProcessLineDecoder();
    const first = decoder.push(
      Buffer.from("==> typecheck @sys4sys/demo-api\r\nOK typecheck ", "utf8"),
    );
    const second = decoder.push(Buffer.from("成功\r\n", "utf8"));
    const rest = decoder.flush();

    expect(first).toEqual(["==> typecheck @sys4sys/demo-api"]);
    expect(second).toEqual(["OK typecheck 成功"]);
    expect(rest).toEqual([]);
  });

  it("decodes UTF-16LE file logs without a BOM", () => {
    expect(
      decodeProcessBytes(Buffer.from("日本語テスト 成功", "utf16le")),
    ).toBe("日本語テスト 成功");
  });

  it("keeps Shift-JIS multibyte characters across byte chunks", () => {
    const bytes = Buffer.from("93fa967b8cea8365835883672090ac8cf70d0a", "hex");
    const decoder = new ProcessLineDecoder();
    const first = decoder.push(bytes.subarray(0, 3));
    const second = decoder.push(bytes.subarray(3));

    expect(first).toEqual([]);
    expect(second).toEqual(["日本語テスト 成功"]);
  });

  it("attaches to a stream-like child process output", () => {
    const stream = new EventEmitter();
    const lines: string[] = [];
    const handle = attachProcessLineStream(stream, (line) => lines.push(line));

    stream.emit("data", Buffer.from("==> build @sys4sys/demo-api\r\n", "utf8"));
    stream.emit("data", Buffer.from("OK build 成功", "utf8"));
    stream.emit("end");
    handle.destroy();

    expect(lines).toEqual(["==> build @sys4sys/demo-api", "OK build 成功"]);
  });
});
