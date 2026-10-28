import { execFile, type ExecFileException } from "node:child_process";

function toBuffer(value: string | Buffer | null | undefined): Buffer {
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value ?? "");
}

export class ExternalCommandError extends Error {
  readonly code?: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;

  constructor(
    cmd: string,
    cause: ExecFileException,
    stdout: Buffer,
    stderr: Buffer,
  ) {
    const stderrText = decodeCommandOutput(stderr).trim();
    const stdoutText = decodeCommandOutput(stdout).trim();
    const reason = cause.killed
      ? "timed out"
      : typeof cause.code === "number"
        ? `exited with code ${cause.code}`
        : (cause.code ?? "failed");
    const diagnostics = [
      stderrText ? `stderr: ${stderrText.slice(0, 1000)}` : "",
      stdoutText ? `stdout: ${stdoutText.slice(0, 1000)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    super(`${cmd} failed: ${reason}${diagnostics ? `\n${diagnostics}` : ""}`);
    this.name = "ExternalCommandError";
    this.code = typeof cause.code === "string" ? cause.code : undefined;
    this.exitCode = typeof cause.code === "number" ? cause.code : null;
    this.timedOut = Boolean(cause.killed);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

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
        const out = toBuffer(stdout);
        const err = toBuffer(stderr);
        if (error) {
          reject(new ExternalCommandError(cmd, error, out, err));
          return;
        }
        resolve(out);
      },
    );
  });
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf16LeDecoder = new TextDecoder("utf-16le");
const utf16BeDecoder = new TextDecoder("utf-16be");

function cleanDecodedText(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\0/g, "");
}

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 2 || buffer.length % 2 !== 0) return false;
  const sample = Math.min(buffer.length, 4096);
  let nul = 0;
  for (let i = 0; i < sample; i += 1) {
    if (buffer[i] === 0) nul += 1;
  }
  return nul > sample * 0.1;
}

/**
 * 外部コマンドの出力をデコードする。
 *
 * wsl.exe は環境によって UTF-8 / UTF-16LE の両方を返し、日本語の
 * UTF-16LE は NUL 密度が 25% を下回ることがある。BOM、UTF-8 の妥当性、
 * NUL 密度の順で判定する。
 */
export function decodeCommandOutput(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return cleanDecodedText(utf16LeDecoder.decode(buffer.subarray(2)));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return cleanDecodedText(utf16BeDecoder.decode(buffer.subarray(2)));
  }
  try {
    const text = strictUtf8Decoder.decode(buffer);
    // UTF-8 として妥当でも NUL 密度が高ければ UTF-16LE を優先する。
    if (looksLikeUtf16Le(buffer)) {
      return cleanDecodedText(utf16LeDecoder.decode(buffer));
    }
    return cleanDecodedText(text);
  } catch {
    if (buffer.length % 2 === 0) {
      return cleanDecodedText(utf16LeDecoder.decode(buffer));
    }
    return cleanDecodedText(buffer.toString("utf8"));
  }
}

/** @deprecated Use decodeCommandOutput. Kept for existing call sites. */
export function decodeWslOutput(buffer: Buffer): string {
  return decodeCommandOutput(buffer);
}

export function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
