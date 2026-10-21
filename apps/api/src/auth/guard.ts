import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "@sys4sys/shared";
import { getSession } from "./session.js";
import "./types.js";

function unauthorized(reply: FastifyReply) {
  return reply.code(401).type("application/problem+json").send({
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    detail: "ログインが必要です",
  });
}

function forbidden(reply: FastifyReply) {
  return reply.code(403).type("application/problem+json").send({
    type: "about:blank",
    title: "Forbidden",
    status: 403,
    detail: "この操作に必要な権限がありません",
  });
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const session = await getSession(request);
  if (!session) {
    await unauthorized(reply);
    return;
  }
  request.authUser = session.user;
  request.authSessionId = session.sessionId;
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
