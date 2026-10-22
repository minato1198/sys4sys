import type { IncidentSeverity } from "@sys4sys/shared";
import { sendMail, type OutgoingMail } from "@sys4sys/mail";
import { config } from "../config.js";
import type { hosts, incidents, services, approvals } from "../db/schema.js";
import { getEffectiveMailSettings } from "../settings/mail.js";

type IncidentRow = typeof incidents.$inferSelect;
type ServiceRow = typeof services.$inferSelect;
type HostRow = typeof hosts.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

export type NotificationKind =
  | "detected"
  | "approval"
  | "approved"
  | "rejected"
  | "recovered"
  | "restart_failed"
  | "escalated";

const KIND_LABEL: Record<NotificationKind, string> = {
  detected: "検知",
  approval: "承認待ち",
  approved: "承認",
  rejected: "却下",
  recovered: "復旧",
  restart_failed: "復旧失敗",
  escalated: "エスカレーション",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function severityTag(severity: IncidentSeverity): string {
  return `[${severity}]`;
}

function incidentUrl(incidentId: string): string {
  return `${config.APP_BASE_URL.replace(/\/$/, "")}/incidents?focus=${encodeURIComponent(
    incidentId,
  )}`;
}

function approvalUrl(): string {
  return `${config.APP_BASE_URL.replace(/\/$/, "")}/approvals`;
}

export interface NotifyContext {
  incident: IncidentRow;
  service: ServiceRow | null;
  host: HostRow | null;
  kind: NotificationKind;
  extra?: string;
}

export async function notifyIncident(
  context: NotifyContext,
): Promise<{ sent: boolean; reason?: string }> {
  const effective = await getEffectiveMailSettings();
  if (!effective || effective.recipients.length === 0) {
    return { sent: false, reason: "SMTP is not configured" };
  }

  const { incident, service, host, kind, extra } = context;
  const serviceName = service?.name ?? incident.serviceId;
  const hostName = host?.name ?? host?.distro ?? "unknown";
  const label = KIND_LABEL[kind];
  const subject = `[sys4sys][${label}] ${serviceName}: ${incident.title}`;
  const lines = [
    `sys4sys ${label}通知`,
    "",
    `インシデント: ${incident.title}`,
    `サービス: ${serviceName}`,
    `ホスト: ${hostName}`,
    `重大度: ${incident.severity}`,
    `ステータス: ${incident.status}`,
    `検知: ${incident.detectedBy}`,
    `開始: ${incident.startedAt.toISOString()}`,
    incident.summary ? `概要: ${incident.summary}` : null,
    extra ? `詳細: ${extra}` : null,
    "",
    `インシデント画面: ${incidentUrl(incident.id)}`,
  ].filter((line): line is string => line !== null);

  const htmlLines = lines.map((line) => {
    const link = line.match(/^(.*?: )(https?:\/\/\S+)$/);
    if (link) {
      return `<p>${escapeHtml(link[1]!)}<a href="${escapeHtml(
        link[2]!,
      )}">${escapeHtml(link[2]!)}</a></p>`;
    }
    return `<p>${escapeHtml(line) || "&nbsp;"}</p>`;
  });

  const mail: OutgoingMail = {
    to: effective.recipients,
    subject,
    text: lines.join("\n"),
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6">${htmlLines.join(
      "",
    )}</div>`,
  };

  try {
    await sendMail(
      {
        host: effective.host,
        port: effective.port,
        secure: effective.secure,
        username: effective.username,
        password: effective.password,
        from: effective.from,
      },
      mail,
    );
    return { sent: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[mail] ${severityTag(incident.severity)} notification failed: ${message}`,
    );
    return { sent: false, reason: message };
  }
}

export async function notifyApprovalRequest(
  approval: ApprovalRow,
  incident: IncidentRow,
  service: ServiceRow | null,
  host: HostRow | null,
): Promise<void> {
  const effective = await getEffectiveMailSettings();
  if (!effective || effective.recipients.length === 0) return;
  const serviceName = service?.name ?? incident.serviceId;
  const subject = `[sys4sys][承認待ち] ${serviceName}: 再起動の承認が必要です`;
  const lines = [
    "sys4sys 承認待ち通知",
    "",
    `サービス: ${serviceName}`,
    `ホスト: ${host?.name ?? "unknown"}`,
    `インシデント: ${incident.title}`,
    `重大度: ${incident.severity}`,
    `理由: ${String((approval.requestedAction as { reason?: unknown }).reason ?? "")}`,
    "",
    `承認画面: ${approvalUrl()}`,
    `インシデント画面: ${incidentUrl(incident.id)}`,
  ];
  try {
    await sendMail(
      {
        host: effective.host,
        port: effective.port,
        secure: effective.secure,
        username: effective.username,
        password: effective.password,
        from: effective.from,
      },
      {
        to: effective.recipients,
        subject,
        text: lines.join("\n"),
      },
    );
  } catch (error) {
    console.warn(
      `[mail] approval notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
