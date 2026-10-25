import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { changePasswordSchema, loginSchema } from "@sys4sys/shared";
import { writeAudit } from "../audit.js";
import { requireAuth } from "../auth/guard.js";
import {
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "../auth/password.js";
import {
  checkLoginRate,
  clearLoginFailures,
  recordLoginFailure,
} from "../auth/rate-limit.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroyOtherSessions,
  destroySessionByToken,
  getSession,
  setSessionCookie,
} from "../auth/session.js";
import type { AuthUser } from "../auth/types.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";

function toAuthUser(user: typeof users.$inferSelect): AuthUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const email = body.email.toLowerCase();
    const rateKey = `${request.ip}|${email}`;

    const rate = checkLoginRate(rateKey);
    if (!rate.allowed) {
      reply.header("retry-after", String(rate.retryAfterSec));
      return reply
        .code(429)
        .type("application/problem+json")
        .send({
          type: "about:blank",
          title: "Too Many Requests",
          status: 429,
          detail: `ログイン試行が多すぎます。${rate.retryAfterSec} 秒後に再試行してください。`,
        });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user || !user.isActive) {
      await verifyAgainstDummy(body.password);
      recordLoginFailure(rateKey);
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "メールアドレスまたはパスワードが違います",
      });
    }

    const valid = await verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      recordLoginFailure(rateKey);
      await writeAudit({
        actorLabel: email,
        action: "auth.login.failed",
        target: `user:${user.id}`,
        ip: request.ip,
      });
      return reply.code(401).type("application/problem+json").send({
        type: "about:blank",
        title: "Unauthorized",
        status: 401,
        detail: "メールアドレスまたはパスワードが違います",
      });
    }

    clearLoginFailures(rateKey);
    const session = await createSession(user.id, request);
    setSessionCookie(reply, session.token, session.expiresAt);

    await db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));

    await writeAudit({
      actorUserId: user.id,
      actorLabel: user.email,
      action: "auth.login",
      target: `user:${user.id}`,
      ip: request.ip,
    });

    return toAuthUser(user);
  });

  app.get(
    "/auth/me",
    { preHandler: requireAuth, config: { authOnly: true } },
    async (request) => {
      const user = request.authUser;
      if (!user) return null;
      return {
        ...user,
        authMethod: request.authMethod ?? "session",
        scopes: request.authScopes ?? [],
        ...(request.authToken
          ? {
              token: {
                id: request.authToken.id,
                name: request.authToken.name,
                prefix: request.authToken.prefix,
              },
            }
          : {}),
      };
    },
  );

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      const session = await getSession(request);
      await destroySessionByToken(token);
      if (session) {
        await writeAudit({
          actorUserId: session.user.id,
          actorLabel: session.user.email,
          action: "auth.logout",
          target: `user:${session.user.id}`,
          ip: request.ip,
        });
      }
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.post(
    "/auth/change-password",
    { preHandler: requireAuth },
    async (request, reply) => {
      const body = changePasswordSchema.parse(request.body);
      const authUser = request.authUser;
      if (!authUser) {
        return reply.code(401).send();
      }

      const [user] = await db
        .select()
        .from(users)
        .where(eq(users.id, authUser.id))
        .limit(1);
      if (!user) {
        return reply.code(404).send();
      }

      const valid = await verifyPassword(
        user.passwordHash,
        body.currentPassword,
      );
      if (!valid) {
        return reply.code(401).type("application/problem+json").send({
          type: "about:blank",
          title: "Unauthorized",
          status: 401,
          detail: "現在のパスワードが違います",
        });
      }

      const passwordHash = await hashPassword(body.newPassword);
      await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

      if (request.authSessionId) {
        await destroyOtherSessions(user.id, request.authSessionId);
      }

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "auth.password.change",
        target: `user:${user.id}`,
        ip: request.ip,
      });

      return reply.code(204).send();
    },
  );
}
