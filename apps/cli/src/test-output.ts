import type { CliOutput } from "./output.js";

export interface MemoryOutput {
  output: CliOutput;
  out: string;
  err: string;
}

/**
 * テスト用の出力シンク。process.stdout / stderr を差し替えずに
 * CLI コマンドの出力を検証する。
 */
export function memoryOutput(): MemoryOutput {
  const state = { out: "", err: "" };
  return {
    output: {
      out: (text) => {
        state.out += text;
      },
      err: (text) => {
        state.err += text;
      },
    },
    get out() {
      return state.out;
    },
    get err() {
      return state.err;
    },
  };
}
