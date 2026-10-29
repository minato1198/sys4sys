import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mapScmState,
  parseInspectionPayload,
  scExitCodeToError,
  ServiceControlError,
  WindowsServiceController,
  type ServiceRow,
} from "./service-control.js";

function serviceRow(overrides: Partial<ServiceRow> = {}): ServiceRow {
  return {
    id: "service-1",
    hostId: "host-1",
    name: "demo",
    controlMode: "windows-service",
    serviceName: "DemoService",
    ...overrides,
  } as ServiceRow;
}

class FakeScm {
  state = "stopped";
  pid = 0;
  calls: string[] = [];

  readonly exec = async (
    cmd: string,
    args: string[],
    _timeoutMs?: number,
    env?: NodeJS.ProcessEnv,
  ): Promise<Buffer> => {
    if (cmd === "powershell.exe") {
      const name = env?.SYS4SYS_SERVICE_NAME ?? "";
      this.calls.push(`inspect:${name}:${this.state}`);
      if (!name) {
        return Buffer.from(
          JSON.stringify({ missing: true, detail: "service name is empty" }),
        );
      }
      return Buffer.from(
        JSON.stringify({
          missing: false,
          name,
          state: this.state,
          pid: this.pid,
          exitCode: this.state === "stopped" ? 0 : null,
        }),
      );
    }

    if (cmd === "sc.exe") {
      const action = args[0];
      const name = args[1];
      this.calls.push(`${action}:${name}`);
      if (action === "start") {
        this.state = "running";
        this.pid = 4321;
      } else if (action === "stop") {
        this.state = "stopped";
        this.pid = 0;
      }
      return Buffer.from("");
    }

    throw new Error(`unexpected command: ${cmd}`);
  };

  controller(): WindowsServiceController {
    return new WindowsServiceController(this.exec, {
      timeoutMs: 1000,
      pollMs: 10,
    });
  }
}

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "sys4sys-service-control-"));
  process.env.DATABASE_URL = join(tempDir, "service-control.db");
  process.env.LOG_LEVEL = "silent";
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("service control state mapping", () => {
  it("maps SCM states to sys4sys states", () => {
    expect(mapScmState("Running")).toBe("running");
    expect(mapScmState("Stopped")).toBe("stopped");
    expect(mapScmState("Start Pending")).toBe("starting");
    expect(mapScmState("Stop Pending")).toBe("stopping");
    expect(mapScmState("Paused")).toBe("degraded");
    expect(mapScmState("Paused Pending")).toBe("degraded");
    expect(mapScmState("Continue Pending")).toBe("unknown");
    expect(mapScmState(null)).toBe("unknown");
  });

  it("parses JSON inspection output with surrounding noise", () => {
    const inspection = parseInspectionPayload(
      '#< CLIXML\r\n<Objs />{"missing":false,"state":"Stopped","pid":0,"exitCode":0}\r\n',
    );
    expect(inspection).toMatchObject({
      state: "stopped",
      pid: null,
      exitCode: 0,
      missing: false,
    });
  });

  it("reports missing services", () => {
    const inspection = parseInspectionPayload(
      JSON.stringify({ missing: true, detail: "service not found" }),
    );
    expect(inspection).toMatchObject({
      state: "unknown",
      missing: true,
      detail: "service not found",
    });
  });

  it("maps sc.exe exit codes", () => {
    expect(scExitCodeToError("start", 1056, "already running")).toBeNull();
    expect(scExitCodeToError("stop", 1062, "not running")).toBeNull();
    expect(
      scExitCodeToError("start", 1060, "service does not exist")?.code,
    ).toBe("not_found");
    expect(scExitCodeToError("stop", 5, "access denied")?.code).toBe(
      "access_denied",
    );
    expect(scExitCodeToError("start", 1053, "cannot start")?.code).toBe(
      "failed",
    );
  });
});

describe.runIf(process.platform === "win32")("Windows SCM controller", () => {
  it("starts a stopped service through sc.exe and waits for Running", async () => {
    const scm = new FakeScm();
    const service = serviceRow({ serviceName: "StartDemo" });

    const inspection = await scm.controller().start(service);

    expect(inspection).toMatchObject({ state: "running", pid: 4321 });
    expect(scm.calls).toEqual([
      "inspect:StartDemo:stopped",
      "start:StartDemo",
      "inspect:StartDemo:running",
    ]);
  });

  it("stops a running service through sc.exe and waits for Stopped", async () => {
    const scm = new FakeScm();
    scm.state = "running";
    scm.pid = 4321;
    const service = serviceRow({ serviceName: "StopDemo" });

    const inspection = await scm.controller().stop(service);

    expect(inspection).toMatchObject({ state: "stopped", pid: null });
    expect(scm.calls).toEqual([
      "inspect:StopDemo:running",
      "stop:StopDemo",
      "inspect:StopDemo:stopped",
    ]);
  });

  it("restarts by stopping and then starting", async () => {
    const scm = new FakeScm();
    scm.state = "running";
    scm.pid = 4321;
    const service = serviceRow({ serviceName: "RestartDemo" });

    const inspection = await scm.controller().restart(service);

    expect(inspection).toMatchObject({ state: "running", pid: 4321 });
    expect(scm.calls).toEqual([
      "inspect:RestartDemo:running",
      "inspect:RestartDemo:running",
      "stop:RestartDemo",
      "inspect:RestartDemo:stopped",
      "inspect:RestartDemo:stopped",
      "start:RestartDemo",
      "inspect:RestartDemo:running",
    ]);
  });

  it("does not call taskkill for external services", async () => {
    const scm = new FakeScm();
    await scm.controller().start(serviceRow({ serviceName: "NoTaskKill" }));
    expect(scm.calls.some((call) => call.startsWith("taskkill"))).toBe(false);
  });

  it("reports missing services as not_found", async () => {
    const service = serviceRow({ serviceName: "" });
    await expect(
      new FakeScm().controller().start(service),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("times out when SCM does not reach the target state", async () => {
    class StuckScm {
      readonly exec = async (cmd: string): Promise<Buffer> => {
        if (cmd === "powershell.exe") {
          return Buffer.from(
            JSON.stringify({ missing: false, state: "stop pending", pid: 1 }),
          );
        }
        return Buffer.from("");
      };
    }

    const controller = new WindowsServiceController(new StuckScm().exec, {
      timeoutMs: 120,
      pollMs: 10,
    });

    await expect(controller.stop(serviceRow())).rejects.toBeInstanceOf(
      ServiceControlError,
    );
  });

  it("treats inspection failures as unknown without throwing", async () => {
    const controller = new WindowsServiceController(
      async () => {
        throw new Error("power shell unavailable");
      },
      { timeoutMs: 500, pollMs: 10 },
    );

    const inspection = await controller.inspect(serviceRow());
    expect(inspection).toMatchObject({ state: "unknown", pid: null });
  });
});
