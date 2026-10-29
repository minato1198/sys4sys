import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  deployConfigSchema,
  ENV_MASK,
  serviceActionsQuerySchema,
  serviceCreateSchema,
  serviceListQuerySchema,
  serviceUpdateSchema,
  type DeployConfigInput,
  type ServiceSecretsResponse,
} from "@sys4sys/shared";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { z } from "zod";
import { tryWriteAudit, writeAudit } from "../audit.js";
import { requireAuth, requireRole } from "../auth/guard.js";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { actions, hosts, logSources, services } from "../db/schema.js";
import { refreshLogTailer } from "../logs/tailers.js";
import { isCommandAllowed } from "../services/allowlist.js";
import {
  buildDeployRequestSnapshot,
  expirePendingDeployRequests,
  findPendingDeployRequest,
  requiresDeployApproval,
} from "../services/deploy-approvals.js";
import { hasRunningDeploy } from "../services/deploy-lock.js";
import { beginDeploy, runDeploy } from "../services/deploy.js";
import {
  checkServiceHealth,
  clearServiceRuntime,
  restartService,
  runtimeInfo,
  ServiceError,
  startService,
  stopService,
  type ServiceRow,
} from "../services/manager.js";
import {
  decryptServiceDeployEnv,
  decryptServiceEnv,
  encryptServiceDeploy,
  encryptServiceEnv,
} from "../services/secrets.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type HostRow = typeof hosts.$inferSelect;
type ActionRow = typeof actions.$inferSelect;

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

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function hostResponse(host: HostRow | undefined) {
  if (!host) return null;
  return {
    id: host.id,
    kind: host.kind,
    name: host.name,
    distro: host.distro,
    defaultUser: host.defaultUser,
    enabled: host.enabled,
  };
}

function envKeyList(env: Record<string, string> | null | undefined): string[] {
  return env ? Object.keys(env) : [];
}

function maskedEnv(env: Record<string, string> | null | undefined) {
  if (!env) return null;
  return Object.fromEntries(Object.keys(env).map((key) => [key, ENV_MASK]));
}

function deployDetail(deploy: DeployConfigInput | null | undefined) {
  if (!deploy) return null;
  return {
    command: deploy.command,
    cwd: deploy.cwd ?? null,
    env: maskedEnv(deploy.env),
    envKeys: envKeyList(deploy.env),
    timeoutSec: deploy.timeoutSec,
    restartAfter: deploy.restartAfter,
    healthTimeoutSec: deploy.healthTimeoutSec,
    requireApproval: deploy.requireApproval === true,
    serviceControlOwner: deploy.serviceControlOwner ?? null,
  };
}

function deploySummary(deploy: DeployConfigInput | null | undefined) {
  if (!deploy) return null;
  return {
    command: deploy.command,
    cwd: deploy.cwd ?? null,
    envKeys: envKeyList(deploy.env),
    timeoutSec: deploy.timeoutSec,
    restartAfter: deploy.restartAfter,
    healthTimeoutSec: deploy.healthTimeoutSec,
    requireApproval: deploy.requireApproval === true,
    serviceControlOwner: deploy.serviceControlOwner ?? null,
  };
}

function serviceResponse(
  row: ServiceRow,
  host: HostRow | undefined,
  options: { list?: boolean } = {},
) {
  const runtime = runtimeInfo(row.id, row);
  return {
    id: row.id,
    hostId: row.hostId,
    name: row.name,
    controlMode: row.controlMode,
    serviceName: row.serviceName,
    command: row.command,
    cwd: row.cwd,
    env: options.list ? undefined : maskedEnv(row.env),
    envKeys: envKeyList(row.env),
    expectedPorts: row.expectedPorts ?? [],
    healthCheck: row.healthCheck ?? null,
    deploy: options.list ? deploySummary(row.deploy) : deployDetail(row.deploy),
    dependsOn: row.dependsOn ?? [],
    autoStart: row.autoStart,
    autoRestartPhase: row.autoRestartPhase,
    status: row.status,
    isActive: row.isActive,
    pid: row.pid,
    pidScope: row.pidScope,
    lastStartedAt: iso(row.lastStartedAt),
    lastExitedAt: iso(row.lastExitedAt),
    lastExitCode: row.lastExitCode,
    lastError: row.lastError,
    lastDeployAt: iso(row.lastDeployAt),
    lastDeployStatus: row.lastDeployStatus,
    lastDeployError: row.lastDeployError,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    host: hostResponse(host),
    health: runtime.health,
    runtime,
  };
}

