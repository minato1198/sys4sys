import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { ensureAdminUser } from "./auth/bootstrap.js";
import { cleanupExpiredSessions } from "./auth/session.js";
import { config } from "./config.js";
import { migrateDb } from "./db/migrate.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { portRoutes } from "./routes/ports.js";

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

  const bootstrap = await ensureAdminUser();
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

  return app;
}
