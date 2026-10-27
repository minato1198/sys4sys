const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const shiftJisDecoder = new TextDecoder("shift-jis");

export function decodeProcessBytes(buffer: Buffer): string {
  try {
    return strictUtf8Decoder.decode(buffer);
  } catch {
    return shiftJisDecoder.decode(buffer);
  }
}

function stripTrailingCarriageReturn(buffer: Buffer): Buffer {
  return buffer.length > 0 && buffer[buffer.length - 1] === 0x0d
    ? buffer.subarray(0, -1)
    : buffer;
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
