import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { userCreateSchema, userUpdateSchema } from "@sys4sys/shared";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireRole } from "../auth/guard.js";
import { hashPassword } from "../auth/password.js";
import { db } from "../db/index.js";
import { sessions, users } from "../db/schema.js";

const idParamsSchema = z.object({ id: z.string().min(1) });

type UserRow = typeof users.$inferSelect;

function publicUser(row: UserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function problem(
  reply: FastifyReply,
  status: number,
  title: string,
  detail: string,
) {
  return reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title,
    status,
    detail,
  });
}

async function activeAdminCount(): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.isActive, true)));
  return row?.value ?? 0;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", { preHandler: requireRole("admin") }, async () => {
    const rows = await db.select().from(users).orderBy(users.createdAt);
    return rows.map(publicUser);
  });

  app.post(
    "/users",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const body = userCreateSchema.parse(request.body);
      const user = request.authUser;
      if (!user) return reply.code(401).send();

      const email = body.email.trim().toLowerCase();
      const [existing] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing) {
        return problem(
          reply,
          409,
          "Conflict",
          "このメールアドレスは既に登録されています",
        );
      }

      const passwordHash = await hashPassword(body.password);
      const id = randomUUID();
      const createdAt = new Date();
      await db.insert(users).values({
        id,
        email,
        name: body.name.trim(),
        passwordHash,
        role: body.role,
        isActive: true,
        lastLoginAt: null,
        createdAt,
      });

      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "user.create",
        target: `user:${id}`,
        after: { email, name: body.name, role: body.role },
        ip: request.ip,
      });

      return reply.code(201).send(
        publicUser({
          id,
          email,
          name: body.name.trim(),
          passwordHash,
          role: body.role,
          isActive: true,
          lastLoginAt: null,
          createdAt,
        }),
      );
    },
  );

  app.patch(
    "/users/:id",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const { id } = idParamsSchema.parse(request.params);
      const body = userUpdateSchema.parse(request.body);
      const actor = request.authUser;
      if (!actor) return reply.code(401).send();

      const [target] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!target) {
        return problem(reply, 404, "Not Found", "ユーザーが見つかりません");
      }

      const removesActiveAdmin =
        target.role === "admin" &&
        target.isActive &&
        ((body.role !== undefined && body.role !== "admin") ||
          body.isActive === false);
      if (removesActiveAdmin && (await activeAdminCount()) <= 1) {
        return problem(
          reply,
          409,
          "Conflict",
          "最後の有効な管理者の権限を外すことはできません",
        );
      }

      const updates: {
        name?: string;
        role?: "admin" | "operator" | "viewer";
        isActive?: boolean;
        passwordHash?: string;
      } = {};
      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.role !== undefined) updates.role = body.role;
      if (body.isActive !== undefined) updates.isActive = body.isActive;
      if (body.password !== undefined) {
        updates.passwordHash = await hashPassword(body.password);
      }

      const passwordChanged = updates.passwordHash !== undefined;
      if (Object.keys(updates).length > 0) {
        await db.update(users).set(updates).where(eq(users.id, id));
      }

      if (passwordChanged || body.isActive === false) {
        await db.delete(sessions).where(eq(sessions.userId, id));
      }

      const [updated] = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      const result = updated ?? target;

      await writeAudit({
        actorUserId: actor.id,
        actorLabel: actor.email,
        action: "user.update",
        target: `user:${id}`,
        before: {
          name: target.name,
          role: target.role,
          isActive: target.isActive,
        },
        after: {
          name: result.name,
          role: result.role,
          isActive: result.isActive,
          passwordChanged,
        },
        ip: request.ip,
      });

      return publicUser(result);
    },
  );
}
