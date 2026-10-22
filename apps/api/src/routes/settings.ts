import type { FastifyInstance, FastifyReply } from "fastify";
import { mailSettingsSchema } from "@sys4sys/shared";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { requireRole } from "../auth/guard.js";
import {
  getMailSettingsView,
  MailNotConfiguredError,
  saveMailSettings,
  testMailSettings,
} from "../settings/mail.js";

const mailUpdateSchema = mailSettingsSchema.extend({
  clearPassword: z.boolean().optional(),
});

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

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/settings/mail", { preHandler: requireRole("admin") }, async () =>
    getMailSettingsView(),
  );

  app.put(
    "/settings/mail",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const body = mailUpdateSchema.parse(request.body);
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      const before = await getMailSettingsView();
      const view = await saveMailSettings(body);
      await writeAudit({
        actorUserId: user.id,
        actorLabel: user.email,
        action: "settings.mail.update",
        target: "settings:mail",
        before: {
          host: before.host,
          from: before.from,
          recipients: before.recipients,
          passwordSet: before.passwordSet,
        },
        after: {
          host: view.host,
          from: view.from,
          recipients: view.recipients,
          passwordSet: view.passwordSet,
        },
        ip: request.ip,
      });
      return view;
    },
  );

  app.post(
    "/settings/mail/test",
    { preHandler: requireRole("admin") },
    async (request, reply) => {
      const user = request.authUser;
      if (!user) return reply.code(401).send();
      try {
        const result = await testMailSettings();
        await writeAudit({
          actorUserId: user.id,
          actorLabel: user.email,
          action: "settings.mail.test",
          target: "settings:mail",
          after: { accepted: result.accepted },
          ip: request.ip,
        });
        return result;
      } catch (error) {
        if (error instanceof MailNotConfiguredError) {
          return problem(reply, 409, "Conflict", error.message);
        }
        return problem(
          reply,
          502,
          "Bad Gateway",
          `テストメールを送信できませんでした: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  );
}
