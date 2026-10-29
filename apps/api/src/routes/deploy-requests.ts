import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  deployConfigSchema,
  deployRequestCreateSchema,
  deployRequestDecisionSchema,
  deployRequestQuerySchema,
  type DeployRequestSnapshot,
} from "@sys4sys/shared";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { deployRequests, services } from "../db/schema.js";
import { isCommandAllowed } from "../services/allowlist.js";
import {
  approvePendingDeployRequestAtomically,
  buildDeployRequestSnapshot,
  deployRequestExpiresAt,
  expirePendingDeployRequests,
  findPendingDeployRequest,
  requiresDeployApproval,
  snapshotsEqual,
  type DeployRequestRow,
} from "../services/deploy-approvals.js";
import { hasRunningDeploy } from "../services/deploy-lock.js";
import { beginDeploy, isDeployRunning, runDeploy } from "../services/deploy.js";
import { ServiceError, type ServiceRow } from "../services/manager.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type DeployRequestWithService = DeployRequestRow & {
  service: { id: string; name: string } | null;
};

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
  extra?: Record<string, unknown>,
) {
  return reply
    .code(status)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title,
      status,
      detail,
      ...(extra ?? {}),
    });
}

function actor(request: FastifyRequest) {
  const user = request.authUser;
  if (!user) throw new Error("authenticated user is missing");
  return user;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function requestResponse(row: DeployRequestRow, service: ServiceRow | null) {
  return {
    id: row.id,
    serviceId: row.serviceId,
    requestedBy: row.requestedBy,
    requestedAt: iso(row.requestedAt),
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    note: row.note,
    actionId: row.actionId,
    snapshot: row.snapshot,
    expiresAt: iso(row.expiresAt),
    service: service
      ? {
          id: service.id,
          name: service.name,
        }
      : null,
  };
}

async function findService(id: string): Promise<ServiceRow | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, id))
    .limit(1);
  return row ?? null;
}

function isSelfService(service: ServiceRow): boolean {
  if (service.controlMode !== "windows-service" || !config.SELF_SERVICE_NAME) {
    return false;
  }
  return (
    service.serviceName?.trim().toLowerCase() ===
    config.SELF_SERVICE_NAME.toLowerCase()
  );
}

async function findRequest(id: string): Promise<DeployRequestRow | null> {
  const [row] = await db
    .select()
    .from(deployRequests)
    .where(eq(deployRequests.id, id))
    .limit(1);
  return row ?? null;
}

async function serviceForRequest(
  serviceId: string,
): Promise<ServiceRow | null> {
  return findService(serviceId);
}

function snapshotResponse(
  snapshot: DeployRequestSnapshot,
): DeployRequestSnapshot {
  return snapshot;
}

async function expireAndFetchRequest(
  requestRow: DeployRequestRow,
): Promise<DeployRequestRow | null> {
  if (
    requestRow.status === "pending" &&
    new Date(requestRow.expiresAt).getTime() <= Date.now()
  ) {
    await expirePendingDeployRequests(requestRow.serviceId);
    return findRequest(requestRow.id);
  }
  return requestRow;
}

function statusTitle(status: number): string {
  if (status === 403) return "Forbidden";
  if (status === 404) return "Not Found";
  if (status === 409) return "Conflict";
  if (status === 422) return "Unprocessable Entity";
  return "Error";
}

