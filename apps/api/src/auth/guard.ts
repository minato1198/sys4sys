import type { FastifyReply, FastifyRequest } from "fastify";
import { hasScope, type Role, type TokenScope } from "@sys4sys/shared";
import { verifyApiToken } from "./tokens.js";
import { getSession } from "./session.js";
import "./types.js";

function unauthorized(reply: FastifyReply) {
  reply.header("WWW-Authenticate", 'Bearer realm="sys4sys"');
  return reply.code(401).type("application/problem+json").send({
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    detail: "ログインが必要です",
  });
}

function forbidden(reply: FastifyReply, requiredScope?: TokenScope) {
  return reply
    .code(403)
    .type("application/problem+json")
    .send({
      type: "about:blank",
      title: "Forbidden",
      status: 403,
      detail: requiredScope
        ? `この操作には ${requiredScope} スコープが必要です`
        : "この操作に必要な権限がありません",
      ...(requiredScope ? { requiredScope } : {}),
    });
}

function routeConfig(request: FastifyRequest): {
  scopes?: TokenScope[];
  authOnly?: boolean;
} {
  return request.routeOptions?.config ?? {};
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authorization = request.headers.authorization;

  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match?.[1]) {
      await unauthorized(reply);
      return;
    }

    const token = await verifyApiToken(match[1].trim());
    if (!token) {
      await unauthorized(reply);
      return;
    }

    request.authUser = token.user;
    request.authMethod = "token";
    request.authScopes = token.scopes;
    request.authToken = {
      id: token.tokenId,
      name: token.name,
      prefix: token.prefix,
      scopes: token.scopes,
      expiresAt: token.expiresAt.toISOString(),
    };

    const config = routeConfig(request);
    if (config.authOnly === true) return;
    if (!config.scopes || config.scopes.length === 0) {
      await forbidden(reply);
      return;
    }
    const missing = config.scopes.find(
      (scope) => !hasScope(token.scopes, scope),
    );
    if (missing) {
      await forbidden(reply, missing);
    }
    return;
  }

  const session = await getSession(request);
  if (!session) {
    await unauthorized(reply);
    return;
  }

  request.authUser = session.user;
  request.authSessionId = session.sessionId;
  request.authMethod = "session";
  request.authScopes = session.scopes;

  const config = routeConfig(request);
  if (config.scopes && config.scopes.length > 0) {
    const missing = config.scopes.find(
      (scope) => !hasScope(session.scopes, scope),
    );
    if (missing) {
      await forbidden(reply, missing);
    }
  }
}

export function requireRole(...roles: Role[]) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(request, reply);
    if (!request.authUser) return;
    if (!roles.includes(request.authUser.role)) {
      await forbidden(reply);
    }
  };
}

export function requireScope(...scopes: TokenScope[]) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(request, reply);
    if (!request.authUser) return;
    const missing = scopes.find(
      (scope) => !hasScope(request.authScopes ?? [], scope),
    );
    if (missing) {
      await forbidden(reply, missing);
    }
  };
}

export function requireAccess(input: { roles?: Role[]; scopes: TokenScope[] }) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    await requireAuth(request, reply);
    if (!request.authUser) return;

    if (input.roles && !input.roles.includes(request.authUser.role)) {
      await forbidden(reply);
      return;
    }

    const missing = input.scopes.find(
      (scope) => !hasScope(request.authScopes ?? [], scope),
    );
    if (missing) {
      await forbidden(reply, missing);
    }
  };
}
