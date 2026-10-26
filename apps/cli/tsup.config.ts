import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    bin: "src/bin.ts",
    index: "src/index.ts",
    schema: "src/schema.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  dts: false,
  external: ["@modelcontextprotocol/sdk", "zod"],
  noExternal: ["@sys4sys/shared"],
  define: {
    __SYS4SYS_CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
