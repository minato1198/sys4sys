import { buildApp } from "./app.js";

const app = await buildApp();

try {
  const health = await app.inject({ method: "GET", url: "/api/health" });
  console.log(`health: ${health.statusCode} ${health.body}`);

  const ports = await app.inject({
    method: "GET",
    url: "/api/ports?scope=windows",
  });
  const body = ports.json() as { items?: unknown[]; scannedAt?: string };
  console.log(
    `ports: ${ports.statusCode} ${body.items?.length ?? 0} rows (${body.scannedAt ?? "-"})`,
  );

  const notFound = await app.inject({ method: "GET", url: "/api/nope" });
  console.log(
    `not-found: ${notFound.statusCode} ${notFound.headers["content-type"]}`,
  );

  if (
    health.statusCode !== 200 ||
    ports.statusCode !== 200 ||
    notFound.statusCode !== 404
  ) {
    process.exitCode = 1;
  }
} finally {
  await app.close();
}
