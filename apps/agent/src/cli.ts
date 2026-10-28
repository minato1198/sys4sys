import { scanPorts, type ScanScope } from "./scan.js";
import type { PortRow } from "@sys4sys/shared";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function pad(value: unknown, width: number): string {
  const text = String(value ?? "-");
  const displayWidth = [...text].reduce(
    (sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1),
    0,
  );
  return text + " ".repeat(Math.max(0, width - displayWidth));
}

function printTable(rows: PortRow[]): void {
  const header = [
    pad("SCOPE", 9),
    pad("PID_SCOPE", 14),
    pad("PROTO", 5),
    pad("ADDRESS", 18),
    pad("PORT", 6),
    pad("PID", 7),
    pad("PROCESS", 22),
    "COMMAND",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const row of rows) {
    const ownerCount = row.owners?.length ?? 1;
    const extraOwners = ownerCount > 1 ? `+${ownerCount - 1}` : "";
    const command = `${row.commandLine ?? ""}${
      row.likelyWslForward ? "  [likely WSL forward]" : ""
    }`;
    console.log(
      [
        pad(row.scope, 9),
        pad(row.pidScope, 14),
        pad(row.protocol, 5),
        pad(row.address, 18),
        pad(row.port, 6),
        pad(`${row.pid ?? "-"}${extraOwners}`, 7),
        pad(`${row.process ?? "-"}${extraOwners}`, 22),
        command.slice(0, 140),
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const jsonOnly = process.argv.includes("--json");
  const includeStopped = process.argv.includes("--include-stopped");
  const scope = (argValue("--scope") ?? "all") as ScanScope;
  const distro = argValue("--distro");

  if (!["all", "windows", "wsl"].includes(scope)) {
    throw new Error(`invalid --scope: ${scope} (all | windows | wsl)`);
  }

  const result = await scanPorts({ scope, distro, includeStopped });

  if (jsonOnly) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`sys4sys portscan — ${result.scannedAt}`);
  console.log(
    `distros: ${result.distros.map((d) => `${d.name}(${d.state})`).join(", ") || "(none)"}`,
  );
  if (result.skipped.length > 0) {
    console.log("skipped:");
    for (const item of result.skipped)
      console.log(`  ${item.distro}: ${item.error}`);
  }
  if (result.scanErrors.length > 0) {
    console.log("scan errors:");
    for (const item of result.scanErrors)
      console.log(
        `  ${item.scope}${item.distro ? `:${item.distro}` : ""}: ${item.message}`,
      );
  }
  if (result.warnings.length > 0) {
    console.log("warnings:");
    for (const item of result.warnings) console.log(`  ${item}`);
  }
  console.log("");
  printTable(result.rows);

  console.log("");
  console.log("scan times:");
  for (const [name, timing] of Object.entries(result.timings)) {
    const shell = timing.shell ? ` via ${timing.shell}` : "";
    console.log(
      `  ${name}: ${timing.rows} rows, ${timing.elapsedMs.toFixed(0)} ms${shell}`,
    );
  }
  const wslCount = result.rows.filter((r) => r.scope === "wsl").length;
  const forwardCount = result.rows.filter((r) => r.likelyWslForward).length;
  console.log(
    `  total: ${result.rows.length} rows (wsl: ${wslCount}, likely WSL forward: ${forwardCount})`,
  );
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
