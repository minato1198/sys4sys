import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { config } from "./config.js";
import { healthRoutes } from "./routes/health.js";
import { portRoutes } from "./routes/ports.js";

export async function buildApp() {
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
  await app.register(portRoutes, { prefix: "/api" });

  return app;
}