function problemFromError(reply: FastifyReply, error: unknown) {
  if (error instanceof ServiceError) {
    return problem(
      reply,
      error.statusCode,
      statusTitle(error.statusCode),
      error.message,
    );
  }
  if (error instanceof z.ZodError) {
    return problem(
      reply,
      422,
      "Unprocessable Entity",
      error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  throw error;
}

export async function deployRequestRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/services/:id/deploy-requests",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["deploy:execute"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = deployRequestCreateSchema.parse(request.body ?? {});
      const user = actor(request);

      const service = await findService(id);
      if (!service || !service.isActive) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }
      if (!service.deploy) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "デプロイ設定がありません",
        );
      }
      if (isSelfService(service)) {
        return problem(
          reply,
          409,
          "Conflict",
          "sys4sys 自身はこの API からデプロイできません。外部のオーケストレータから実行してください",
        );
      }

      let deploy;
      try {
        deploy = deployConfigSchema.parse(service.deploy);
      } catch {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "デプロイ設定が不正です",
        );
      }

      const allowed = isCommandAllowed(deploy.command);
      if (!allowed.ok) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          allowed.reason ?? "デプロイコマンドが許可されていません",
        );
      }

      await expirePendingDeployRequests(id);

      if (isDeployRunning(id) || (await hasRunningDeploy(id))) {
        return problem(reply, 409, "Conflict", "デプロイは既に実行中です");
      }

      const pending = await findPendingDeployRequest(id);
      if (pending) {
        return problem(
          reply,
          409,
          "Conflict",
          "承認待ちのデプロイ要求が既にあります",
          { deployRequestId: pending.id },
        );
      }

      let snapshot: DeployRequestSnapshot;
      try {
        snapshot = buildDeployRequestSnapshot(service, deploy);
      } catch (error) {
        return problemFromError(reply, error);
      }

      const createdAt = new Date();
      const row = {
        id: randomUUID(),
        serviceId: id,
        requestedBy: user.id,
        requestedAt: createdAt,
        status: "pending" as const,
        decidedBy: null,
        decidedAt: null,
        note: body.note ?? null,
        actionId: null,
        snapshot,
        expiresAt: deployRequestExpiresAt(),
      };

      await db.insert(deployRequests).values(row);
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "deploy.request.requested",
        target: `deploy-request:${row.id}`,
        after: {
          serviceId: id,
          expiresAt: row.expiresAt.toISOString(),
          snapshot: snapshotResponse(snapshot),
        },
        reason: body.note ?? null,
        ip: request.ip,
      });

      return reply.code(201).send(requestResponse(row, service));
    },
  );

  app.get(
    "/deploy-requests",
    {
      preHandler: requireAuth,
      config: { scopes: ["deploy:execute"] },
    },
    async (request) => {
      const query = deployRequestQuerySchema.parse(request.query);
      await expirePendingDeployRequests();

      const [rows, all] = await Promise.all([
        db
          .select()
          .from(deployRequests)
          .where(eq(deployRequests.status, query.status))
          .orderBy(desc(deployRequests.requestedAt))
          .limit(query.limit)
          .offset(query.offset),
        db
          .select({ id: deployRequests.id })
          .from(deployRequests)
          .where(eq(deployRequests.status, query.status)),
      ]);

      const serviceIds = [...new Set(rows.map((row) => row.serviceId))];
      const serviceMap = new Map<string, ServiceRow>();
      for (const serviceId of serviceIds) {
        const service = await serviceForRequest(serviceId);
        if (service) serviceMap.set(serviceId, service);
      }

      return {
        items: rows.map((row) =>
          requestResponse(row, serviceMap.get(row.serviceId) ?? null),
        ),
        total: all.length,
        limit: query.limit,
        offset: query.offset,
      };
    },
  );

  app.get(
    "/deploy-requests/:id",
    {
      preHandler: requireAuth,
      config: { scopes: ["deploy:execute"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      let row = await findRequest(id);
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }
      row = (await expireAndFetchRequest(row)) ?? null;
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }

      return requestResponse(row, await serviceForRequest(row.serviceId));
    },
  );

  app.post(
    "/deploy-requests/:id/approve",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["approvals:decide"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = deployRequestDecisionSchema.parse(request.body ?? {});
      const user = actor(request);

      let row = await findRequest(id);
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }
      row = await expireAndFetchRequest(row);
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }
      if (row.status === "expired") {
        return problem(reply, 409, "Conflict", "デプロイ要求は期限切れです");
      }
      if (row.status !== "pending") {
        return problem(
          reply,
          409,
          "Conflict",
          "デプロイ要求は既に処理されています",
        );
      }

      if (row.requestedBy === user.id && !config.DEPLOY_ALLOW_SELF_APPROVAL) {
        return problem(reply, 403, "Forbidden", "自己承認は許可されていません");
      }

      const service = await findService(row.serviceId);
      if (!service || !service.isActive || !service.deploy) {
        return problem(
          reply,
          409,
          "Conflict",
          "サービスまたはデプロイ設定が存在しません",
        );
      }
      if (isSelfService(service)) {
        return problem(
          reply,
          409,
          "Conflict",
          "sys4sys 自身はこの API からデプロイできません。外部のオーケストレータから実行してください",
        );
      }

      let deploy;
      try {
        deploy = deployConfigSchema.parse(service.deploy);
      } catch {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "デプロイ設定が不正です",
        );
      }

      const allowed = isCommandAllowed(deploy.command);
      if (!allowed.ok) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          allowed.reason ?? "デプロイコマンドが許可されていません",
        );
      }

      if (!requiresDeployApproval(deploy)) {
        return problem(
          reply,
          409,
          "Conflict",
          "デプロイ設定が承認不要に変更されています",
        );
      }

      let currentSnapshot: DeployRequestSnapshot;
      try {
        currentSnapshot = buildDeployRequestSnapshot(service, deploy);
      } catch (error) {
        return problemFromError(reply, error);
      }

      if (!snapshotsEqual(row.snapshot, currentSnapshot)) {
        return problem(
          reply,
          409,
          "Conflict",
          "スナップショット作成後に deploy 設定または env が変更されています",
        );
      }

      const updated = await approvePendingDeployRequestAtomically(
        id,
        user.email,
        body.note ?? null,
      );
      if (!updated) {
        return problem(
          reply,
          409,
          "Conflict",
          "デプロイ要求は既に処理されています",
        );
      }

      let action;
      try {
        action = await beginDeploy(service, user);
      } catch (error) {
        await db
          .update(deployRequests)
          .set({ status: "failed" })
          .where(eq(deployRequests.id, id));
        if (error instanceof ServiceError) {
          return problem(
            reply,
            error.statusCode,
            statusTitle(error.statusCode),
            error.message,
          );
        }
        throw error;
      }

      await db
        .update(deployRequests)
        .set({ actionId: action.id })
        .where(eq(deployRequests.id, id));
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "deploy.request.approve",
        target: `deploy-request:${id}`,
        after: {
          serviceId: row.serviceId,
          actionId: action.id,
        },
        reason: body.note ?? null,
        ip: request.ip,
      });
      void runDeploy(service, deploy, action.id, user, request.ip, id).catch(
        (error: unknown) => {
          console.warn(
            `[deploy-request] runner failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );

      const stored = await findRequest(id);
      return reply.code(202).send({
        request: requestResponse(stored ?? updated, service),
        action: {
          id: action.id,
          status: action.status,
        },
      });
    },
  );

  app.post(
    "/deploy-requests/:id/reject",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["approvals:decide"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = deployRequestDecisionSchema.parse(request.body ?? {});
      const user = actor(request);

      let row = await findRequest(id);
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }
      row = await expireAndFetchRequest(row);
      if (!row) {
        return problem(reply, 404, "Not Found", "デプロイ要求が見つかりません");
      }
      if (row.status === "expired") {
        return problem(reply, 409, "Conflict", "デプロイ要求は期限切れです");
      }
      if (row.status !== "pending") {
        return problem(
          reply,
          409,
          "Conflict",
          "デプロイ要求は既に処理されています",
        );
      }

      const [updated] = await db
        .update(deployRequests)
        .set({
          status: "rejected",
          decidedBy: user.email,
          decidedAt: new Date(),
          note: body.note ?? null,
        })
        .where(eq(deployRequests.id, id))
        .returning();
      if (!updated) {
        return problem(
          reply,
          409,
          "Conflict",
          "デプロイ要求は既に処理されています",
        );
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "deploy.request.reject",
        target: `deploy-request:${id}`,
        after: { serviceId: row.serviceId },
        reason: body.note ?? null,
        ip: request.ip,
      });

      return requestResponse(
        updated,
        await serviceForRequest(updated.serviceId),
      );
    },
  );
}
