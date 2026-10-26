import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { waitFor, withHarness, writeScript } from "./harness.js";

interface Host {
  id: string;
}

interface Service {
  id: string;
  status: string;
}

interface LogEvent {
  serviceId: string | null;
  stream: string;
  level: string;
  message: string;
}

interface LogPage {
  items: LogEvent[];
  nextCursor: string | null;
}

function scriptSource(): string {
  return [
    'const prefix = "e2e-service";',
    "console.log(`${prefix} line one`);",
    "console.log(`${prefix} line two`);",
    "console.log(`${prefix} line three`);",
    "let tick = 0;",
    "setInterval(() => {",
    "  tick += 1;",
    "  console.log(`${prefix} tick ${tick}`);",
    "}, 200);",
    'process.on("SIGTERM", () => process.exit(0));',
    "",
  ].join("\n");
}

test("live logs query and tail receive service output", async () => {
  await withHarness(async (h) => {
    const hosts = await h.api<Host[]>("GET", "/api/hosts");
    const host = hosts[0];
    assert.ok(host);
    const script = await writeScript(h, "log-service.js", scriptSource());
    const service = await h.api<Service>(
      "POST",
      "/api/services",
      {
        hostId: host.id,
        name: `e2e-logs-${randomUUID().slice(0, 8)}`,
        command: [process.execPath, script],
        cwd: h.tempDir,
        expectedPorts: [],
        autoStart: false,
      },
      h.adminToken,
    );
    h.trackedService(service.id);

    const started = await h.runCliJson<{
      action: { status: string };
      service: Service;
    }>(["services", "start", service.id, "--wait", "--json"], {
      token: h.adminToken,
      timeoutMs: 90_000,
    });
    assert.equal(started.service.status, "running");

    const page = await waitFor(
      "service output to appear in logs query",
      async () => {
        const result = await h.runCliJson<LogPage>(
          [
            "logs",
            "query",
            "--service",
            service.id,
            "--since",
            "1h",
            "--limit",
            "500",
            "--json",
          ],
          { token: h.adminToken },
        );
        const messages = result.items
          .filter((item) => item.serviceId === service.id)
          .map((item) => item.message);
        return messages.includes("e2e-service line one") &&
          messages.includes("e2e-service line two") &&
          messages.includes("e2e-service line three")
          ? result
          : null;
      },
      { timeoutMs: 30_000, intervalMs: 300 },
    );
    assert.ok(page.items.every((item) => item.serviceId === service.id));

    const grep = await h.runCliJson<LogPage>(
      [
        "logs",
        "query",
        "--service",
        service.id,
        "--grep",
        "line two",
        "--json",
      ],
      { token: h.adminToken },
    );
    assert.ok(grep.items.length >= 1);
    assert.ok(grep.items.every((item) => item.message.includes("line two")));

    const tail = h.startCli(
      ["logs", "tail", "--service", service.id, "--json"],
      { token: h.adminToken },
    );
    try {
      await waitFor(
        "logs tail to receive a tick",
        () => tail.stdout().includes("e2e-service tick"),
        { timeoutMs: 30_000, intervalMs: 100 },
      );
      assert.match(tail.stdout(), /e2e-service tick/);
    } finally {
      tail.stop();
      await tail.closed();
    }

    const tooMany = await h.runCli(
      ["logs", "query", "--service", service.id, "--limit", "501", "--json"],
      { token: h.adminToken },
    );
    assert.equal(tooMany.code, 2);
    assert.match(`${tooMany.stdout}\n${tooMany.stderr}`, /500/);

    const stopped = await h.runCli(
      ["services", "stop", service.id, "--yes", "--wait", "--json"],
      { token: h.adminToken, timeoutMs: 90_000 },
    );
    assert.equal(stopped.code, 0, stopped.stderr);
  });
});
