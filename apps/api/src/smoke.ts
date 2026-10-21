import { buildApp } from "./app.js";

const app = await buildApp();
const email = process.env.ADMIN_EMAIL ?? "admin@sys4sys.local";
const password = process.env.ADMIN_PASSWORD;

try {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  console.log(`health: ${health.statusCode} ${health.body}`);

  const unauthorizedPorts = await app.inject({
    method: "GET",
    url: "/api/ports?scope=windows",
  });
  console.log(`ports(unauth): ${unauthorizedPorts.statusCode}`);

  const notFound = await app.inject({ method: "GET", url: "/api/nope" });
  console.log(
    `not-found: ${notFound.statusCode} ${notFound.headers["content-type"]}`,
  );

  let authOk = true;
  if (password) {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    const setCookie = login.headers["set-cookie"];
    const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookie = rawCookie?.split(";")[0] ?? "";
    console.log(
      `login: ${login.statusCode} cookie=${cookie ? "set" : "missing"}`,
    );

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    console.log(`me: ${me.statusCode} ${me.body}`);

    const ports = await app.inject({
      method: "GET",
      url: "/api/ports?scope=windows",
      headers: { cookie },
    });
    const body = ports.json() as { items?: unknown[]; scannedAt?: string };
    console.log(
      `ports(auth): ${ports.statusCode} ${body.items?.length ?? 0} rows (${body.scannedAt ?? "-"})`,
    );

    const logout = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    const meAfterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie },
    });
    console.log(
      `logout: ${logout.statusCode} me-after-logout: ${meAfterLogout.statusCode}`,
    );

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: `${password}-wrong` },
    });
    console.log(`login(bad): ${badLogin.statusCode}`);

    const relogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    const reloginSetCookie = relogin.headers["set-cookie"];
    const reloginRaw = Array.isArray(reloginSetCookie)
      ? reloginSetCookie[0]
      : reloginSetCookie;
    const reloginCookie = reloginRaw?.split(";")[0] ?? "";

    const newPassword = `${password}-new`;
    const changed = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: { cookie: reloginCookie },
      payload: { currentPassword: password, newPassword },
    });
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password },
    });
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: newPassword },
    });
    console.log(
      `change-password: ${changed.statusCode} old-login: ${oldLogin.statusCode} new-login: ${newLogin.statusCode}`,
    );

    authOk =
      login.statusCode === 200 &&
      cookie.length > 0 &&
      me.statusCode === 200 &&
      ports.statusCode === 200 &&
      logout.statusCode === 204 &&
      meAfterLogout.statusCode === 401 &&
      badLogin.statusCode === 401 &&
      changed.statusCode === 204 &&
      oldLogin.statusCode === 401 &&
      newLogin.statusCode === 200;
  } else {
    console.log("auth checks skipped (ADMIN_PASSWORD not set)");
  }

  if (
    health.statusCode !== 200 ||
    unauthorizedPorts.statusCode !== 401 ||
    notFound.statusCode !== 404 ||
    !authOk
  ) {
    process.exitCode = 1;
  }
} finally {
  await app.close();
}
