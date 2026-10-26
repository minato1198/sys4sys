#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const cliDir = join(root, "apps", "cli");

const REQUIRED = [
  "package.json",
  "README.md",
  "SKILL.md",
  "LICENSE",
  "dist/bin.js",
  "dist/index.js",
  "dist/schema.js",
];

const FORBIDDEN = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)(data|logs?|test|tests|src|node_modules)\//i,
  /\.(db|sqlite|sqlite3|db-wal|db-shm|log)(\.|$)/i,
  /\.map$/i,
];

function npmCommand(args, cwd, options = {}) {
  if (process.platform === "win32") {
    const quote = (value) => `"${String(value).replaceAll('"', '\\"')}"`;
    const line = ["npm.cmd", ...args.map(quote)].join(" ");
    return spawnSync(line, {
      cwd,
      encoding: "utf8",
      shell: true,
      ...options,
    });
  }
  return spawnSync("npm", args, { cwd, encoding: "utf8", ...options });
}

function assertRun(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status})\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
}

function parsePackJson(stdout) {
  const start = stdout.indexOf("[");
  if (start === -1) throw new Error("npm pack did not return JSON");
  return JSON.parse(stdout.slice(start));
}

async function assertPackageMetadata() {
  const pkg = JSON.parse(await readFile(join(cliDir, "package.json"), "utf8"));
  const errors = [];
  if (pkg.name !== "sys4sys") errors.push("package name must be sys4sys");
  if (pkg.private !== false) errors.push("package must not be private");
  if (pkg.bin?.sys4sys !== "./dist/bin.js") {
    errors.push("bin.sys4sys must point to ./dist/bin.js");
  }
  if (pkg.main !== "./dist/index.js") {
    errors.push("main must be ./dist/index.js");
  }
  if (pkg.exports?.["."] !== "./dist/index.js") {
    errors.push("exports['.'] must be ./dist/index.js");
  }
  if (pkg.exports?.["./schema"] !== "./dist/schema.js") {
    errors.push("exports['./schema'] must be ./dist/schema.js");
  }
  if (pkg.dependencies?.["@sys4sys/shared"]) {
    errors.push("@sys4sys/shared must be bundled, not a runtime dependency");
  }
  if (pkg.dependencies?.["tsx"]) {
    errors.push("tsx must not be a runtime dependency");
  }
  if (!pkg.files?.includes("dist")) errors.push("files must include dist");
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return pkg;
}

async function assertBin() {
  const binPath = join(cliDir, "dist", "bin.js");
  const content = await readFile(binPath, "utf8");
  if (!content.startsWith("#!/usr/bin/env node")) {
    throw new Error("dist/bin.js must start with a node shebang");
  }
  const info = await stat(binPath);
  if (info.size < 1000) throw new Error("dist/bin.js looks empty");
}

function checkPackedFiles(files) {
  const paths = files.map((file) =>
    typeof file === "string" ? file : file.path,
  );
  const missing = REQUIRED.filter((required) => !paths.includes(required));
  if (missing.length > 0) {
    throw new Error(
      `package is missing required files:\n${missing.join("\n")}`,
    );
  }
  const forbidden = paths.filter((path) =>
    FORBIDDEN.some((pattern) => pattern.test(path)),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `package contains forbidden files:\n${forbidden.join("\n")}`,
    );
  }
  if (paths.some((path) => path.includes(root))) {
    throw new Error("package contains an absolute workspace path");
  }
  return paths;
}

async function runInstalledChecks(installDir, tempDir) {
  const bin = join(installDir, "node_modules", "sys4sys", "dist", "bin.js");
  const env = {
    ...process.env,
    SYS4SYS_CONFIG_DIR: join(tempDir, "config"),
  };
  delete env.SYS4SYS_TOKEN;
  delete env.SYS4SYS_TOKEN_FILE;

  const version = spawnSync(process.execPath, [bin, "--version"], {
    encoding: "utf8",
    env,
  });
  assertRun(version, "installed sys4sys --version");
  if (!/^\d+\.\d+\.\d+/.test(version.stdout.trim())) {
    throw new Error(`unexpected --version output: ${version.stdout}`);
  }

  const help = spawnSync(process.execPath, [bin, "--help"], {
    encoding: "utf8",
    env,
  });
  assertRun(help, "installed sys4sys --help");
  if (!help.stdout.includes("sys4sys <command>")) {
    throw new Error("installed --help output is missing the command usage");
  }

  const schema = spawnSync(process.execPath, [bin, "schema", "--json"], {
    encoding: "utf8",
    env,
  });
  assertRun(schema, "installed sys4sys schema --json");
  const parsed = JSON.parse(schema.stdout);
  if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
    throw new Error("installed schema JSON has no commands");
  }
}

async function main() {
  console.log("sys4sys package verification");
  const pkg = await assertPackageMetadata();
  await assertBin();

  const tempDir = await mkdtemp(join(tmpdir(), "sys4sys package "));
  const installDir = join(tempDir, "install with space");
  try {
    const dryRun = npmCommand(
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      cliDir,
    );
    assertRun(dryRun, "npm pack --dry-run");
    const dryRunJson = parsePackJson(dryRun.stdout);
    const files = dryRunJson[0]?.files ?? [];
    const paths = checkPackedFiles(files);
    console.log(`packed files: ${paths.length}`);

    const pack = npmCommand(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", tempDir],
      cliDir,
    );
    assertRun(pack, "npm pack");
    const packJson = parsePackJson(pack.stdout);
    const filename = packJson[0]?.filename;
    if (!filename) throw new Error("npm pack did not return a filename");
    const tarball = resolve(tempDir, filename);

    await mkdir(installDir, { recursive: true });
    const install = npmCommand(
      [
        "install",
        "--prefix",
        installDir,
        tarball,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      tempDir,
    );
    assertRun(install, "npm install tarball");

    await runInstalledChecks(installDir, tempDir);
    console.log(`installed check: passed (${pkg.name}@${pkg.version})`);
    console.log("package verification: passed");
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(`package verification: failed\n${error.message}`);
  process.exitCode = 1;
});
