import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  controlModeSchema,
  deployConfigSchema,
  deployRequestSnapshotSchema,
  serviceCreateSchema,
  serviceListQuerySchema,
  serviceUpdateSchema,
} from "./api.js";

describe("external service schemas", () => {
  it("accepts windows-service with SCM name and deploy owner", () => {
    const parsed = serviceCreateSchema.parse({
      hostId: "host-1",
      name: "demo-service",
      command: ["unused"],
      controlMode: "windows-service",
      serviceName: "  MyDemoService  ",
      deploy: {
        command: ["pwsh.exe", "-File", "deploy.ps1"],
        serviceControlOwner: "sys4sys",
        restartAfter: false,
      },
    });

    assert.equal(parsed.controlMode, "windows-service");
    assert.equal(parsed.serviceName, "MyDemoService");
    assert.equal(parsed.deploy?.serviceControlOwner, "sys4sys");
  });

  it("requires serviceName for windows-service", () => {
    assert.throws(() =>
      serviceCreateSchema.parse({
        hostId: "host-1",
        name: "missing-service-name",
        command: ["unused"],
        controlMode: "windows-service",
      }),
    );
  });

  it("requires deploy owner for windows-service deploy", () => {
    assert.throws(() =>
      serviceCreateSchema.parse({
        hostId: "host-1",
        name: "missing-owner",
        command: ["unused"],
        controlMode: "windows-service",
        serviceName: "MissingOwnerService",
        deploy: {
          command: ["pwsh.exe", "-File", "deploy.ps1"],
        },
      }),
    );
  });

  it("rejects serviceName on spawn services", () => {
    assert.throws(() =>
      serviceCreateSchema.parse({
        hostId: "host-1",
        name: "spawn-with-service-name",
        command: ["node.exe", "server.js"],
        controlMode: "spawn",
        serviceName: "NotAllowed",
      }),
    );
  });

  it("rejects path-like or control characters in service names", () => {
    for (const serviceName of [
      "bad/service",
      "bad\\service",
      "bad\u0001name",
    ]) {
      assert.throws(() =>
        serviceCreateSchema.parse({
          hostId: "host-1",
          name: "bad-service-name",
          command: ["unused"],
          controlMode: "windows-service",
          serviceName,
        }),
      );
    }
  });

  it("allows service update fields without forcing full cross-field shape", () => {
    const parsed = serviceUpdateSchema.parse({
      controlMode: "windows-service",
      serviceName: "UpdatedService",
      deploy: {
        command: ["pwsh.exe", "-File", "deploy.ps1"],
        serviceControlOwner: "script",
        restartAfter: true,
      },
    });

    assert.equal(parsed.controlMode, "windows-service");
    assert.equal(parsed.serviceName, "UpdatedService");
    assert.equal(parsed.deploy?.serviceControlOwner, "script");
    assert.equal(parsed.deploy?.restartAfter, true);
  });

  it("lists stopping as a service status", () => {
    assert.equal(
      serviceListQuerySchema.parse({ status: "stopping" }).status,
      "stopping",
    );
    assert.throws(() => serviceListQuerySchema.parse({ status: "bogus" }));
  });

  it("parses deploy owner as a bounded enum", () => {
    assert.equal(
      deployConfigSchema.parse({
        command: ["pwsh.exe", "-File", "deploy.ps1"],
        serviceControlOwner: "script",
      }).serviceControlOwner,
      "script",
    );
    assert.throws(() =>
      deployConfigSchema.parse({
        command: ["pwsh.exe"],
        serviceControlOwner: "unknown",
      }),
    );
    assert.throws(() =>
      controlModeSchema.parse({
        controlMode: "linux-service",
      }),
    );
  });

  it("fills compatibility defaults for old deploy request snapshots", () => {
    const parsed = deployRequestSnapshotSchema.parse({
      command: ["node", "deploy.js"],
      cwd: null,
      timeoutSec: 300,
      restartAfter: true,
      healthTimeoutSec: 30,
      envHash: "a".repeat(64),
      deployEnvHash: "b".repeat(64),
    });

    assert.equal(parsed.controlMode, "spawn");
    assert.equal(parsed.serviceName, null);
    assert.equal(parsed.serviceControlOwner, null);
  });
});
