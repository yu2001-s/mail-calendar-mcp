/**
 * SMTP submission for iCloud drafts: an already-composed RFC 5322 message is
 * sent as-is over SMTP via nodemailer, with a separate envelope so Bcc
 * recipients receive it without appearing in its headers.
 *
 * Connection settings come from the Worker's environment (secrets set by
 * scripts/setup-worker.mjs).
 *
 * @module services/smtpMailer
 */

import nodemailer from "nodemailer";
import type { AttachmentInput } from "@/types.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";

/** The fields of a message to compose, as built for replies. */
export interface SmtpSendOptions {
  to: string[];
  subject: string;
  /** Plain-text body. Always sent as the text/plain part. */
  body: string;
  cc?: string[];
  bcc?: string[];
  /** Overrides the configured From address (must be allowed by the SMTP server). */
  from?: string;
  /** Inline base64 attachments. */
  attachments?: AttachmentInput[];
  /**
   * Optional HTML body. When provided, the message is sent as
   * multipart/alternative ({@link SmtpSendOptions.body} as the text/plain part,
   * this as the text/html part) so clients pick the richer rendering while
   * plain-text clients still get a clean fallback.
   */
  htmlBody?: string;
  /**
   * RFC 5322 threading (2.5.0): the message this is replying to — emitted as the
   * `In-Reply-To` header so SMTP replies/forwards thread correctly in Gmail and
   * other clients. Pass the original message's `Message-ID`.
   */
  inReplyTo?: string;
  /**
   * RFC 5322 threading (2.5.0): the `References` chain — the original message's
   * existing `References` plus its `Message-ID`. nodemailer accepts an array.
   */
  references?: string[];
}

/** Resolved SMTP connection configuration. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  allowedFrom?: string[];
}

/** Result of an SMTP send. */
export interface SmtpSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /**
   * True when the connection failed after submission may have started and the
   * caller must not automatically retry.
   */
  uncertain?: boolean;
}

export interface RawSmtpEnvelope {
  from: string;
  to: string[];
}

/** Environment variables consumed by {@link resolveSmtpConfig}. */
export const SMTP_ENV = {
  host: "APPLE_MAIL_MCP_SMTP_HOST",
  port: "APPLE_MAIL_MCP_SMTP_PORT",
  secure: "APPLE_MAIL_MCP_SMTP_SECURE",
  user: "APPLE_MAIL_MCP_SMTP_USER",
  from: "APPLE_MAIL_MCP_SMTP_FROM",
  allowedFrom: "APPLE_MAIL_MCP_SMTP_ALLOWED_FROM",
  password: "APPLE_MAIL_MCP_SMTP_PASSWORD",
} as const;

/**
 * Resolves SMTP connection configuration from the environment.
 *
 * @throws Error with an actionable message listing the missing settings.
 */
