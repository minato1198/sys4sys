import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  hasScope,
  isScopeSubset,
  isScopeSubsetOf,
  tokenCreateSchema,
  tokenListQuerySchema,
  type TokenScope,
} from "@sys4sys/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireAuth } from "../auth/guard.js";
import {
  createApiToken,
  getApiToken,
  listApiTokens,
  revokeApiToken,
} from "../auth/tokens.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

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
      ...extra,
    });
}

function forbidden(reply: FastifyReply, requiredScope?: TokenScope) {
  return problem(
    reply,
    403,
    "Forbidden",
    requiredScope
      ? `この操作には ${requiredScope} スコープが必要です`
      : "この操作に必要な権限がありません",
    requiredScope ? { requiredScope } : undefined,
  );
}

function actor(request: FastifyRequest) {
  const user = request.authUser;
  if (!user) throw new Error("authenticated user is missing");
  return user;
}

export async function tokenRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/tokens",
    { preHandler: requireAuth, config: { authOnly: true } },
    async (request, reply) => {
      const query = tokenListQuerySchema.parse(request.query);
      const user = actor(request);
      const targetUserId = query.userId ?? user.id;
      const scopes = request.authScopes ?? [];

      if (targetUserId !== user.id && !hasScope(scopes, "tokens:manage")) {
        return forbidden(reply, "tokens:manage");
      }

      return listApiTokens(targetUserId);
    },
  );

  app.post(
    "/tokens",
    { preHandler: requireAuth, config: { authOnly: true } },
    async (request, reply) => {
      const body = tokenCreateSchema.parse(request.body ?? {});
      const user = actor(request);
      const authMethod = request.authMethod ?? "session";
      const scopes = request.authScopes ?? [];
      const targetUserId = body.userId ?? user.id;

      if (authMethod === "token" && !hasScope(scopes, "tokens:manage")) {
        return forbidden(reply, "tokens:manage");
      }
      if (targetUserId !== user.id && !hasScope(scopes, "tokens:manage")) {
        return forbidden(reply, "tokens:manage");
      }
      if (authMethod === "token" && !isScopeSubsetOf(body.scopes, scopes)) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "発行元トークンのスコープを超えるトークンは作成できません",
        );
      }

      const [target] = await db
        .select()
        .from(users)
        .where(and(eq(users.id, targetUserId), eq(users.isActive, true)))
        .limit(1);
      if (!target) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "対象ユーザーが見つかりません",
        );
      }

      if (!isScopeSubset(body.scopes, target.role)) {
        return problem(
          reply,
          422,
          "Unprocessable Entity",
          "対象ユーザーのロール上限を超えるスコープは指定できません",
        );
      }

      const created = await createApiToken({
        userId: target.id,
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
      });

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "token.create",
        target: `token:${created.view.id}`,
        after: {
          userId: target.id,
          name: created.view.name,
          scopes: created.view.scopes,
          expiresAt: created.view.expiresAt,
          prefix: created.view.prefix,
          authMethod,
          tokenId: request.authToken?.id ?? null,
        },
        ip: request.ip,
      });

      return reply.code(201).send({ ...created.view, token: created.token });
    },
  );

  app.delete(
    "/tokens/:id",
    { preHandler: requireAuth, config: { authOnly: true } },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const user = actor(request);
      const scopes = request.authScopes ?? [];
      const token = await getApiToken(id);
      if (!token) {
        return problem(reply, 404, "Not Found", "トークンが見つかりません");
      }

      if (token.userId !== user.id && !hasScope(scopes, "tokens:manage")) {
        return forbidden(reply, "tokens:manage");
      }
      if (
        request.authMethod === "token" &&
        token.id !== request.authToken?.id &&
        !hasScope(scopes, "tokens:manage")
      ) {
        return forbidden(reply, "tokens:manage");
      }

      const revoked = await revokeApiToken(token.id, token.userId);
      if (!revoked) {
        return problem(reply, 409, "Conflict", "トークンは既に失効しています");
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "token.revoke",
        target: `token:${token.id}`,
        after: {
          prefix: token.prefix,
          authMethod: request.authMethod ?? "session",
          tokenId: request.authToken?.id ?? null,
        },
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );
}
