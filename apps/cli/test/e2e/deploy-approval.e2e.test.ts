import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { withHarness, writeScript } from "./harness.js";

interface Host {
  id: string;
}

interface Service {
  id: string;
  status: string;
  lastDeployStatus?: string | null;
}

interface DeployRequest {
  id: string;
  serviceId: string;
  status: string;
  requestedBy: string;
}

interface DeployDecision {
  request: DeployRequest;
  action: { id: string; status: string } | null;
}

function deployScript(): string {
  return [
    'const { writeFileSync } = require("node:fs");',
    "console.log(`deploy starting ${process.cwd()}`);",
    'writeFileSync("deploy-marker.txt", "deployed by e2e");',
    'console.log("deploy finished");',
    "",
  ].join("\n");
}

test("live deploy approval: request, self-approval rejection, admin approval", async () => {
  await withHarness(async (h) => {
    const hosts = await h.api<Host[]>("GET", "/api/hosts");
    const host = hosts[0];
    assert.ok(host);
    const script = await writeScript(h, "deploy.js", deployScript());
    const marker = join(h.tempDir, "deploy-marker.txt");
    const service = await h.api<Service>(
      "POST",
      "/api/services",
      {
        hostId: host.id,
        name: `e2e-deploy-${randomUUID().slice(0, 8)}`,
        command: [process.execPath, script],
        cwd: h.tempDir,
        expectedPorts: [],
        autoStart: false,
        deploy: {
          command: [process.execPath, script],
          cwd: h.tempDir,
          timeoutSec: 10,
          restartAfter: false,
          healthTimeoutSec: 5,
          requireApproval: true,
        },
      },
      h.adminToken,
    );
    h.trackedService(service.id);

    const operator = await h.createOperator();
    await assert.rejects(access(marker));

    const created = await h.runCliJson<DeployRequest>(
      [
        "services",
        "deploy",
        service.id,
        "--request",
        "--note",
        "e2e release",
        "--json",
      ],
      { token: operator.token },
    );
    assert.equal(created.status, "pending");
    assert.equal(created.requestedBy, operator.id);
    await assert.rejects(access(marker));

    const selfApproval = await h.runCli(
      ["deploy-requests", "approve", created.id, "--yes", "--json"],
      { token: operator.token },
    );
    assert.equal(selfApproval.code, 3);
    assert.match(
      `${selfApproval.stdout}\n${selfApproval.stderr}`,
      /403|自己承認|Forbidden/,
    );
    await assert.rejects(access(marker));

    const stillPending = await h.runCliJson<DeployRequest>(
      ["deploy-requests", "get", created.id, "--json"],
      { token: h.adminToken },
    );
    assert.equal(stillPending.status, "pending");

    const approved = await h.runCliJson<DeployDecision>(
      [
        "deploy-requests",
        "approve",
        created.id,
        "--yes",
        "--wait",
        "--timeout",
        "30",
        "--json",
        "--note",
        "approved by e2e admin",
      ],
      { token: h.adminToken, timeoutMs: 60_000 },
    );
    assert.equal(approved.request.status, "executed");
    assert.ok(approved.action?.id);

    const actions = await h.runCliJson<{
      items: Array<{ id: string; type: string; status: string }>;
    }>(["services", "actions", service.id, "--json"], {
      token: h.adminToken,
    });
    const action = actions.items.find(
      (item) => item.id === approved.action?.id,
    );
    assert.ok(action);
    assert.equal(action.type, "deploy");
    assert.equal(action.status, "succeeded");

    const content = await readFile(marker, "utf8");
    assert.equal(content, "deployed by e2e");

    const updated = await h.runCliJson<Service>(
      ["services", "get", service.id, "--json"],
      { token: h.adminToken },
    );
    assert.equal(updated.lastDeployStatus, "succeeded");

    const list = await h.runCliJson<{ items: DeployRequest[] }>(
      ["deploy-requests", "list", "--status", "executed", "--json"],
      { token: h.adminToken },
    );
    assert.ok(list.items.some((item) => item.id === created.id));
  });
});
