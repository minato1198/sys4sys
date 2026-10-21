import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";
import type { AuthUser } from "./types.js";

export const SESSION_COOKIE = "sys4sys_session";
const SESSION_TTL_MS = config.SESSION_TTL_HOURS * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  request: FastifyRequest,
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const id = randomUUID();
  const userAgent = request.headers["user-agent"];

  await db.insert(sessions).values({
    id,
    userId,
    tokenHash,
    expiresAt,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 500) : null,
    ip: request.ip,
    createdAt: new Date(),
  });

  return { id, token, expiresAt };
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.COOKIE_SECURE,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export interface SessionContext {
  user: AuthUser;
  sessionId: string;
}

export async function getSession(
  request: FastifyRequest,
): Promise<SessionContext | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date()),
        eq(users.isActive, true),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      role: row.role,
    },
    sessionId: row.sessionId,
  };
}

export async function destroySessionByToken(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function destroyOtherSessions(
  userId: string,
  keepSessionId: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)));
}

export async function cleanupExpiredSessions(): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
