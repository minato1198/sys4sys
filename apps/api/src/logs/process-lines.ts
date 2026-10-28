const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const shiftJisDecoder = new TextDecoder("shift-jis");
const utf16LeDecoder = new TextDecoder("utf-16le");
const utf16BeDecoder = new TextDecoder("utf-16be");

function looksLikeUtf16Le(buffer: Buffer): boolean {
  if (buffer.length < 2 || buffer.length % 2 !== 0) return false;
  const sample = Math.min(buffer.length, 4096);
  let nul = 0;
  for (let i = 0; i < sample; i += 1) {
    if (buffer[i] === 0) nul += 1;
  }
  return nul > sample * 0.1;
}

export function decodeProcessBytes(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return utf16LeDecoder.decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return utf16BeDecoder.decode(buffer.subarray(2));
  }
  if (looksLikeUtf16Le(buffer)) {
    return utf16LeDecoder.decode(buffer);
  }
  try {
    return strictUtf8Decoder.decode(buffer);
  } catch {
    const shiftJis = shiftJisDecoder.decode(buffer);
    // UTF-16LE の日本語は NUL が 1 割未満のことがあり、Shift-JIS として
    // デコードすると NUL や制御文字が残る。その場合だけ UTF-16LE を試す。
    if (shiftJis.includes("\0") && buffer.length % 2 === 0) {
      return utf16LeDecoder.decode(buffer);
    }
    return shiftJis;
  }
}

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d) {
    return buffer.subarray(0, -1);
  }
  // UTF-16LE の CRLF は 0D 00 0A 00。0A の直前は 0D 00 になる。
  if (
    buffer.length >= 2 &&
    buffer[buffer.length - 1] === 0 &&
    buffer[buffer.length - 2] === 0x0d
  ) {
    return buffer.subarray(0, -2);
  }
  return buffer;
}

export class ProcessLineDecoder {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private flushed = false;

  push(chunk: unknown): string[] {
    const input = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk ?? ""));
    if (input.length === 0) return [];

    this.pending =
      this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);

    const lines: string[] = [];
    let lineStart = 0;
    for (let i = 0; i < this.pending.length; i += 1) {
      if (this.pending[i] !== 0x0a) continue;

      const line = this.pending.subarray(lineStart, i);
      if (line.length > 0) {
        lines.push(decodeProcessBytes(stripTrailingCarriageReturn(line)));
      }
      lineStart = i + 1;
    }

    this.pending = this.pending.subarray(lineStart);
    return lines;
  }

  flush(): string[] {
    if (this.flushed) return [];
    this.flushed = true;

    if (this.pending.length === 0) return [];
    const line = this.pending;
    this.pending = Buffer.alloc(0);
    return [decodeProcessBytes(stripTrailingCarriageReturn(line))];
  }
}

export interface ProcessLineStreamHandle {
  destroy(): void;
}

export function attachProcessLineStream(
  stream: NodeJS.EventEmitter,
  onLine: (line: string) => void,
): ProcessLineStreamHandle {
  const decoder = new ProcessLineDecoder();

  const flush = () => {
    for (const line of decoder.flush()) {
      if (line.trim()) onLine(line);
    }
  };

  const handleData = (chunk: unknown) => {
    for (const line of decoder.push(chunk)) {
      if (line.trim()) onLine(line);
    }
  };

  stream.on("data", handleData);
  stream.on("end", flush);
  stream.on("close", flush);

  return {
    destroy() {
      stream.off("data", handleData);
      stream.off("end", flush);
      stream.off("close", flush);
      flush();
    },
  };
}
