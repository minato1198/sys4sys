import nodemailer, { type Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
}

export function createTransport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth:
      config.username && config.password
        ? { user: config.username, pass: config.password }
        : undefined,
    tls: {
      // 証明書検証は無効化しない
      rejectUnauthorized: true,
    },
  });
}

export async function verifyConnection(config: SmtpConfig): Promise<void> {
  const transport = createTransport(config);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendMail(
  config: SmtpConfig,
  mail: OutgoingMail,
): Promise<{ messageId: string; accepted: string[] }> {
  const transport = createTransport(config);
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: mail.to.join(", "),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { messageId: info.messageId, accepted: info.accepted.map(String) };
  } finally {
    transport.close();
  }
}
