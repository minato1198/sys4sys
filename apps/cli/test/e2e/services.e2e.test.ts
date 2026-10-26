import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withHarness, writeScript } from "./harness.js";

interface Host {
  id: string;
  name: string;
}

interface Service {
  id: string;
  name: string;
  status: string;
  envKeys?: string[];
  env?: Record<string, string> | null;
}

interface ActionPage {
  items: Array<{ id: string; type: string; status: string }>;
  nextCursor: string | null;
}

const SECRET_VALUE = "e2e-secret-value-do-not-log";

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
    "}, 250);",
    'process.on("SIGTERM", () => process.exit(0));',
    'process.on("SIGINT", () => process.exit(0));',
    "",
  ].join("\n");
}

test("live service lifecycle, secret reveal safety, and audit trail", async () => {
  await withHarness(async (h) => {
    const hosts = await h.api<Host[]>("GET", "/api/hosts");
    assert.ok(hosts.length > 0);
    const host = hosts[0];
    assert.ok(host);

    const script = await writeScript(h, "service.js", scriptSource());
    const name = `e2e-${randomUUID().slice(0, 8)}`;
    const service = await h.api<Service>(
      "POST",
      "/api/services",
      {
        hostId: host.id,
        name,
        command: [process.execPath, script],
        cwd: h.tempDir,
        env: { E2E_SECRET: SECRET_VALUE },
        expectedPorts: [],
        autoStart: false,
      },
      h.adminToken,
    );
    h.trackedService(service.id);
    assert.equal(service.name, name);
    assert.equal(service.status, "stopped");

    const plain = await h.runCli(["services", "get", service.id, "--json"], {
      token: h.adminToken,
    });
    assert.equal(plain.code, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, new RegExp(SECRET_VALUE));
    const plainService = JSON.parse(plain.stdout) as Service;
    assert.deepEqual(plainService.envKeys, ["E2E_SECRET"]);

    const started = await h.runCliJson<{
      action: { status: string };
      service: Service;
    }>(["services", "start", service.id, "--wait", "--json"], {
      token: h.adminToken,
      timeoutMs: 90_000,
    });
    assert.equal(started.action.status, "succeeded");
    assert.equal(started.service.status, "running");

    const stopped = await h.runCliJson<{
      action: { status: string };
      service: Service;
    }>(["services", "stop", service.id, "--yes", "--wait", "--json"], {
      token: h.adminToken,
      timeoutMs: 90_000,
    });
    assert.equal(stopped.action.status, "succeeded");
    assert.equal(stopped.service.status, "stopped");

    const restarted = await h.runCliJson<{
      action: { status: string };
      service: Service;
    }>(["services", "restart", service.id, "--yes", "--wait", "--json"], {
      token: h.adminToken,
      timeoutMs: 90_000,
    });
    assert.equal(restarted.action.status, "succeeded");
    assert.equal(restarted.service.status, "running");

    const actions = await h.runCliJson<ActionPage>(
      ["services", "actions", service.id, "--json"],
      { token: h.adminToken },
    );
    const types = new Set(actions.items.map((action) => action.type));
    for (const expected of ["start", "stop", "restart"]) {
      assert.ok(types.has(expected), `missing ${expected} action`);
    }
    assert.ok(actions.items.every((action) => action.status === "succeeded"));

    const revealed = await h.runCli(
      ["services", "get", service.id, "--show-env", "--json"],
      { token: h.adminToken },
    );
    assert.equal(revealed.code, 0, revealed.stderr);
    assert.match(revealed.stdout, new RegExp(SECRET_VALUE));
    assert.match(revealed.stderr, /--show-env/);

    const operator = await h.createOperator();
    const denied = await h.runCli(
      ["services", "get", service.id, "--show-env", "--json"],
      { token: operator.token },
    );
    assert.equal(denied.code, 3);
    assert.doesNotMatch(
      `${denied.stdout}\n${denied.stderr}`,
      new RegExp(SECRET_VALUE),
    );
    assert.match(`${denied.stdout}\n${denied.stderr}`, /403|権限|Forbidden/);

    const audit = await h.runCliJson<{
      items: Array<{ action: string; target: string | null }>;
    }>(["audit", "list", "--action", "service.secrets.reveal", "--json"], {
      token: h.adminToken,
    });
    assert.ok(
      audit.items.some(
        (item) =>
          item.action === "service.secrets.reveal" &&
          item.target === `service:${service.id}`,
      ),
    );

    const stoppedAgain = await h.runCli(
      ["services", "stop", service.id, "--yes", "--wait", "--json"],
      { token: h.adminToken, timeoutMs: 90_000 },
    );
    assert.equal(stoppedAgain.code, 0, stoppedAgain.stderr);

    const deleted = await h.runCliJson<{ deleted: boolean; id: string }>(
      ["services", "delete", service.id, "--yes", "--json"],
      { token: h.adminToken },
    );
    assert.deepEqual(deleted, { deleted: true, id: service.id });

    const list = await h.runCliJson<Service[]>(["services", "list", "--json"], {
      token: h.adminToken,
    });
    assert.equal(
      list.some((item) => item.id === service.id),
      false,
    );
  });
});