export function resolveSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig {
  const host = env[SMTP_ENV.host]?.trim();
  const user = env[SMTP_ENV.user]?.trim();

  const missing: string[] = [];
  if (!host) missing.push(SMTP_ENV.host);
  if (!user) missing.push(SMTP_ENV.user);
  if (missing.length > 0) {
    throw new Error(
      `SMTP transport is not configured. Set ${missing.join(" and ")} ` +
        `(plus a password via ${SMTP_ENV.password}). ` +
        SETUP_HINT
    );
  }

  // secure=true => implicit TLS (port 465); otherwise STARTTLS (port 587).
  const secure = /^(1|true|yes)$/i.test(env[SMTP_ENV.secure]?.trim() ?? "");
  const port = env[SMTP_ENV.port]
    ? Number.parseInt(env[SMTP_ENV.port] as string, 10)
    : secure
      ? 465
      : 587;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid ${SMTP_ENV.port}: "${env[SMTP_ENV.port]}" is not a valid port.`);
  }

  const from = env[SMTP_ENV.from]?.trim() || (user as string);
  const allowedFrom = (env[SMTP_ENV.allowedFrom] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const pass = env[SMTP_ENV.password];
  if (!pass) {
    throw new Error(`No SMTP password found. Set ${SMTP_ENV.password}. ` + SETUP_HINT);
  }

  return { host: host as string, port, secure, user: user as string, pass, from, allowedFrom };
}

function senderAddress(value: string): string {
  const angle = value.match(/<([^<>]+)>/);
  return (angle?.[1] ?? value).trim().toLowerCase();
}

/** Sends composed messages; {@link sendRawViaSmtp} is one, a session's `send` another. */
export type RawSmtpSend = (
  raw: Buffer,
  envelope: RawSmtpEnvelope,
  config: SmtpConfig
) => Promise<SmtpSendResult>;

/** Several messages over one SMTP login. */
export interface SmtpSession {
  send: RawSmtpSend;
  close(): void;
}

/** What a send needs of a nodemailer transport, pooled or not. */
interface Transporter {
  sendMail(mail: { envelope: RawSmtpEnvelope; raw: Buffer }): Promise<{ messageId?: string }>;
  close(): void;
}

/** The From check and the submission every send shares. */
async function submitRaw(
  transporter: () => Transporter,
  raw: Buffer,
  envelope: RawSmtpEnvelope,
  config: SmtpConfig
): Promise<SmtpSendResult> {
  const requestedFrom = senderAddress(envelope.from);
  const allowedFrom = new Set(
    [config.user, config.from, ...(config.allowedFrom ?? [])].map(senderAddress)
  );
  if (!allowedFrom.has(requestedFrom)) {
    return {
      success: false,
      error: `SMTP From "${envelope.from}" is not a configured sender identity.`,
    };
  }
  if (envelope.to.length === 0) {
    return { success: false, error: "SMTP envelope has no recipients." };
  }
  try {
    const info = await transporter().sendMail({
      envelope: { from: requestedFrom, to: envelope.to },
      raw,
    });
    return { success: true, messageId: info.messageId };
  } catch (error) {
    const responseCode =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { responseCode?: unknown }).responseCode === "number"
        ? (error as { responseCode: number }).responseCode
        : undefined;
    return {
      success: false,
      error: `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
      uncertain: responseCode === undefined,
    };
  }
}

function transportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  };
}

/**
 * Submit an already-composed RFC 5322 message without rebuilding its MIME.
 * The caller supplies the SMTP envelope separately so Bcc can be omitted from
 * delivered headers while those recipients still receive the message.
 */
export async function sendRawViaSmtp(
  raw: Buffer,
  envelope: RawSmtpEnvelope,
  config: SmtpConfig,
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): Promise<SmtpSendResult> {
  let transporter: Transporter | undefined;
  try {
    return await submitRaw(
      () => (transporter = createTransport(transportOptions(config)) as Transporter),
      raw,
      envelope,
      config
    );
  } finally {
    transporter?.close();
  }
}

/**
 * Send several messages over one connection per server and login: the TLS
 * handshake and AUTH, most of a send's time, happen once. Close it when done.
 */
export function smtpSession(
  createTransport: typeof nodemailer.createTransport = nodemailer.createTransport
): SmtpSession {
  const open = new Map<string, Transporter>();
  return {
    send: (raw, envelope, config) =>
      submitRaw(
        () => {
          const key = JSON.stringify([config.host, config.port, config.secure, config.user]);
          let transporter = open.get(key);
          if (!transporter) {
            // A pool of one keeps the connection open between messages and
            // opens a new one if the server closes it.
            transporter = createTransport({
              ...transportOptions(config),
              pool: true,
              maxConnections: 1,
            }) as Transporter;
            open.set(key, transporter);
          }
          return transporter;
        },
        raw,
        envelope,
        config
      ),
    close() {
      for (const transporter of open.values()) transporter.close();
      open.clear();
    },
  };
}
