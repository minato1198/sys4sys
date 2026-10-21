import { execFile } from "node:child_process";

export function runFile(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        encoding: "buffer",
      },
      (error, stdout, stderr) => {
        if (error) {
          const errText = stderr
            ? Buffer.from(stderr).toString("utf8").slice(0, 2000)
            : "";
          reject(
            new Error(
              `${cmd} failed: ${error.message}${errText ? `\n${errText}` : ""}`,
            ),
          );
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

/**
 * wsl.exe の出力はパイプ経由だと UTF-16LE + BOM になる。
 * BOM または NUL バイトの密度で判定してデコードする。
 */
export function decodeWslOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  let nul = 0;
  const sample = Math.min(buf.length, 4096);
  for (let i = 0; i < sample; i++) if (buf[i] === 0) nul++;
  const text =
    nul > sample * 0.25 ? buf.toString("utf16le") : buf.toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