function actionResponse(row: ActionRow) {
  return {
    id: row.id,
    incidentId: row.incidentId,
    serviceId: row.serviceId,
    type: row.type,
    status: row.status,
    requestedBy: row.requestedBy,
    approvedBy: row.approvedBy,
    policyId: row.policyId,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    error: row.error,
  };
}

export function encodeActionsCursor(row: {
  id: string;
  startedAt: Date;
}): string {
  return `${row.startedAt.toISOString()}|${row.id}`;
}

export function decodeActionsCursor(
  cursor: string,
): { startedAt: Date; id: string } | null {
  const separator = cursor.indexOf("|");
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const startedAt = new Date(cursor.slice(0, separator));
  const id = cursor.slice(separator + 1);
  if (Number.isNaN(startedAt.getTime()) || !id) return null;
  return { startedAt, id };
}

async function findService(id: string): Promise<ServiceRow | undefined> {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, id), eq(services.isActive, true)))
    .limit(1);
  return row;
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.includes("SQLITE_CONSTRAINT");
}

function deployValidationError(deploy: DeployConfigInput | null | undefined) {
  if (!deploy) return null;
  const allowed = isCommandAllowed(deploy.command);
  return allowed.ok
    ? null
    : (allowed.reason ?? "デプロイコマンドが許可されていません");
}

function normalizeDeployControl(
  deploy: DeployConfigInput | null | undefined,
  controlMode: "spawn" | "windows-service",
): DeployConfigInput | null {
  if (!deploy) return null;
  if (controlMode === "windows-service") {
    return {
      ...deploy,
      restartAfter: deploy.serviceControlOwner === "sys4sys",
    };
  }
  const { serviceControlOwner: _ignored, ...rest } = deploy;
  return rest;
}

function serviceControlValidationError(input: {
  controlMode: "spawn" | "windows-service";
  serviceName: string | null | undefined;
  hostKind: "windows" | "wsl";
  deploy: DeployConfigInput | null | undefined;
}): string | null {
  if (input.controlMode === "windows-service") {
    if (!input.serviceName?.trim()) {
      return "windows-service には serviceName が必要です";
    }
    if (input.hostKind !== "windows") {
      return "windows-service は Windows ホストでのみ使用できます";
    }
    if (input.deploy && !input.deploy.serviceControlOwner) {
      return "windows-service の deploy には serviceControlOwner が必要です";
    }
    return null;
  }
  if (input.serviceName) {
    return "spawn サービスに serviceName は指定できません";
  }
  return null;
}

function isSelfServiceTarget(
  controlMode: "spawn" | "windows-service",
  serviceName: string | null | undefined,
): boolean {
  if (controlMode !== "windows-service" || !config.SELF_SERVICE_NAME) {
    return false;
  }
  return (
    serviceName?.trim().toLowerCase() === config.SELF_SERVICE_NAME.toLowerCase()
  );
}

function selfServiceProblem(reply: FastifyReply) {
  return problem(
    reply,
    409,
    "Conflict",
    "sys4sys 自身はこの API から停止・再起動・デプロイできません。外部のオーケストレータから実行してください",
  );
}

/** 監査ログには env / deploy.env（秘密値を含み得る）を残さない。 */
function deployAuditValue(deploy: DeployConfigInput | null | undefined) {
  if (!deploy) return null;
  return {
    command: deploy.command,
    cwd: deploy.cwd ?? null,
    envKeys: envKeyList(deploy.env),
    timeoutSec: deploy.timeoutSec,
    restartAfter: deploy.restartAfter,
    healthTimeoutSec: deploy.healthTimeoutSec,
    requireApproval: deploy.requireApproval === true,
    serviceControlOwner: deploy.serviceControlOwner ?? null,
  };
}

/** 監査ログに env 値そのものは残さず、キー名だけを残す。 */
function envAuditValue(env: Record<string, string> | null | undefined) {
  return {
    envKeys: envKeyList(env),
  };
}

