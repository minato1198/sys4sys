import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

const info = {
  package: packageJson.name,
  version: packageJson.version,
  builtAt: new Date().toISOString(),
  deployActionId:
    process.env.SYS4SYS_DEPLOY_ACTION_ID ??
    process.env.DEPLOY_ACTION_ID ??
    null,
};

const distDir = path.join(packageRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(
  path.join(distDir, "build-info.json"),
  `${JSON.stringify(info, null, 2)}\n`,
  "utf8",
);

console.log(
  `[demo-nssm-api] build-info written action=${info.deployActionId ?? "manual"}`,
);
