import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
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
    const hostList = hosts.json<Array<{ kind: string }>>();
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
