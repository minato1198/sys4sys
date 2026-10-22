import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { stopAnalysisQueue } from "./ai/queue.js";
import { ensureAdminUser } from "./auth/bootstrap.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { config } from "./config.js";
import { migrateDb } from "./db/migrate.js";
import { ensureDefaultHosts } from "./hosts/bootstrap.js";
import { cleanupLogs, startLogRetention } from "./logs/retention.js";
import { startAllLogTailers, stopAllLogTailers } from "./logs/tailers.js";
import { startMonitor, stopMonitor } from "./monitoring/engine.js";
import { aiRoutes } from "./routes/ai.js";
import { approvalRoutes } from "./routes/approvals.js";
import { auditRoutes } from "./routes/audit.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { hostRoutes } from "./routes/hosts.js";
import { incidentRoutes } from "./routes/incidents.js";
import { logRoutes } from "./routes/logs.js";
import { portRoutes } from "./routes/ports.js";
import { reportRoutes } from "./routes/reports.js";
import { serviceRoutes } from "./routes/services.js";
import { settingsRoutes } from "./routes/settings.js";
import { userRoutes } from "./routes/users.js";
import { reconcileDeployments } from "./services/deploy.js";
import { closeServiceWatchers, reconcileServices } from "./services/manager.js";

export async function buildApp() {
  migrateDb();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" },
            },
    },
  });

  await app.register(cookie, { secret: config.SESSION_SECRET });

  // 空ボディの POST（ログアウトなど）を許可する。Fastify の既定 JSON パーサは
  // Content-Type: application/json + 空ボディを 400 にするため。
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const text = (
        typeof body === "string" ? body : body.toString("utf8")
      ).trim();
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (error) {
        done(error as Error);
      }
    },
  );

  const allowedOrigins = new Set(
    config.ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  app.addHook("onRequest", async (request, reply) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      return;
    }

    const fetchSite = request.headers["sec-fetch-site"];
    if (fetchSite === "cross-site") {
      return reply.code(403).type("application/problem+json").send({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "クロスサイトリクエストは許可されていません",
      });
    }

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      return reply.code(403).type("application/problem+json").send({
        type: "about:blank",
        title: "Forbidden",
        status: 403,
        detail: "許可されていない Origin からのリクエストです",
      });
    }
  });

  const bootstrap = await ensureAdminUser();
  const hostsCreated = await ensureDefaultHosts();
  if (hostsCreated) {
    app.log.info("default Windows host registered");
  }
  if (bootstrap.created) {
    if (bootstrap.generatedPassword) {
      app.log.warn(
        { email: bootstrap.email, password: bootstrap.generatedPassword },
        "initial admin user created; set ADMIN_PASSWORD or change it after login",
      );
    } else {
      app.log.info(
        { email: bootstrap.email },
        "initial admin user created from ADMIN_PASSWORD",
      );
    }
  }
  await cleanupExpiredSessions();
  await reconcileServices();
  await reconcileDeployments();
  await startAllLogTailers();
  await cleanupLogs();
  const retentionTimer = startLogRetention();
  startMonitor();

  app.addHook("onClose", async () => {
    clearInterval(retentionTimer);
    stopAnalysisQueue();
    stopMonitor();
    stopAllLogTailers();
    closeServiceWatchers();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(422)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Validation Error",
          status: 422,
          detail: "リクエストの内容が不正です",
          instance: request.url,
          errors: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
    }

    request.log.error(error);
    const status =
      error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    return reply
      .code(status)
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: status >= 500 ? "Internal Server Error" : "Request Error",
        status,
        detail:
          status >= 500 ? "サーバー内部でエラーが発生しました" : error.message,
        instance: request.url,
      });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply
      .code(404)
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: `${request.method} ${request.url} は存在しません`,
        instance: request.url,
      });
  });

  app.get("/", async () => ({ name: "sys4sys-api", version: "0.1.0" }));

  await app.register(healthRoutes, { prefix: "/api" });
  await app.register(authRoutes, { prefix: "/api" });
  await app.register(portRoutes, { prefix: "/api" });
  await app.register(hostRoutes, { prefix: "/api" });
  await app.register(userRoutes, { prefix: "/api" });
  await app.register(serviceRoutes, { prefix: "/api" });
  await app.register(logRoutes, { prefix: "/api" });
  await app.register(incidentRoutes, { prefix: "/api" });
  await app.register(approvalRoutes, { prefix: "/api" });
  await app.register(aiRoutes, { prefix: "/api" });
  await app.register(reportRoutes, { prefix: "/api" });
  await app.register(auditRoutes, { prefix: "/api" });
  await app.register(settingsRoutes, { prefix: "/api" });

  return app;
}
