import type { FastifyInstance } from "fastify";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