function maskedEnvValue(env: Record<string, string> | undefined): boolean {
  return env ? Object.values(env).some((value) => value === ENV_MASK) : false;
}

function maskedEnvValidationError(
  body: {
    env?: Record<string, string> | null;
    deploy?: DeployConfigInput | null;
  },
  existingEnv?: Record<string, string> | null,
  existingDeployEnv?: Record<string, string> | null,
): string | null {
  const errors: string[] = [];
  if (maskedEnvValue(body.env ?? undefined)) {
    errors.push("env");
  }
  if (maskedEnvValue(body.deploy?.env)) {
    errors.push("deploy.env");
  }
  if (errors.length > 0) {
    return `${errors.join(", ")} にマスク値 "${ENV_MASK}" を含めることはできません。値を変更しない場合は env を送信し直すのではなく省略してください`;
  }
  void existingEnv;
  void existingDeployEnv;
  return null;
}

function hasOwnPropertyInBody(
  body: unknown,
  path: [string] | [string, string],
): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const [first, second] = path;
  const value = (body as Record<string, unknown>)[first];
  if (second === undefined) return first in (body as Record<string, unknown>);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return second in (value as Record<string, unknown>);
}

function mergeDeployUpdate(
  bodyDeploy: DeployConfigInput,
  rawBody: unknown,
  existingDeploy: DeployConfigInput | null | undefined,
): DeployConfigInput {
  const merged =
    existingDeploy &&
    !hasOwnPropertyInBody(rawBody, ["deploy", "env"]) &&
    existingDeploy.env
      ? {
          ...bodyDeploy,
          env: existingDeploy.env,
        }
      : bodyDeploy;

  const requireApproval = hasOwnPropertyInBody(rawBody, [
    "deploy",
    "requireApproval",
  ])
    ? bodyDeploy.requireApproval
    : (existingDeploy?.requireApproval ??
      config.DEPLOY_REQUIRE_APPROVAL_DEFAULT);

  return {
    ...merged,
    requireApproval,
  };
}

