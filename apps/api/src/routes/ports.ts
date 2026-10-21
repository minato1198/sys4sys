import type { FastifyInstance } from "fastify";
import { scanPorts } from "@sys4sys/agent";
import { z } from "zod";
import { requireAuth } from "../auth/guard.js";

const querySchema = z.object({
  scope: z.enum(["all", "windows", "wsl"]).default("all"),
  protocol: z.enum(["tcp", "udp"]).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  serviceId: z.string().optional(),
  q: z.string().max(200).optional(),
});

export async function portRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ports", { preHandler: requireAuth }, async (request) => {
    const query = querySchema.parse(request.query);
    const scan = await scanPorts({ scope: query.scope });

    const needle = query.q?.toLowerCase();
    const items = scan.rows
      .filter((row) =>
        query.protocol ? row.protocol === query.protocol : true,
      )
      .filter((row) => (query.port ? row.port === query.port : true))
      .filter((row) => {
        if (!needle) return true;
        return (
          (row.process ?? "").toLowerCase().includes(needle) ||
          (row.commandLine ?? "").toLowerCase().includes(needle)
        );
      })
      .map((row) => ({
        id: [row.scope, row.protocol, row.address, row.port].join(":"),
        scope: row.scope,
        pidScope: row.pidScope ?? null,
        seenIn: row.seenIn ?? [],
        protocol: row.protocol,
        address: row.address,
        port: row.port,
        pid: row.pid,
        process: row.process,
        processPath: row.processPath ?? null,
        commandLine: row.commandLine,
        serviceId: null,
        likelyWslForward: row.likelyWslForward ?? false,
      }));

    return {
      scannedAt: scan.scannedAt,
      items,
    };
  });
}
