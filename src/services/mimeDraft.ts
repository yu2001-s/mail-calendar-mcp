import { createHash } from "crypto";
import nodemailer from "nodemailer";
import type { Attachment, AttachmentInput } from "@/types.js";
import { decodeInlineAttachment } from "@/utils/attachmentLimits.js";
import {
  decodeHeaderWord,
  extractHtmlBody,
  extractRfcMessageIdFromSource,
  extractTextBody,
  getMimeHeader,
  parseMimeAttachmentData,
} from "@/utils/mimeParse.js";

export const DRAFT_ID_HEADER = "X-Apple-Mail-Plugin-Draft-ID";

export interface MimeDraftAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface ComposeDraftMimeInput {
  draftUuid: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: Array<AttachmentInput | MimeDraftAttachment>;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  date?: Date;
}

export interface ParsedDraftMime {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: MimeDraftAttachment[];
}

function splitHeaderBody(raw: string): { headers: string; body: string } {
  const index = raw.search(/\r?\n\r?\n/);
  if (index < 0) return { headers: raw, body: "" };
  const separator = raw.slice(index).match(/^\r?\n\r?\n/)?.[0] ?? "\r\n\r\n";
  return { headers: raw.slice(0, index), body: raw.slice(index + separator.length) };
}

export function splitAddresses(value: string | null): string[] {
  if (!value?.trim()) return [];
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    if (!quoted && char === "<") angleDepth += 1;
    if (!quoted && char === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (!quoted && angleDepth === 0 && char === ",") {
      if (current.trim()) parts.push(decodeHeaderWord(current.trim()));
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(decodeHeaderWord(current.trim()));
  return parts;
}

function nodemailerAttachment(input: AttachmentInput | MimeDraftAttachment) {
  if ("contentBase64" in input) {
    return {
      filename: input.filename,
      content: decodeInlineAttachment(input.contentBase64),
    };
  }
  return {
    filename: input.filename,
    content: input.content,
    contentType: input.contentType,
  };
}

/** Build a standards-compliant RFC 5322 draft with Bcc retained for server sync. */
export async function composeDraftMime(input: ComposeDraftMimeInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  } as Parameters<typeof nodemailer.createTransport>[0]) as unknown as {
    sendMail(options: Record<string, unknown>): Promise<{ message: Buffer | string }>;
    close(): void;
  };
  try {
    const info = await transport.sendMail({
      from: input.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.body,
      html: input.htmlBody?.trim() ? input.htmlBody : undefined,
      attachments: input.attachments?.map(nodemailerAttachment),
      messageId: input.messageId,
      inReplyTo: input.inReplyTo,
      references: input.references,
      date: input.date,
      keepBcc: true,
      headers: {
        [DRAFT_ID_HEADER]: input.draftUuid,
      },
    });
    return Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message, "utf8");
  } finally {
    transport.close();
  }
}

export function parseDraftMime(raw: Buffer | string): ParsedDraftMime {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const { headers } = splitHeaderBody(source);
  return {
    from: decodeHeaderWord(getMimeHeader(headers, "From") ?? ""),
    to: splitAddresses(getMimeHeader(headers, "To")),
    cc: splitAddresses(getMimeHeader(headers, "Cc")),
    bcc: splitAddresses(getMimeHeader(headers, "Bcc")),
    subject: decodeHeaderWord(getMimeHeader(headers, "Subject") ?? ""),
    // The server keeps CRLF line ends, and a text part ends with a line break
    // the draft's author never wrote.
    body: (extractTextBody(raw) ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, ""),
    htmlBody: extractHtmlBody(raw) ?? undefined,
    messageId: extractRfcMessageIdFromSource(source) || undefined,
    inReplyTo: getMimeHeader(headers, "In-Reply-To") ?? undefined,
    references: getMimeHeader(headers, "References")?.match(/<[^<>\s]+>/g) ?? undefined,
    attachments: parseMimeAttachmentData(source).map((attachment) => ({
      filename: attachment.name,
      content: attachment.data,
      contentType: attachment.mimeType,
    })),
  };
}

/** The connector draft UUID stored in a draft's own headers, if any. */
export function draftIdFromMime(raw: Buffer | string): string | undefined {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  return getMimeHeader(splitHeaderBody(source).headers, DRAFT_ID_HEADER)?.trim() || undefined;
}

export function draftMimeRevision(raw: Buffer | string): string {
  return createHash("sha256")
    .update(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))
    .digest("hex");
}

/**
 * The message a draft goes out as: headers that belong in a stored draft but
 * must never be delivered removed, and, given `sentAt`, dated when it is sent
 * rather than when it was saved, so it does not sort below mail that arrived
 * in between. MIME body bytes are unchanged, so the reviewed revision is exact.
 */
export function prepareDraftMimeForSend(raw: Buffer | string, sentAt?: Date): Buffer {
  const source = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  const { headers, body } = splitHeaderBody(source);
  const lines = headers.split(/\r?\n/);
  const kept: string[] = [];
  const date = sentAt && `Date: ${rfc5322Date(sentAt)}`;
  let dated = false;
  let skip = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      if (!skip) kept.push(line);
      continue;
    }
    skip = /^(?:bcc|x-apple-mail-plugin-draft-id):/i.test(line);
    if (date && /^date:/i.test(line)) {
      skip = true;
      if (!dated) kept.push(date);
      dated = true;
    }
    if (!skip) kept.push(line);
  }
  if (date && !dated) kept.unshift(date);
  return Buffer.from(`${kept.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}`, "utf8");
}

/** An RFC 5322 date in UTC, as nodemailer writes one. */
function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
}

export function mimeAttachmentsForResource(parsed: ParsedDraftMime, draftId: string): Attachment[] {
  return parsed.attachments.map((attachment, index) => ({
    id: `${draftId}#${index}`,
    name: attachment.filename,
    mimeType: attachment.contentType ?? "application/octet-stream",
    size: attachment.content.length,
  }));
}