export async function serviceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/services",
    { preHandler: requireAuth, config: { scopes: ["services:read"] } },
    async (request) => {
      const query = serviceListQuerySchema.parse(request.query);
      const rows = await db
        .select()
        .from(services)
        .where(
          and(
            eq(services.isActive, true),
            query.hostId ? eq(services.hostId, query.hostId) : undefined,
            query.status ? eq(services.status, query.status) : undefined,
          ),
        )
        .orderBy(services.name);
      const hostRows = await db.select().from(hosts);
      const hostMap = new Map(hostRows.map((row) => [row.id, row]));
      return rows.map((row) =>
        serviceResponse(row, hostMap.get(row.hostId), { list: true }),
      );
    },
  );

  app.get(
    "/services/:id",
    { preHandler: requireAuth, config: { scopes: ["services:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const service = await findService(id);
      if (!service) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }
      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, service.hostId))
        .limit(1);
      const recent = await db
        .select()
        .from(actions)
        .where(eq(actions.serviceId, id))
        .orderBy(desc(actions.startedAt))
        .limit(20);
      return {
        ...serviceResponse(service, host),
        recentActions: recent.map(actionResponse),
      };
    },
  );

  app.get(
    "/services/:id/secrets",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["services:secrets"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const service = await findService(id);
      if (!service) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      reply.header("Cache-Control", "no-store");
      let env: Record<string, string> | null;
      let deployEnv: Record<string, string> | null;
      try {
        env = decryptServiceEnv(service.env);
        deployEnv = decryptServiceDeployEnv(service.deploy);
      } catch {
        return problem(
          reply,
          500,
          "Internal Server Error",
          "サービス env の復号に失敗しました",
        );
      }

      const user = actor(request);
      // 秘密値の開示は監査ログの記録を前提にする。ここだけは fail-closed。
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.secrets.reveal",
        target: `service:${id}`,
        before: null,
        after: envAuditValue(service.env),
        reason: "admin revealed service env values",
        ip: request.ip,
      });

      const body: ServiceSecretsResponse = {
        env,
        deployEnv,
      };
      return reply.send(body);
    },
  );

  app.post(
    "/services",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["services:write"] },
    },
    async (request, reply) => {
      const body = serviceCreateSchema.parse(request.body);
      const user = actor(request);

      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, body.hostId))
        .limit(1);
      if (!host) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "ホストが見つかりません",
        );
      }

      const serviceName = body.serviceName?.trim() ?? null;
      const controlError = serviceControlValidationError({
        controlMode: body.controlMode,
        serviceName,
        hostKind: host.kind,
        deploy: body.deploy,
      });
      if (controlError) {
        return problem(reply, 422, "Unprocessable Entity", controlError);
      }

      if (body.controlMode === "spawn") {
        const allowed = isCommandAllowed(body.command);
        if (!allowed.ok) {
          return problem(
            reply,
            422,
            "Unprocessable Entity",
            allowed.reason ?? "コマンドが許可されていません",
          );
        }
      }

      const deployError = deployValidationError(body.deploy);
      if (deployError) {
        return problem(reply, 422, "Unprocessable Entity", deployError);
      }

      const envError = maskedEnvValidationError(body);
      if (envError) {
        return problem(reply, 422, "Unprocessable Entity", envError);
      }

      const now = new Date();
      const id = randomUUID();
      const envToStore = encryptServiceEnv(body.env);
      const normalizedDeploy = normalizeDeployControl(
        body.deploy,
        body.controlMode,
      );
      const deployToStore = encryptServiceDeploy(
        normalizedDeploy
          ? {
              ...normalizedDeploy,
              requireApproval:
                normalizedDeploy.requireApproval ??
                config.DEPLOY_REQUIRE_APPROVAL_DEFAULT,
            }
          : null,
      );
      try {
        await db.insert(services).values({
          id,
          hostId: body.hostId,
          name: body.name,
          controlMode: body.controlMode,
          serviceName,
          command: body.command,
          cwd: body.cwd ?? null,
          env: envToStore,
          expectedPorts: body.expectedPorts ?? null,
          healthCheck: body.healthCheck ?? null,
          deploy: deployToStore ?? null,
          dependsOn: body.dependsOn ?? null,
          autoStart: body.autoStart,
          autoRestartPhase: body.autoRestartPhase,
          status: "stopped",
          createdAt: now,
          updatedAt: now,
          isActive: true,
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return problem(
            reply,
            409,
            "Conflict",
            "同じホストに同名のサービス、または同じ serviceName が既にあります",
          );
        }
        throw error;
      }

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.create",
        target: `service:${id}`,
        after: {
          hostId: body.hostId,
          name: body.name,
          controlMode: body.controlMode,
          serviceName,
          command: body.command,
          expectedPorts: body.expectedPorts ?? null,
          ...envAuditValue(envToStore),
          deploy: deployAuditValue(deployToStore),
        },
        ip: request.ip,
      });

      const [created] = await db
        .select()
        .from(services)
        .where(eq(services.id, id))
        .limit(1);
      return reply.code(201).send(
        serviceResponse(
          created ?? {
            id,
            hostId: body.hostId,
            name: body.name,
            controlMode: body.controlMode,
            serviceName,
            command: body.command,
            cwd: body.cwd ?? null,
            env: envToStore,
            expectedPorts: body.expectedPorts ?? null,
            healthCheck: body.healthCheck ?? null,
            deploy: deployToStore ?? null,
            dependsOn: body.dependsOn ?? null,
            autoStart: body.autoStart,
            autoRestartPhase: body.autoRestartPhase,
            status: "stopped",
            pid: null,
            pidScope: null,
            lastStartedAt: null,
            lastExitedAt: null,
            lastExitCode: null,
            lastError: null,
            lastDeployAt: null,
            lastDeployStatus: null,
            lastDeployError: null,
            createdAt: now,
            updatedAt: now,
            isActive: true,
          },
          host,
        ),
      );
    },
  );

  app.patch(
    "/services/:id",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["services:write"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = serviceUpdateSchema.parse(request.body);
      const user = actor(request);
      const existing = await findService(id);
      if (!existing) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      const [targetHost] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, existing.hostId))
        .limit(1);
      if (!targetHost) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "ホストが見つかりません",
        );
      }

      const targetControlMode = body.controlMode ?? existing.controlMode;
      const targetServiceName =
        body.controlMode === "spawn" && body.serviceName === undefined
          ? null
          : body.serviceName !== undefined
            ? (body.serviceName?.trim() ?? null)
            : existing.serviceName;
      const controlChanged =
        targetControlMode !== existing.controlMode ||
        targetServiceName !== existing.serviceName;

      const candidateDeploy =
        body.deploy !== undefined
          ? body.deploy
            ? mergeDeployUpdate(body.deploy, request.body, existing.deploy)
            : null
          : existing.deploy;
      const controlError = serviceControlValidationError({
        controlMode: targetControlMode,
        serviceName: targetServiceName,
        hostKind: targetHost.kind,
        deploy: candidateDeploy,
      });
      if (controlError) {
        return problem(reply, 422, "Unprocessable Entity", controlError);
      }

      if (
        targetControlMode === "spawn" &&
        (body.command !== undefined || controlChanged)
      ) {
        const allowed = isCommandAllowed(body.command ?? existing.command);
        if (!allowed.ok) {
          return problem(
            reply,
            422,
            "Unprocessable Entity",
            allowed.reason ?? "コマンドが許可されていません",
          );
        }
      }

      const deployError = deployValidationError(body.deploy);
      if (deployError) {
        return problem(reply, 422, "Unprocessable Entity", deployError);
      }

      const envError = maskedEnvValidationError(
        body,
        existing.env,
        existing.deploy?.env,
      );
      if (envError) {
        return problem(reply, 422, "Unprocessable Entity", envError);
      }

      const runtime = runtimeInfo(id, existing);
      const running =
        runtime.running ||
        ["starting", "running", "stopping", "degraded", "restarting"].includes(
          existing.status,
        );
      if (
        running &&
        (body.command !== undefined ||
          body.cwd !== undefined ||
          body.env !== undefined)
      ) {
        return problem(
          reply,
          409,
          "Conflict",
          "実行中は command / cwd / env を変更できません。停止してから更新してください",
        );
      }
      if (running && controlChanged) {
        return problem(
          reply,
          409,
          "Conflict",
          "実行中は controlMode / serviceName を変更できません。停止してから更新してください",
        );
      }

      const updates: Partial<typeof services.$inferInsert> = {
        updatedAt: new Date(),
      };
      const updatedEnv =
        body.env !== undefined ? encryptServiceEnv(body.env) : existing.env;
      let updatedDeploy = existing.deploy;
      if (body.deploy !== undefined || controlChanged) {
        const mergedDeploy =
          body.deploy !== undefined
            ? body.deploy
              ? mergeDeployUpdate(body.deploy, request.body, existing.deploy)
              : null
            : existing.deploy;
        updatedDeploy =
          encryptServiceDeploy(
            normalizeDeployControl(mergedDeploy, targetControlMode),
          ) ?? null;
      }

      if (body.name !== undefined) updates.name = body.name;
      if (controlChanged) {
        updates.controlMode = targetControlMode;
        updates.serviceName = targetServiceName;
      }
      if (body.command !== undefined) updates.command = body.command;
      if (body.cwd !== undefined) updates.cwd = body.cwd;
      if (body.env !== undefined) updates.env = updatedEnv;
      if (body.expectedPorts !== undefined) {
        updates.expectedPorts = body.expectedPorts;
      }
      if (body.healthCheck !== undefined)
        updates.healthCheck = body.healthCheck;
      if (body.deploy !== undefined || controlChanged) {
        updates.deploy = updatedDeploy;
      }
      if (body.dependsOn !== undefined) updates.dependsOn = body.dependsOn;
      if (body.autoStart !== undefined) updates.autoStart = body.autoStart;
      if (body.autoRestartPhase !== undefined) {
        updates.autoRestartPhase = body.autoRestartPhase;
      }

      try {
        await db.update(services).set(updates).where(eq(services.id, id));
      } catch (error) {
        if (isUniqueConstraint(error)) {
          return problem(
            reply,
            409,
            "Conflict",
            "同じホストに同名のサービスが既にあります",
          );
        }
        throw error;
      }

      if (controlChanged) clearServiceRuntime(id);

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.update",
        target: `service:${id}`,
        before: {
          name: existing.name,
          controlMode: existing.controlMode,
          serviceName: existing.serviceName,
          command: existing.command,
          cwd: existing.cwd,
          expectedPorts: existing.expectedPorts,
          ...envAuditValue(existing.env),
          deploy: deployAuditValue(existing.deploy),
          autoStart: existing.autoStart,
          autoRestartPhase: existing.autoRestartPhase,
        },
        after: {
          name: body.name ?? existing.name,
          controlMode: targetControlMode,
          serviceName: targetServiceName,
          command: body.command ?? existing.command,
          cwd: body.cwd !== undefined ? body.cwd : existing.cwd,
          expectedPorts:
            body.expectedPorts !== undefined
              ? body.expectedPorts
              : existing.expectedPorts,
          ...envAuditValue(updatedEnv),
          deploy: deployAuditValue(updatedDeploy),
          autoStart: body.autoStart ?? existing.autoStart,
          autoRestartPhase: body.autoRestartPhase ?? existing.autoRestartPhase,
        },
        ip: request.ip,
      });

      const updated = await findService(id);
      const [host] = await db
        .select()
        .from(hosts)
        .where(eq(hosts.id, (updated ?? existing).hostId))
        .limit(1);
      return serviceResponse(updated ?? existing, host);
    },
  );

  app.delete(
    "/services/:id",
    {
      preHandler: requireRole("admin"),
      config: { scopes: ["services:write"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const existing = await findService(id);
      if (!existing) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      const runtime = runtimeInfo(id, existing);
      if (
        runtime.running ||
        ["starting", "running", "stopping", "degraded", "restarting"].includes(
          existing.status,
        )
      ) {
        return problem(
          reply,
          409,
          "Conflict",
          "実行中のサービスは削除できません。先に停止してください",
        );
      }

      await db
        .update(services)
        .set({
          isActive: false,
          status: "stopped",
          updatedAt: new Date(),
        })
        .where(eq(services.id, id));

      const sources = await db
        .select()
        .from(logSources)
        .where(eq(logSources.serviceId, id));
      if (sources.length > 0) {
        await db
          .update(logSources)
          .set({ enabled: false })
          .where(eq(logSources.serviceId, id));
        for (const source of sources) await refreshLogTailer(source.id);
      }

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "service.delete",
        target: `service:${id}`,
        before: {
          hostId: existing.hostId,
          name: existing.name,
          command: existing.command,
        },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );

  async function performAction(
    request: FastifyRequest,
    reply: FastifyReply,
    type: "start" | "stop" | "restart",
    run: () => Promise<ServiceRow>,
  ) {
    const { id } = idParamsSchema.parse(request.params);
    const user = actor(request);
    const existing = await findService(id);
    if (!existing) {
      return problem(reply, 404, "Not Found", "サービスが見つかりません");
    }
    if (isSelfServiceTarget(existing.controlMode, existing.serviceName)) {
      return selfServiceProblem(reply);
    }
    if (await hasRunningDeploy(id)) {
      return problem(
        reply,
        409,
        "Conflict",
        "デプロイ中はサービスを開始・停止・再起動できません",
      );
    }

    const startedAt = new Date();
    const actionId = randomUUID();
    await db.insert(actions).values({
      id: actionId,
      incidentId: null,
      serviceId: id,
      type,
      status: "running",
      requestedBy: user.id,
      approvedBy: null,
      policyId: null,
      startedAt,
      finishedAt: null,
      error: null,
    });

    try {
      const service = await run();
      const finishedAt = new Date();
      await db
        .update(actions)
        .set({ status: "succeeded", finishedAt })
        .where(eq(actions.id, actionId));

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: `service.${type}`,
        target: `service:${id}`,
        after: {
          actionId,
          name: service.name,
          status: service.status,
          pid: service.pid,
          controlMode: service.controlMode,
          serviceName: service.serviceName,
        },
        ip: request.ip,
      });

      const [action] = await db
        .select()
        .from(actions)
        .where(eq(actions.id, actionId))
        .limit(1);
      return reply.code(202).send(
        action
          ? actionResponse(action)
          : {
              id: actionId,
              incidentId: null,
              serviceId: id,
              type,
              status: "succeeded",
              requestedBy: user.id,
              approvedBy: null,
              policyId: null,
              startedAt: startedAt.toISOString(),
              finishedAt: finishedAt.toISOString(),
              error: null,
            },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date();
      await db
        .update(actions)
        .set({
          status: "failed",
          finishedAt,
          error: message.slice(0, 2000),
        })
        .where(eq(actions.id, actionId));

      await tryWriteAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: `service.${type}.failed`,
        target: `service:${id}`,
        after: { actionId },
        reason: message.slice(0, 500),
        ip: request.ip,
      });

      const status = error instanceof ServiceError ? error.statusCode : 409;
      return problem(reply, status, "Conflict", message);
    }
  }

  app.post(
    "/services/:id/start",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["services:operate"] },
    },
    async (request, reply) =>
      performAction(request, reply, "start", () => {
        const { id } = idParamsSchema.parse(request.params);
        return startService(id);
      }),
  );

  app.post(
    "/services/:id/stop",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["services:operate"] },
    },
    async (request, reply) =>
      performAction(request, reply, "stop", () => {
        const { id } = idParamsSchema.parse(request.params);
        return stopService(id);
      }),
  );

  app.post(
    "/services/:id/restart",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["services:operate"] },
    },
    async (request, reply) =>
      performAction(request, reply, "restart", () => {
        const { id } = idParamsSchema.parse(request.params);
        return restartService(id);
      }),
  );

  app.post(
    "/services/:id/deploy",
    {
      preHandler: requireRole("operator", "admin"),
      config: { scopes: ["deploy:execute"] },
    },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const service = await findService(id);
      if (!service) {
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
      if (isSelfServiceTarget(service.controlMode, service.serviceName)) {
        return selfServiceProblem(reply);
      }

      let deploy: DeployConfigInput;
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
      if (await hasRunningDeploy(id)) {
        return problem(reply, 409, "Conflict", "デプロイは既に実行中です");
      }
      if (requiresDeployApproval(deploy)) {
        const pending = await findPendingDeployRequest(id);
        return problem(reply, 409, "Conflict", "approval_required", {
          deployRequestId: pending?.id ?? null,
        });
      }

      try {
        const action = await beginDeploy(service, user);
        void runDeploy(service, deploy, action.id, user, request.ip).catch(
          (error: unknown) => {
            console.warn(
              `[deploy] runner failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        );
        return reply.code(202).send(actionResponse(action));
      } catch (error) {
        if (error instanceof ServiceError) {
          return problem(
            reply,
            error.statusCode,
            error.statusCode === 409 ? "Conflict" : "Unprocessable Entity",
            error.message,
          );
        }
        throw error;
      }
    },
  );

  app.get(
    "/services/:id/actions",
    { preHandler: requireAuth, config: { scopes: ["services:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const query = serviceActionsQuerySchema.parse(request.query);
      const service = await findService(id);
      if (!service) {
        return problem(reply, 404, "Not Found", "サービスが見つかりません");
      }

      const cursor = query.cursor ? decodeActionsCursor(query.cursor) : null;
      if (query.cursor && !cursor) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "cursor の形式が不正です（<startedAt>|<id>）",
        );
      }

      const conditions = [eq(actions.serviceId, id)];
      if (cursor) {
        conditions.push(
          or(
            lt(actions.startedAt, cursor.startedAt),
            and(
              eq(actions.startedAt, cursor.startedAt),
              lt(actions.id, cursor.id),
            ),
          )!,
        );
      }

      const rows = await db
        .select()
        .from(actions)
        .where(and(...conditions))
        .orderBy(desc(actions.startedAt), desc(actions.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map(actionResponse),
        nextCursor: hasMore && last ? encodeActionsCursor(last) : null,
      };
    },
  );

  app.get(
    "/services/:id/health",
    { preHandler: requireAuth, config: { scopes: ["services:read"] } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      try {
        return await checkServiceHealth(id);
      } catch (error) {
        if (error instanceof ServiceError) {
          return problem(reply, error.statusCode, "Not Found", error.message);
        }
        throw error;
      }
    },
  );
}
