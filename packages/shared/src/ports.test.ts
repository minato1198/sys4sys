import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregatePortRows,
  portEndpointKey,
  portOwnerKey,
  type PortOwner,
  type PortRow,
} from "./ports.js";

function windowsUdp5353(overrides: Partial<PortRow> = {}): PortRow {
  return {
    scope: "windows",
    protocol: "udp",
    address: "0.0.0.0",
    port: 5353,
    pid: 18776,
    process: "steamwebhelper.exe",
    commandLine: "steamwebhelper.exe --type=utility",
    startedAt: "2026-10-25T00:00:00.000Z",
    ...overrides,
  };
}

function firstRow(rows: PortRow[]): PortRow {
  const row = rows[0];
  if (!row) {
    throw new Error("expected aggregated port row");
  }
  return row;
}

function owners(row: PortRow): PortOwner[] {
  return row.owners ?? [];
}

function firstOwner(row: PortRow): PortOwner {
  const owner = owners(row)[0];
  if (!owner) {
    throw new Error("expected aggregated port owner");
  }
  return owner;
}

test("aggregatePortRows collapses exact duplicate observations by endpoint", () => {
  const rows = [windowsUdp5353(), windowsUdp5353(), windowsUdp5353()];
  const aggregated = aggregatePortRows(rows);
  const first = firstRow(aggregated);
  const key = portEndpointKey(firstRow(rows));

  assert.equal(aggregated.length, 1);
  assert.equal(portEndpointKey(first), key);
  assert.equal(owners(first).length, 1);
  assert.equal(owners(first)[0]?.pid, 18776);
  assert.equal(
    new Set(aggregated.map((row) => portEndpointKey(row))).size,
    aggregated.length,
  );
});

test("aggregatePortRows keeps distinct PIDs as owners on the same endpoint", () => {
  const aggregated = aggregatePortRows([
    windowsUdp5353({ pid: 100, process: "worker-a.exe" }),
    windowsUdp5353({ pid: 200, process: "worker-b.exe" }),
    windowsUdp5353({ pid: 100, process: "worker-a.exe" }),
  ]);
  const first = firstRow(aggregated);

  assert.equal(aggregated.length, 1);
  assert.equal(owners(first).length, 2);
  assert.deepEqual(
    owners(first).map((owner) => owner.pid),
    [100, 200],
  );
  assert.equal(portOwnerKey(firstOwner(first)).startsWith("pid"), true);
});

test("aggregatePortRows preserves WSL seenIn and representative PID", () => {
  const aggregated = aggregatePortRows([
    {
      scope: "wsl",
      pidScope: "Ubuntu",
      seenIn: ["Ubuntu"],
      protocol: "tcp",
      address: "0.0.0.0",
      port: 8080,
      pid: null,
      process: null,
      commandLine: null,
    },
    {
      scope: "wsl",
      pidScope: "Debian",
      seenIn: ["Debian"],
      protocol: "tcp",
      address: "0.0.0.0",
      port: 8080,
      pid: 42,
      process: "node",
      processPath: "/usr/bin/node",
      commandLine: "node server.js",
      startedAt: "2026-10-25T00:00:00.000Z",
    },
  ]);
  const first = firstRow(aggregated);

  assert.equal(aggregated.length, 1);
  assert.equal(first.pid, 42);
  assert.equal(first.process, "node");
  assert.deepEqual(first.seenIn, ["Ubuntu", "Debian"]);
  assert.equal(owners(first).length, 1);
});
