import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { runFile, stopProcess } from "@sys4sys/agent";
import { buildApp } from "./app.js";

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

const app = await buildApp();
const adminEmail = (
  process.env.ADMIN_EMAIL ?? "admin@sys4sys.local"
).toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD;

interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: <T = unknown>() => T;
}

function cookieOf(response: InjectResponse): string {
  const raw = response.headers["set-cookie"];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return first?.split(";")[0] ?? "";
}

async function login(email: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password },
  });
  return { response, cookie: cookieOf(response as unknown as InjectResponse) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("failed to allocate a free port"));
      }
    });
  });
}

async function startListener(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net=require("net");const s=net.createServer();s.listen(${port},"127.0.0.1",()=>console.log("ready"));`,
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  );

  return new Promise<ChildProcess>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("listener start timed out"));
    }, 10_000);

    child.stdout?.on("data", (data: Buffer) => {
      if (settled || !String(data).includes("ready")) return;
      settled = true;
      clearTimeout(timer);
      resolve(child);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`listener exited before ready (${code})`));
    });
  });
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T | null | undefined>,
  timeoutMs = 20_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

interface SmokeHost {
  id: string;
  kind: "windows" | "wsl";
  name: string;
  distro: string | null;
  enabled: boolean;
  state: "running" | "stopped" | "unknown";
}

interface ServiceBody {
  id: string;
  name: string;
  status: string;
  pid: number | null;
  lastError: string | null;
}

interface PortItem {
  id: string;
  pid: number | null;
  port: number;
  protocol: string;
  conflict: boolean;
  reservation: { status: string } | null;
}

interface PortsBody {
  scannedAt: string;
  items: PortItem[];
  reservations: Array<{ id: string; status: string }>;
}

async function fetchPorts(cookie: string, port?: number): Promise<PortsBody> {
  const query = port ? `?scope=windows&port=${port}` : "?scope=windows";
  const response = await app.inject({
    method: "GET",
    url: `/api/ports${query}`,
    headers: { cookie },
  });
  return response.json<PortsBody>();
}

async function fetchService(
  cookie: string,
  serviceId: string,
): Promise<ServiceBody | null> {
  const response = await app.inject({
    method: "GET",
    url: `/api/services/${serviceId}`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) return null;
  return response.json<ServiceBody>();
}

async function findLog(
  cookie: string,
  serviceId: string,
  needle: string,
): Promise<{ id: string; message: string } | null> {
  const params = new URLSearchParams({
    serviceId,
    q: needle,
    limit: "50",
  });
  const response = await app.inject({
    method: "GET",
    url: `/api/logs?${params.toString()}`,
    headers: { cookie },
  });
  if (response.statusCode !== 200) return null;
  const body = response.json<{
    items: Array<{ id: string; message: string }>;
  }>();
  return body.items.find((item) => item.message.includes(needle)) ?? null;
}

const checks: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean) {
  checks.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
}

try {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  check("health 200", health.statusCode === 200);

  const unauthPorts = await app.inject({
    method: "GET",
    url: "/api/ports?scope=windows",
  });
  check("ports unauthenticated 401", unauthPorts.statusCode === 401);

  const notFound = await app.inject({ method: "GET", url: "/api/nope" });
  check("not found 404", notFound.statusCode === 404);

  const csrfLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { origin: "http://evil.example" },
    payload: { email: adminEmail, password: adminPassword ?? "x".repeat(12) },
  });
  check("login with evil origin 403", csrfLogin.statusCode === 403);

  if (!adminPassword) {
    console.log("auth checks skipped (ADMIN_PASSWORD not set)");
  } else {
    const admin = await login(adminEmail, adminPassword);
    check("admin login 200", admin.response.statusCode === 200);

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: admin.cookie },
    });
    const meBody = me.json<{ role?: string }>();
    check("admin me 200", me.statusCode === 200 && meBody.role === "admin");

    const ports = await fetchPorts(admin.cookie);
    check(
      "ports include reservations and scannedAt",
      Array.isArray(ports.items) &&
        Array.isArray(ports.reservations) &&
        typeof ports.scannedAt === "string",
    );

    const hosts = await app.inject({
      method: "GET",
      url: "/api/hosts",
      headers: { cookie: admin.cookie },
    });
    const hostList = hosts.json<SmokeHost[]>();
    check(
      "hosts include seeded windows host",
      hosts.statusCode === 200 &&
        hostList.some((host) => host.kind === "windows"),
    );

    const suffix = Date.now().toString(36);
    const operatorEmail = `operator-${suffix}@sys4sys.local`;
    const viewerEmail = `viewer-${suffix}@sys4sys.local`;
    const memberPassword = "Member-Password-123!";

    const createOperator = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie },
      payload: {
        email: operatorEmail,
        name: "Operator",
        password: memberPassword,
        role: "operator",
      },
    });
    const createViewer = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin.cookie },
      payload: {
        email: viewerEmail,
        name: "Viewer",
        password: memberPassword,
        role: "viewer",
      },
    });
    check(
      "admin creates operator and viewer",
      createOperator.statusCode === 201 && createViewer.statusCode === 201,
    );

    const users = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: admin.cookie },
    });
    check(
      "admin lists users (password hash hidden)",
      users.statusCode === 200 &&
        !users.body.includes("password") &&
        users.body.includes(operatorEmail),
    );

    const operator = await login(operatorEmail, memberPassword);
    const viewer = await login(viewerEmail, memberPassword);
    const operatorCookie = operator.cookie;
    const viewerCookie = viewer.cookie;

    const operatorUsers = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie: operatorCookie },
    });
    check("operator cannot list users", operatorUsers.statusCode === 403);

    const viewerReserve = await app.inject({
      method: "POST",
      url: "/api/ports/reserve",
      headers: { cookie: viewerCookie, "content-type": "application/json" },
      payload: {
        scope: "windows",
        protocol: "tcp",
        port: 12345,
        serviceId: "x",
      },
    });
    check("viewer cannot reserve", viewerReserve.statusCode === 403);

    const viewerDetect = await app.inject({
      method: "POST",
      url: "/api/hosts/wsl/detect",
      headers: { cookie: viewerCookie },
    });
    check("viewer cannot detect WSL", viewerDetect.statusCode === 403);

    // --- reservation + conflict + kill -----------------------------------
    let reservedPort: number | null = null;
    let reservationId: string | null = null;
    for (let attempt = 0; attempt < 5 && !reservedPort; attempt += 1) {
      const candidate = await freeTcpPort();
      const response = await app.inject({
        method: "POST",
        url: "/api/ports/reserve",
        headers: { cookie: operatorCookie, "content-type": "application/json" },
        payload: {
          scope: "windows",
          protocol: "tcp",
          port: candidate,
          serviceId: "smoke-listener",
          note: "m1 smoke",
        },
      });
      if (response.statusCode === 201) {
        reservedPort = candidate;
        reservationId = response.json<{ id: string }>().id;
        break;
      }
    }
    check("operator reserves a free port", reservedPort !== null);

    if (reservedPort) {
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/ports/reserve",
        headers: { cookie: operatorCookie, "content-type": "application/json" },
        payload: {
          scope: "windows",
          protocol: "tcp",
          port: reservedPort,
          serviceId: "smoke-listener",
        },
      });
      check("duplicate reservation 409", duplicate.statusCode === 409);

      const child = await startListener(reservedPort);
      const childPid = child.pid ?? null;
      let killedByApi = false;
      let childExited = false;
      const exitPromise = new Promise<void>((resolve) => {
        child.once("exit", () => {
          childExited = true;
          resolve();
        });
      });

      try {
        const conflict = await waitFor("port conflict", async () => {
          const body = await fetchPorts(operatorCookie, reservedPort ?? 0);
          const item = body.items.find(
            (candidate) => candidate.pid === childPid,
          );
          if (!item || !item.conflict) return null;
          const reservation = body.reservations.find(
            (candidate) => candidate.id === reservationId,
          );
          if (!reservation || reservation.status !== "conflict") return null;
          return { item, reservation };
        });
        check("reserved port shows conflict", Boolean(conflict));

        const tokenResponse = await app.inject({
          method: "GET",
          url: `/api/ports/${reservedPort}/kill-token?scope=windows&pid=${childPid}`,
          headers: { cookie: operatorCookie },
        });
        const tokenBody = tokenResponse.json<{ token?: string }>();
        check(
          "operator gets kill token",
          tokenResponse.statusCode === 200 && Boolean(tokenBody.token),
        );

        if (tokenBody.token && childPid) {
          const killResponse = await app.inject({
            method: "POST",
            url: `/api/ports/${reservedPort}/kill`,
            headers: {
              cookie: operatorCookie,
              "content-type": "application/json",
            },
            payload: {
              scope: "windows",
              pidScope: null,
              confirmToken: tokenBody.token,
              signal: "KILL",
              force: true,
            },
          });
          check(
            "operator kills port process 202",
            killResponse.statusCode === 202,
          );
          killedByApi = killResponse.statusCode === 202;

          await Promise.race([exitPromise, sleep(10_000)]);
          check("child listener exited", childExited);
        }

        const history = await app.inject({
          method: "GET",
          url: `/api/ports/history?scope=windows&port=${reservedPort}&protocol=tcp`,
          headers: { cookie: operatorCookie },
        });
        const entries =
          history.json<
            Array<{ closedAt: string | null; releasedBy: string | null }>
          >();
        check(
          "history records closed entry with actor",
          history.statusCode === 200 &&
            entries.some(
              (entry) =>
                entry.closedAt !== null && entry.releasedBy === operatorEmail,
            ),
        );

        const viewerKillToken = await app.inject({
          method: "GET",
          url: `/api/ports/${reservedPort}/kill-token?scope=windows`,
          headers: { cookie: viewerCookie },
        });
        check(
          "viewer cannot get kill token",
          viewerKillToken.statusCode === 403,
        );
      } finally {
        if (!killedByApi && !childExited && child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }

      const removed = await app.inject({
        method: "DELETE",
        url: `/api/ports/reserve/${reservationId}`,
        headers: { cookie: operatorCookie },
      });
      check("operator deletes reservation 204", removed.statusCode === 204);
    }

    // --- hosts -----------------------------------------------------------
    const detect = await app.inject({
      method: "POST",
      url: "/api/hosts/wsl/detect",
      headers: { cookie: admin.cookie },
    });
    if (detect.statusCode === 200) {
      const distros =
        detect.json<Array<{ name: string; registered: boolean }>>();
      check("admin detects WSL distros", Array.isArray(distros));
      const candidate = distros.find((distro) => !distro.registered);
      if (candidate) {
        const created = await app.inject({
          method: "POST",
          url: "/api/hosts",
          headers: { cookie: admin.cookie, "content-type": "application/json" },
          payload: {
            kind: "wsl",
            name: candidate.name,
            distro: candidate.name,
          },
        });
        check("admin registers WSL host", created.statusCode === 201);
        const hostId = created.json<{ id: string }>().id;
        const patched = await app.inject({
          method: "PATCH",
          url: `/api/hosts/${hostId}`,
          headers: { cookie: admin.cookie, "content-type": "application/json" },
          payload: { enabled: false },
        });
        check(
          "admin disables WSL host",
          patched.statusCode === 200 &&
            patched.json<{ enabled: boolean }>().enabled === false,
        );
      } else {
        console.log("skip host registration (all distros already registered)");
      }
    } else {
      console.log(`skip WSL detect (status ${detect.statusCode})`);
    }

    // --- services + logs (M2) --------------------------------------------
    const m2Hosts = hostList.filter((host) => host.enabled);
    const windowsHost = m2Hosts.find((host) => host.kind === "windows");
    check("windows host available for services", Boolean(windowsHost));

    if (windowsHost) {
      const serviceName = `smoke-service-${suffix}`;
      const logFile = join(process.cwd(), "data", `smoke-log-${suffix}.log`);
      let serviceId: string | null = null;
      let sourceId: string | null = null;

      try {
        const port = await freeTcpPort();
        const script = `const http=require("http");const s=http.createServer((q,r)=>{r.end("ok")});s.listen(${port},"127.0.0.1",()=>{console.log("service-ready");console.error("service-boot");});`;
        const createService = await app.inject({
          method: "POST",
          url: "/api/services",
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
          },
          payload: {
            hostId: windowsHost.id,
            name: serviceName,
            command: [process.execPath, "-e", script],
            expectedPorts: [port],
            healthCheck: {
              type: "http",
              url: `http://127.0.0.1:${port}/`,
              intervalSec: 2,
              timeoutSec: 2,
              failures: 2,
            },
          },
        });
        check("admin creates service 201", createService.statusCode === 201);
        serviceId = createService.json<ServiceBody>().id;

        const viewerStart = await app.inject({
          method: "POST",
          url: `/api/services/${serviceId}/start`,
          headers: { cookie: viewerCookie },
        });
        check("viewer cannot start service", viewerStart.statusCode === 403);

        const startedAt = Date.now();
        const started = await app.inject({
          method: "POST",
          url: `/api/services/${serviceId}/start`,
          headers: { cookie: operatorCookie },
        });
        check(
          "operator starts service 202",
          started.statusCode === 202 &&
            started.json<{ status: string }>().status === "succeeded",
        );

        const running = await waitFor(
          "service running",
          async () => {
            const body = await fetchService(operatorCookie, serviceId!);
            return body?.status === "running" ? body : null;
          },
          15_000,
          250,
        );
        check(
          "service is running with pid",
          running.pid !== null && typeof running.pid === "number",
        );

        const stdoutLog = await waitFor(
          "stdout log",
          () => findLog(operatorCookie, serviceId!, "service-ready"),
          10_000,
          250,
        );
        const elapsed = Date.now() - startedAt;
        check(`stdout log is searchable (${elapsed}ms)`, Boolean(stdoutLog));

        const health = await app.inject({
          method: "GET",
          url: `/api/services/${serviceId}/health`,
          headers: { cookie: operatorCookie },
        });
        check(
          "http health check is healthy",
          health.statusCode === 200 &&
            health.json<{ status: string }>().status === "healthy",
        );

        await mkdir(join(process.cwd(), "data"), { recursive: true });
        await writeFile(logFile, `pre-existing-${suffix}\n`, "utf8");
        const source = await app.inject({
          method: "POST",
          url: "/api/logs/sources",
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
          },
          payload: {
            hostId: windowsHost.id,
            serviceId,
            type: "file",
            config: { path: logFile },
            enabled: true,
          },
        });
        check("admin creates file log source 201", source.statusCode === 201);
        sourceId = source.json<{ id: string }>().id;

        await appendFile(logFile, `file-log-line-${suffix}\n`, "utf8");
        const fileLog = await waitFor(
          "file log",
          () => findLog(operatorCookie, serviceId!, `file-log-line-${suffix}`),
          10_000,
          500,
        );
        check("file log source tails appended line", Boolean(fileLog));

        const disabled = await app.inject({
          method: "PATCH",
          url: `/api/logs/sources/${sourceId}`,
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
          },
          payload: { enabled: false },
        });
        check(
          "admin disables file log source",
          disabled.statusCode === 200 &&
            disabled.json<{ enabled: boolean }>().enabled === false,
        );

        const deleteSource = await app.inject({
          method: "DELETE",
          url: `/api/logs/sources/${sourceId}`,
          headers: { cookie: admin.cookie },
        });
        check(
          "admin deletes file log source 204",
          deleteSource.statusCode === 204,
        );
        sourceId = null;

        const restarted = await app.inject({
          method: "POST",
          url: `/api/services/${serviceId}/restart`,
          headers: { cookie: operatorCookie },
        });
        check("operator restarts service 202", restarted.statusCode === 202);
        const runningAfterRestart = await waitFor(
          "service running after restart",
          async () => {
            const body = await fetchService(operatorCookie, serviceId!);
            return body?.status === "running" ? body : null;
          },
          20_000,
          500,
        );
        check(
          "service is running after restart",
          runningAfterRestart.pid !== null,
        );

        const stopped = await app.inject({
          method: "POST",
          url: `/api/services/${serviceId}/stop`,
          headers: { cookie: operatorCookie },
        });
        check("operator stops service 202", stopped.statusCode === 202);
        const stoppedBody = await waitFor(
          "service stopped",
          async () => {
            const body = await fetchService(operatorCookie, serviceId!);
            return body?.status === "stopped" && body.pid === null
              ? body
              : null;
          },
          20_000,
          250,
        );
        check("service is stopped with pid cleared", stoppedBody.pid === null);

        const renamed = await app.inject({
          method: "PATCH",
          url: `/api/services/${serviceId}`,
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
          },
          payload: { name: `${serviceName}-renamed` },
        });
        check(
          "admin updates service",
          renamed.statusCode === 200 &&
            renamed.json<{ name: string }>().name === `${serviceName}-renamed`,
        );

        const deleted = await app.inject({
          method: "DELETE",
          url: `/api/services/${serviceId}`,
          headers: { cookie: admin.cookie },
        });
        check("admin deletes service 204", deleted.statusCode === 204);
        serviceId = null;
      } finally {
        if (sourceId) {
          await app.inject({
            method: "DELETE",
            url: `/api/logs/sources/${sourceId}`,
            headers: { cookie: admin.cookie },
          });
        }
        if (serviceId) {
          await app.inject({
            method: "POST",
            url: `/api/services/${serviceId}/stop`,
            headers: { cookie: operatorCookie },
          });
          await app.inject({
            method: "DELETE",
            url: `/api/services/${serviceId}`,
            headers: { cookie: admin.cookie },
          });
        }
        await unlink(logFile).catch(() => undefined);
      }
    }

    // --- incidents / approvals (M3) --------------------------------------
    if (windowsHost) {
      const incidentServiceName = `smoke-incident-${suffix}`;
      let incidentServiceId: string | null = null;
      try {
        const createIncidentService = await app.inject({
          method: "POST",
          url: "/api/services",
          headers: {
            cookie: admin.cookie,
            "content-type": "application/json",
          },
          payload: {
            hostId: windowsHost.id,
            name: incidentServiceName,
            command: [
              process.execPath,
              "-e",
              'console.log("m3-ready");setInterval(()=>{},1000);',
            ],
            healthCheck: {
              type: "process",
              intervalSec: 2,
              timeoutSec: 2,
              failures: 2,
            },
            autoRestartPhase: "approve",
          },
        });
        check(
          "admin creates approval-mode service 201",
          createIncidentService.statusCode === 201,
        );
        incidentServiceId = createIncidentService.json<ServiceBody>().id;

        const startIncidentService = await app.inject({
          method: "POST",
          url: `/api/services/${incidentServiceId}/start`,
          headers: { cookie: operatorCookie },
        });
        check(
          "operator starts approval-mode service 202",
          startIncidentService.statusCode === 202,
        );

        const incidentServiceRunning = await waitFor(
          "approval-mode service running",
          async () => {
            const body = await fetchService(operatorCookie, incidentServiceId!);
            return body?.status === "running" && body.pid ? body : null;
          },
          15_000,
          250,
        );
        check(
          "approval-mode service is running with pid",
          typeof incidentServiceRunning.pid === "number",
        );

        const killedAt = Date.now();
        await stopProcess({
          scope: "windows",
          pid: incidentServiceRunning.pid!,
          signal: "KILL",
          force: true,
        });

        const incident = await waitFor(
          "process-exit incident",
          async () => {
            const response = await app.inject({
              method: "GET",
              url: `/api/incidents?serviceId=${incidentServiceId}&limit=10`,
              headers: { cookie: operatorCookie },
            });
            if (response.statusCode !== 200) return null;
            const body = response.json<{
              items: Array<{
                id: string;
                serviceId: string;
                pendingApprovalId: string | null;
              }>;
            }>();
            return (
              body.items.find((item) => item.serviceId === incidentServiceId) ??
              null
            );
          },
          15_000,
          250,
        );
        const detectionMs = Date.now() - killedAt;
        check(`incident detected (${detectionMs}ms)`, detectionMs < 30_000);
        check(
          "phase=approve creates a pending approval",
          Boolean(incident.pendingApprovalId),
        );

        const viewerApprove = await app.inject({
          method: "POST",
          url: `/api/approvals/${incident.pendingApprovalId}/approve`,
          headers: { cookie: viewerCookie },
        });
        check(
          "viewer cannot approve restart",
          viewerApprove.statusCode === 403,
        );

        const pendingApprovals = await app.inject({
          method: "GET",
          url: "/api/approvals?status=pending",
          headers: { cookie: operatorCookie },
        });
        const pendingBody = pendingApprovals.json<{
          items: Array<{ id: string }>;
        }>();
        check(
          "approval queue contains the request",
          pendingApprovals.statusCode === 200 &&
            pendingBody.items.some(
              (item) => item.id === incident.pendingApprovalId,
            ),
        );

        const approved = await app.inject({
          method: "POST",
          url: `/api/approvals/${incident.pendingApprovalId}/approve`,
          headers: {
            cookie: operatorCookie,
            "content-type": "application/json",
          },
          payload: { note: "smoke approval" },
        });
        check("operator approves restart 202", approved.statusCode === 202);

        const resolvedIncident = await waitFor(
          "incident resolved after restart",
          async () => {
            const response = await app.inject({
              method: "GET",
              url: `/api/incidents/${incident.id}`,
              headers: { cookie: operatorCookie },
            });
            if (response.statusCode !== 200) return null;
            const body = response.json<{
              status: string;
              actions: Array<{ type: string; status: string }>;
            }>();
            return body.status === "resolved" ? body : null;
          },
          45_000,
          500,
        );
        check(
          "incident resolved after approved restart",
          resolvedIncident.status === "resolved",
        );
        check(
          "approved restart action succeeded",
          resolvedIncident.actions.some(
            (action) =>
              action.type === "restart" && action.status === "succeeded",
          ),
        );

        const recovered = await fetchService(operatorCookie, incidentServiceId);
        check(
          "service is running after approved restart",
          recovered?.status === "running" && Boolean(recovered.pid),
        );

        const mailSettings = await app.inject({
          method: "GET",
          url: "/api/settings/mail",
          headers: { cookie: admin.cookie },
        });
        check(
          "admin reads mail settings",
          mailSettings.statusCode === 200 &&
            typeof mailSettings.json<{ configured: boolean }>().configured ===
              "boolean",
        );
        const viewerMailSettings = await app.inject({
          method: "GET",
          url: "/api/settings/mail",
          headers: { cookie: viewerCookie },
        });
        check(
          "viewer cannot read mail settings",
          viewerMailSettings.statusCode === 403,
        );

        // --- AI analysis / reports (M4) ----------------------------------
        const aiBaseUrl = (
          process.env.SMOKE_AI_BASE_URL ?? "http://localhost:8081/v1"
        ).replace(/\/+$/, "");
        const aiModel = await (async () => {
          if (process.env.SMOKE_AI_MODEL) return process.env.SMOKE_AI_MODEL;
          try {
            const response = await fetch(`${aiBaseUrl}/models`, {
              signal: AbortSignal.timeout(10_000),
            });
            if (!response.ok) return null;
            const body = (await response.json()) as {
              data?: Array<{ id?: string }>;
            };
            return body.data?.find((item) => item.id)?.id ?? null;
          } catch {
            return null;
          }
        })();

        check("local OpenAI-compatible API is reachable", Boolean(aiModel));
        if (aiModel) {
          const saveAi = await app.inject({
            method: "PUT",
            url: "/api/settings/ai",
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: {
              baseUrl: aiBaseUrl,
              model: aiModel,
              maxInputTokens: 4000,
              temperature: 0,
              timeoutSec: 180,
              dailyRequestLimit: 50,
              sendLogsExternally: false,
            },
          });
          const aiView = saveAi.json<{
            configured: boolean;
            model: string;
            apiKeySet: boolean;
            localEndpoint: boolean;
            externalLogsAllowed: boolean;
          }>();
          check(
            "admin saves AI settings (local endpoint)",
            saveAi.statusCode === 200 &&
              aiView.configured &&
              aiView.model === aiModel &&
              aiView.localEndpoint &&
              aiView.externalLogsAllowed,
          );

          const viewerAi = await app.inject({
            method: "GET",
            url: "/api/settings/ai",
            headers: { cookie: viewerCookie },
          });
          check("viewer cannot read AI settings", viewerAi.statusCode === 403);

          const aiTest = await app.inject({
            method: "POST",
            url: "/api/ai/test",
            headers: { cookie: admin.cookie },
          });
          const aiTestBody = aiTest.json<{
            models?: string[];
            latencyMs?: number;
          }>();
          check(
            "admin tests AI connection",
            aiTest.statusCode === 200 &&
              Array.isArray(aiTestBody.models) &&
              aiTestBody.models.includes(aiModel),
          );

          const analyzeStartedAt = Date.now();
          const analyze = await app.inject({
            method: "POST",
            url: `/api/incidents/${incident.id}/analyze`,
            headers: { cookie: operatorCookie },
          });
          check("operator queues AI analysis 202", analyze.statusCode === 202);

          const analyzed = await waitFor(
            "AI analysis report",
            async () => {
              const response = await app.inject({
                method: "GET",
                url: `/api/incidents/${incident.id}`,
                headers: { cookie: operatorCookie },
              });
              if (response.statusCode !== 200) return null;
              const body = response.json<{
                analysis: {
                  provider: string;
                  result: { summary: string; category: string };
                  createdAt: string;
                } | null;
                report: { id: string; createdAt: string } | null;
              }>();
              if (!body.analysis || !body.report) return null;
              if (body.analysis.provider === "template") return null;
              if (
                new Date(body.analysis.createdAt).getTime() < analyzeStartedAt
              ) {
                return null;
              }
              return body;
            },
            210_000,
            1000,
          );
          check(
            "local LLM produces an analysis",
            analyzed.analysis?.provider === "openai-compatible" &&
              Boolean(analyzed.analysis.result.summary),
          );
          check(
            "incident detail includes generated report",
            Boolean(analyzed.report?.id),
          );

          const reportList = await app.inject({
            method: "GET",
            url: `/api/reports?incidentId=${incident.id}&limit=50`,
            headers: { cookie: operatorCookie },
          });
          const reportListBody = reportList.json<{
            items: Array<{ id: string; incidentId: string }>;
            total: number;
          }>();
          check(
            "reports list is filterable by incident",
            reportList.statusCode === 200 &&
              reportListBody.items.some(
                (item) => item.id === analyzed.report?.id,
              ) &&
              reportListBody.total >= 1,
          );

          if (analyzed.report?.id) {
            const reportDetail = await app.inject({
              method: "GET",
              url: `/api/reports/${analyzed.report.id}`,
              headers: { cookie: operatorCookie },
            });
            const reportBody = reportDetail.json<{
              body: string;
              analysis: { result: { summary: string } } | null;
            }>();
            check(
              "report detail contains Markdown and analysis",
              reportDetail.statusCode === 200 &&
                reportBody.body.includes("# インシデントレポート") &&
                Boolean(reportBody.analysis?.result.summary),
            );

            const exportMd = await app.inject({
              method: "GET",
              url: `/api/reports/${analyzed.report.id}/export?format=md`,
              headers: { cookie: operatorCookie },
            });
            check(
              "report Markdown export",
              exportMd.statusCode === 200 &&
                String(exportMd.headers["content-type"]).includes(
                  "text/markdown",
                ) &&
                exportMd.body.includes("## 推奨対応"),
            );

            const exportJson = await app.inject({
              method: "GET",
              url: `/api/reports/${analyzed.report.id}/export?format=json`,
              headers: { cookie: operatorCookie },
            });
            check(
              "report JSON export",
              exportJson.statusCode === 200 &&
                Boolean(
                  exportJson.json<{ report?: { id: string } }>().report?.id,
                ),
            );
          }

          // --- audit log / retention / backup (M5) ----------------------
          const audit = await app.inject({
            method: "GET",
            url: `/api/audit-logs?action=report.create&target=incident:${incident.id}&limit=20`,
            headers: { cookie: admin.cookie },
          });
          const auditBody = audit.json<{
            items: Array<{ action: string; target: string }>;
          }>();
          check(
            "admin reads audit logs for report creation",
            audit.statusCode === 200 &&
              auditBody.items.some(
                (item) =>
                  item.action === "report.create" &&
                  item.target === `incident:${incident.id}`,
              ),
          );

          const viewerAudit = await app.inject({
            method: "GET",
            url: "/api/audit-logs",
            headers: { cookie: viewerCookie },
          });
          check(
            "viewer cannot read audit logs",
            viewerAudit.statusCode === 403,
          );

          const retention = await app.inject({
            method: "PUT",
            url: "/api/settings/retention",
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: { logDays: 7 },
          });
          const retentionBody = retention.json<{
            logDays: number;
            source: string;
          }>();
          check(
            "admin updates log retention",
            retention.statusCode === 200 &&
              retentionBody.logDays === 7 &&
              retentionBody.source === "db",
          );
          const viewerRetention = await app.inject({
            method: "GET",
            url: "/api/settings/retention",
            headers: { cookie: viewerCookie },
          });
          check(
            "viewer cannot read retention settings",
            viewerRetention.statusCode === 403,
          );

          const viewerBackup = await app.inject({
            method: "POST",
            url: "/api/admin/backup",
            headers: { cookie: viewerCookie },
          });
          check(
            "viewer cannot create database backup",
            viewerBackup.statusCode === 403,
          );

          const backup = await app.inject({
            method: "POST",
            url: "/api/admin/backup",
            headers: { cookie: admin.cookie },
          });
          const backupBody = backup.json<{
            path?: string;
            sizeBytes?: number;
          }>();
          let backupExists = false;
          if (backupBody.path) {
            backupExists = await stat(backupBody.path)
              .then((info) => info.size > 0)
              .catch(() => false);
          }
          check(
            "admin creates database backup",
            backup.statusCode === 200 &&
              Boolean(backupBody.path) &&
              (backupBody.sizeBytes ?? 0) > 0 &&
              backupExists,
          );
          if (backupBody.path) {
            await unlink(backupBody.path).catch(() => undefined);
          }
        }
      } finally {
        if (incidentServiceId) {
          await app.inject({
            method: "POST",
            url: `/api/services/${incidentServiceId}/stop`,
            headers: { cookie: operatorCookie },
          });
          await app.inject({
            method: "DELETE",
            url: `/api/services/${incidentServiceId}`,
            headers: { cookie: admin.cookie },
          });
        }
      }
    }

    // --- WSL service (conditional) ---------------------------------------
    const hostsNow = await app.inject({
      method: "GET",
      url: "/api/hosts",
      headers: { cookie: admin.cookie },
    });
    const currentHosts = hostsNow.json<SmokeHost[]>();
    const wslHost = currentHosts.find(
      (host) => host.kind === "wsl" && host.distro,
    );

    if (!wslHost || !wslHost.distro) {
      console.log("skip WSL service (no WSL host registered)");
    } else {
      let enabledForTest = false;
      let wslServiceId: string | null = null;
      let wslSourceId: string | null = null;
      const wslFilePath = `/tmp/sys4sys-smoke-${suffix}.log`;
      try {
        if (!wslHost.enabled) {
          const enabled = await app.inject({
            method: "PATCH",
            url: `/api/hosts/${wslHost.id}`,
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: { enabled: true },
          });
          check("admin enables WSL host for smoke", enabled.statusCode === 200);
          enabledForTest = true;
        }

        let wslCommand: string[] | null = null;
        try {
          await runFile(
            "wsl.exe",
            ["-d", wslHost.distro, "--", "node", "--version"],
            10_000,
          );
          wslCommand = [
            "node",
            "-e",
            `console.log("wsl-ready");const fs=require("fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(wslFilePath)},"wsl-file-line\\n"),500);`,
          ];
        } catch {
          try {
            await runFile(
              "wsl.exe",
              ["-d", wslHost.distro, "--", "python3", "--version"],
              10_000,
            );
            wslCommand = [
              "python3",
              "-u",
              "-c",
              `print("wsl-ready", flush=True)\nimport time\nf=open(${JSON.stringify(wslFilePath)},"a")\nfor _ in range(120):\n    f.write("wsl-file-line\\n"); f.flush(); time.sleep(0.5)`,
            ];
          } catch {
            wslCommand = null;
          }
        }

        if (!wslCommand) {
          console.log(
            `skip WSL service (node/python3 not found in ${wslHost.distro})`,
          );
        } else {
          const created = await app.inject({
            method: "POST",
            url: "/api/services",
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: {
              hostId: wslHost.id,
              name: `smoke-wsl-${suffix}`,
              command: wslCommand,
              healthCheck: {
                type: "process",
                intervalSec: 2,
                timeoutSec: 2,
                failures: 2,
              },
            },
          });
          check("admin creates WSL service 201", created.statusCode === 201);
          wslServiceId = created.json<ServiceBody>().id;

          const started = await app.inject({
            method: "POST",
            url: `/api/services/${wslServiceId}/start`,
            headers: { cookie: operatorCookie },
          });
          check("operator starts WSL service 202", started.statusCode === 202);

          const running = await waitFor(
            "WSL service running",
            async () => {
              const body = await fetchService(operatorCookie, wslServiceId!);
              return body?.status === "running" && body.pid ? body : null;
            },
            25_000,
            500,
          );
          check(
            "WSL service reports pid",
            running.pid !== null && typeof running.pid === "number",
          );

          const wslLog = await waitFor(
            "WSL stdout log",
            () => findLog(operatorCookie, wslServiceId!, "wsl-ready"),
            15_000,
            500,
          );
          check("WSL service stdout is searchable", Boolean(wslLog));

          const wslSource = await app.inject({
            method: "POST",
            url: "/api/logs/sources",
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: {
              hostId: wslHost.id,
              serviceId: wslServiceId,
              type: "wsl_file",
              config: { path: wslFilePath },
              enabled: true,
            },
          });
          check(
            "admin creates WSL file log source 201",
            wslSource.statusCode === 201,
          );
          wslSourceId = wslSource.json<{ id: string }>().id;

          const wslFileLog = await waitFor(
            "WSL file log",
            () => findLog(operatorCookie, wslServiceId!, "wsl-file-line"),
            20_000,
            500,
          );
          check("WSL file log source tails appended line", Boolean(wslFileLog));

          const deletedWslSource = await app.inject({
            method: "DELETE",
            url: `/api/logs/sources/${wslSourceId}`,
            headers: { cookie: admin.cookie },
          });
          check(
            "admin deletes WSL file log source 204",
            deletedWslSource.statusCode === 204,
          );
          wslSourceId = null;

          const stopped = await app.inject({
            method: "POST",
            url: `/api/services/${wslServiceId}/stop`,
            headers: { cookie: operatorCookie },
          });
          check("operator stops WSL service 202", stopped.statusCode === 202);
          await waitFor(
            "WSL service stopped",
            async () => {
              const body = await fetchService(operatorCookie, wslServiceId!);
              return body?.status === "stopped" ? body : null;
            },
            20_000,
            500,
          );
          check("WSL service stopped", true);

          const deleted = await app.inject({
            method: "DELETE",
            url: `/api/services/${wslServiceId}`,
            headers: { cookie: admin.cookie },
          });
          check("admin deletes WSL service 204", deleted.statusCode === 204);
          wslServiceId = null;
        }
      } finally {
        if (wslSourceId) {
          await app.inject({
            method: "DELETE",
            url: `/api/logs/sources/${wslSourceId}`,
            headers: { cookie: admin.cookie },
          });
        }
        if (wslServiceId) {
          await app.inject({
            method: "POST",
            url: `/api/services/${wslServiceId}/stop`,
            headers: { cookie: operatorCookie },
          });
          await app.inject({
            method: "DELETE",
            url: `/api/services/${wslServiceId}`,
            headers: { cookie: admin.cookie },
          });
        }
        await runFile(
          "wsl.exe",
          ["-d", wslHost.distro, "--", "rm", "-f", wslFilePath],
          10_000,
        ).catch(() => undefined);
        if (enabledForTest) {
          await app.inject({
            method: "PATCH",
            url: `/api/hosts/${wslHost.id}`,
            headers: {
              cookie: admin.cookie,
              "content-type": "application/json",
            },
            payload: { enabled: false },
          });
        }
      }
    }

    // --- CSRF + logout ---------------------------------------------------
    const csrfLogout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: admin.cookie, origin: "http://evil.example" },
    });
    check("logout with evil origin 403", csrfLogout.statusCode === 403);

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie: admin.cookie, origin: "http://127.0.0.1:3000" },
    });
    const meAfter = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: admin.cookie },
    });
    check(
      "logout 204 and session invalidated",
      logout.statusCode === 204 && meAfter.statusCode === 401,
    );

    // --- password change (and restore) ----------------------------------
    const rotated = `${adminPassword}-rotated`;
    const before = await login(adminEmail, adminPassword);
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: before.cookie, "content-type": "application/json" },
      payload: { currentPassword: adminPassword, newPassword: rotated },
    });
    const oldLogin = await login(adminEmail, adminPassword);
    const newLogin = await login(adminEmail, rotated);
    const restore = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: newLogin.cookie, "content-type": "application/json" },
      payload: { currentPassword: rotated, newPassword: adminPassword },
    });
    const restoredLogin = await login(adminEmail, adminPassword);
    check(
      "password rotation works and is restored",
      changed.statusCode === 204 &&
        oldLogin.response.statusCode === 401 &&
        newLogin.response.statusCode === 200 &&
        restore.statusCode === 204 &&
        restoredLogin.response.statusCode === 200,
    );
  }
} finally {
  await app.close();
}

const failed = checks.filter((entry) => !entry.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed`,
);
if (failed.length > 0 || checks.length === 0) {
  process.exitCode = 1;
}
