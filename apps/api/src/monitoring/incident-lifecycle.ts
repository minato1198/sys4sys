import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  approvals,
  hosts,
  incidentActionProposals,
  incidentEvents,
  incidents,
  services,
} from "../db/schema.js";
import { notifyIncident, type NotificationKind } from "./notify.js";

type IncidentRow = typeof incidents.$inferSelect;

export async function appendIncidentEvent(
  incidentId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await db.insert(incidentEvents).values({
    id: randomUUID(),
    incidentId,
    ts: new Date(),
    type,
    payload: payload ?? null,
  });
}

export async function expirePendingApprovals(
  incidentId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(approvals)
    .set({
      status: "expired",
      decidedAt: now,
      note: "インシデントが解決されました",
    })
    .where(
      and(
        eq(approvals.incidentId, incidentId),
        eq(approvals.status, "pending"),
      ),
    );
  await db
    .update(incidentActionProposals)
    .set({
      status: "expired",
      decidedAt: now,
      error: "インシデントが解決されました",
    })
    .where(
      and(
        eq(incidentActionProposals.incidentId, incidentId),
        inArray(incidentActionProposals.status, [
          "proposed",
          "pending_approval",
        ]),
      ),
    );
}

export async function resolveOtherIncidents(
  serviceId: string,
  keepIncidentId: string,
  note: string,
): Promise<void> {
  const rows = await db
    .update(incidents)
    .set({ status: "resolved", resolvedAt: new Date() })
    .where(
      and(
        eq(incidents.serviceId, serviceId),
        ne(incidents.id, keepIncidentId),
        inArray(incidents.status, ["open", "acked", "approval"]),
      ),
    )
    .returning({ id: incidents.id });
  for (const row of rows) {
    await expirePendingApprovals(row.id);
    await appendIncidentEvent(row.id, "resolved", {
      by: "system",
      note,
    });
  }
}

export async function getService(
  serviceId: string,
): Promise<typeof services.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  return row ?? null;
}

export async function getIncident(
  incidentId: string,
): Promise<IncidentRow | null> {
  const [row] = await db
    .select()
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1);
  return row ?? null;
}

async function getHost(
  hostId: string,
): Promise<typeof hosts.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(hosts)
    .where(eq(hosts.id, hostId))
    .limit(1);
  return row ?? null;
}

export async function notifyForIncident(
  incident: IncidentRow,
  kind: NotificationKind,
  extra?: string,
): Promise<void> {
  const service = await getService(incident.serviceId);
  const host = service ? await getHost(service.hostId) : null;
  await notifyIncident({ incident, service, host, kind, extra });
}
