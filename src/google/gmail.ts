/**
 * Gmail through its REST API, shaped like Google's own Gmail connector:
 * threads and messages with view URLs, drafts with merge updates, immediate
 * send/reply/forward, labels, trash and spam.
 */
import nodemailer from "nodemailer";
import type { GoogleAccounts } from "./accounts.js";
import { decodeHeaderWord, parseDraftMime, splitAddresses } from "../services/mimeDraft.js";
import {
  buildReplyOptions,
  parseOriginalHeaders,
  withSubjectPrefix,
} from "../services/replyForward.js";
import { decodeInlineAttachment, MAX_INLINE_ATTACHMENT_BYTES } from "../utils/attachmentLimits.js";
import { contentTypeCharset, decodeCharset } from "../utils/charset.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { htmlToText } from "../utils/htmlText.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const BATCH = "https://gmail.googleapis.com/batch/gmail/v1";
const SUMMARY_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date"];
/** Largest attachment returned inline as base64. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const SEND_AS_TTL_MS = 10 * 60 * 1000;

export type MessageFormat = "MINIMAL" | "FULL_CONTENT" | "METADATA_ONLY" | "PLAIN_TEXT" | "RAW";
export const MESSAGE_FORMATS = [
  "MESSAGE_FORMAT_UNSPECIFIED",
  "MINIMAL",
  "FULL_CONTENT",
  "METADATA_ONLY",
  "PLAIN_TEXT",
  "RAW",
] as const;

export const LABEL_COLOR_PRESETS: Record<string, { backgroundColor: string; textColor: string }> = {
  LABEL_COLOR_PRESET_BLACK: { backgroundColor: "#000000", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GRAY: { backgroundColor: "#434343", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_GRAY: { backgroundColor: "#666666", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_LIGHT_GRAY: { backgroundColor: "#cccccc", textColor: "#000000" },
  LABEL_COLOR_PRESET_WHITE: { backgroundColor: "#ffffff", textColor: "#000000" },
  LABEL_COLOR_PRESET_RED: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_ORANGE: { backgroundColor: "#ffad47", textColor: "#000000" },
  LABEL_COLOR_PRESET_YELLOW: { backgroundColor: "#fad165", textColor: "#000000" },
  LABEL_COLOR_PRESET_GREEN: { backgroundColor: "#16a765", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_MINT: { backgroundColor: "#43d692", textColor: "#000000" },
  LABEL_COLOR_PRESET_TEAL: { backgroundColor: "#2da2bb", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BLUE: { backgroundColor: "#4a86e8", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PURPLE: { backgroundColor: "#a479e2", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_PINK: { backgroundColor: "#f691b2", textColor: "#000000" },
  LABEL_COLOR_PRESET_DARK_RED: { backgroundColor: "#822111", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_ORANGE: { backgroundColor: "#a46a21", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_GREEN: { backgroundColor: "#076239", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_BLUE: { backgroundColor: "#1c4587", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PURPLE: { backgroundColor: "#41236d", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_DARK_PINK: { backgroundColor: "#83334c", textColor: "#ffffff" },
  LABEL_COLOR_PRESET_BROWN: { backgroundColor: "#7a4706", textColor: "#ffffff" },
};
const LABEL_LIST_VISIBILITY: Record<string, string> = {
  LABEL_SHOW: "labelShow",
  LABEL_SHOW_IF_UNREAD: "labelShowIfUnread",
  LABEL_HIDE: "labelHide",
};
const MESSAGE_LIST_VISIBILITY: Record<string, string> = { SHOW: "show", HIDE: "hide" };

interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
  raw?: string;
}

export interface AttachmentInput {
  /** Base64 (standard or URL-safe), or the bytes of an uploaded file. */
  content: string | Buffer;
  filename?: string;
  mimeType?: string;
  inline?: boolean;
}

export interface ComposeFields {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string;
  attachments?: AttachmentInput[];
}

export interface AttachmentView {
  attachmentId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
}

interface CollectedPart extends AttachmentView {
  contentId?: string;
  partId?: string;
  data?: string;
}

interface MimeAttachment {
  filename?: string;
  content: Buffer;
  contentType?: string;
  inline?: boolean;
  cid?: string;
}

interface ComposeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export function messageUrl(account: string, id: string): string {
  return `https://mail.google.com/mail/u/${account}/#all/${id}`;
}

export function draftUrl(account: string, messageId: string): string {
  return `https://mail.google.com/mail/u/${account}/#drafts?compose=${messageId}`;
}

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const value = headers?.find((item) => item.name.toLowerCase() === name.toLowerCase())?.value;
  return value === undefined ? undefined : value.includes("=?") ? decodeHeaderWord(value) : value;
}

function decodeBody(data: string, contentType: string | undefined): string {
  return decodeCharset(Buffer.from(data, "base64url"), contentTypeCharset(contentType));
}

/** Walk a message payload into its text bodies and attachments. */
export function collectParts(payload: GmailPart | undefined): {
  text: string[];
  html: string[];
  attachments: CollectedPart[];
} {
  const out = { text: [] as string[], html: [] as string[], attachments: [] as CollectedPart[] };
  const walk = (part: GmailPart) => {
    const mime = (part.mimeType ?? "").toLowerCase();
    const disposition = header(part.headers, "Content-Disposition") ?? "";
    const isText = mime === "text/plain" || mime === "text/html";
    const isAttachment =
      Boolean(part.filename) ||
      /^attachment/i.test(disposition) ||
      (Boolean(part.body?.attachmentId) && !isText) ||
      (mime === "message/rfc822" && !part.parts?.length);
    if (part.parts?.length && !isAttachment) {
      for (const child of part.parts) walk(child);
      return;
    }
    if (isAttachment) {
      const contentId = header(part.headers, "Content-ID")?.replace(/^<|>$/g, "");
      out.attachments.push({
        attachmentId: part.body?.attachmentId ?? null,
        filename: part.filename || "(unnamed)",
        mimeType: mime || "application/octet-stream",
        size: part.body?.size ?? 0,
        inline:
          /^inline/i.test(disposition) || (Boolean(contentId) && !/^attachment/i.test(disposition)),
        contentId,
        partId: part.partId,
        data: part.body?.data,
      });
      return;
    }
    if (isText && part.body?.data) {
      const decoded = decodeBody(part.body.data, header(part.headers, "Content-Type"));
      (mime === "text/plain" ? out.text : out.html).push(decoded);
    }
  };
  if (payload) walk(payload);
  return out;
}

function bounded(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

export function normalizeFormat(
  format: string | undefined,
  fallback: MessageFormat
): MessageFormat {
  return !format || format === "MESSAGE_FORMAT_UNSPECIFIED" ? fallback : (format as MessageFormat);
}

/** A message in the Gmail connector's shape; fields depend on the format. */
export function messageView(
  account: string,
  message: GmailMessage,
  format: MessageFormat,
  maxBodyChars = 50000
): Record<string, unknown> {
  const headers = message.payload?.headers;
  const view: Record<string, unknown> = {
    id: message.id,
    threadId: message.threadId,
    viewUrl: messageUrl(account, message.id),
    date: message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : header(headers, "Date"),
    sender: header(headers, "From") ?? "",
    toRecipients: splitAddresses(header(headers, "To") ?? null),
    ccRecipients: splitAddresses(header(headers, "Cc") ?? null),
    bccRecipients: splitAddresses(header(headers, "Bcc") ?? null),
    labelIds: message.labelIds ?? [],
  };
  if (format === "METADATA_ONLY") return view;
  view.subject = header(headers, "Subject") ?? "";
  view.snippet = decodeSnippet(message.snippet ?? "");
  if (format === "MINIMAL") return view;
  if (format === "RAW") {
    const raw = bounded(Buffer.from(message.raw ?? "", "base64url").toString("utf8"), maxBodyChars);
    view.raw = raw.text;
    if (raw.truncated) view.bodyTruncated = true;
    return view;
  }
  const { text, html, attachments } = collectParts(message.payload);
  const plain = tidyText(
    text.length ? text.join("\n") : html.length ? htmlToText(html.join("\n")) : ""
  );
  const body = bounded(plain, maxBodyChars);
  view.plaintextBody = body.text;
  let truncated = body.truncated;
  if (format === "FULL_CONTENT" && html.length) {
    const htmlBody = bounded(html.join("\n"), maxBodyChars);
    view.htmlBody = htmlBody.text;
    truncated ||= htmlBody.truncated;
  }
  if (truncated) view.bodyTruncated = true;
  view.attachments = attachments.map(({ attachmentId, filename, mimeType, size, inline }) => ({
    attachmentId,
    filename,
    mimeType,
    size,
    inline,
  }));
  return view;
}

/** Invisible characters newsletters pad previews with. */
const INVISIBLE =
  /\u034f|\u17b4|\u17b5|[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\u3164\ufeff\uffa0]/g;

function decodeSnippet(snippet: string): string {
  return snippet
    .replace(/&(#39|quot|amp|lt|gt);/g, (_, name) =>
      name === "#39"
        ? "'"
        : ({ quot: '"', amp: "&", lt: "<", gt: ">" } as Record<string, string>)[name]
    )
    .replace(INVISIBLE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A plain-text body without padding: LF line ends, no invisible characters, short rules. */
export function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/([-=_*~#.\u2500\u2014])\1{19,}/g, "$1$1$1$1$1$1$1$1$1$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function attachmentsFromInput(inputs: AttachmentInput[] | undefined): MimeAttachment[] {
  let total = 0;
  return (inputs ?? []).map((input, index) => {
    const content =
      typeof input.content === "string"
        ? decodeInlineAttachment(input.content.replace(/-/g, "+").replace(/_/g, "/"))
        : input.content;
    total += content.length;
    if (total > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error("Attachments exceed Gmail's 25 MB limit; share a Drive link instead.");
    }
    const filename = input.filename || (input.inline ? `inline-${index + 1}` : undefined);
    return {
      filename,
      content,
      contentType: input.mimeType || "application/octet-stream",
      inline: input.inline,
      cid: input.inline ? filename : undefined,
    };
  });
}

/** An RFC 5322 message with CRLF line endings; Bcc is kept for Gmail to deliver and strip. */
export async function composeMime(input: ComposeInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "windows",
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
      text: input.text ?? (input.html ? htmlToText(input.html) : ""),
      html: input.html?.trim() ? input.html : undefined,
      attachments: input.attachments?.map((attachment) => ({
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        cid: attachment.cid,
        contentDisposition: attachment.inline ? "inline" : "attachment",
      })),
      inReplyTo: input.inReplyTo,
      references: input.references,
      keepBcc: true,
    });
    return Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message, "utf8");
  } finally {
    transport.close();
  }
}

/** A multipart/related upload body: JSON metadata, then the message. */
export function uploadBody(
  boundary: string,
  metadata: unknown,
  raw: Buffer
): Uint8Array<ArrayBuffer> {
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`
    ),
    raw,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Uint8Array(body);
}

function bodyHtml(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? html;
}

function textAsHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

interface SendAs {
  sendAsEmail: string;
  displayName?: string;
  isDefault?: boolean;
  isPrimary?: boolean;
  verificationStatus?: string;
}

/** A sender as `"Name" <address>`, or just the address. */
function formatSender(sendAs: SendAs): string {
  const name = sendAs.displayName?.replace(/["\\]/g, "").trim();
  return name ? `"${name}" <${sendAs.sendAsEmail}>` : sendAs.sendAsEmail;
}

interface ReplyContext {
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
  /** Plain-text body with the quoted original appended. */
  text: (body: string) => string;
  /** HTML body with the quoted original appended. */
  html: (htmlBody: string) => string;
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class Gmail {
  private readonly sendAsCache = new Map<string, { at: number; list: SendAs[] }>();

  constructor(private readonly accounts: GoogleAccounts) {}

  private get(account: string, path: string, query: Record<string, unknown> = {}): Promise<any> {
    const url = new URL(`${API}/${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(item));
    }
    return this.accounts.request(account, url.toString());
  }

  private call(account: string, method: string, path: string, body?: unknown): Promise<any> {
    return this.accounts.request(account, `${API}/${path}`, { method, body: body ?? {} });
  }

  private async upload(
    account: string,
    method: "POST" | "PUT",
    path: string,
    metadata: unknown,
    raw: Buffer
  ): Promise<any> {
    const boundary = `part_${crypto.randomUUID()}`;
    return this.accounts.request(account, `${UPLOAD}/${path}?uploadType=multipart`, {
      method,
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      raw: uploadBody(boundary, metadata, raw),
    });
  }

  /** Verified send-as addresses, cached for ten minutes. */
  async sendAs(account: string): Promise<SendAs[]> {
    const cached = this.sendAsCache.get(account);
    if (cached && Date.now() - cached.at < SEND_AS_TTL_MS) return cached.list;
    let list: SendAs[];
    try {
      const data = await this.get(account, "settings/sendAs");
      list = ((data.sendAs ?? []) as SendAs[]).filter(
        (item) => item.isPrimary || item.verificationStatus === "accepted"
      );
    } catch {
      list = [];
    }
    if (!list.some((item) => same(item.sendAsEmail, account))) {
      list.push({
        sendAsEmail: account,
        isPrimary: true,
        isDefault: !list.some((i) => i.isDefault),
      });
    }
    this.sendAsCache.set(account, { at: Date.now(), list });
    return list;
  }

  private async defaultSender(account: string): Promise<string> {
    const list = await this.sendAs(account);
    return formatSender(list.find((item) => item.isDefault) ?? list[0]);
  }

  async searchThreads(
    account: string,
    args: {
      query?: string;
      pageSize?: number;
      pageToken?: string;
      includeTrash?: boolean;
      view?: string;
    }
  ) {
    let query = args.query?.trim() ?? "";
    // Drafts are left out unless asked for, as in Gmail's own connector.
    if (!/\bin:(draft|drafts|anywhere)\b/i.test(query)) query = `${query} -in:draft`.trim();
    const list = await this.get(account, "threads", {
      q: query,
      maxResults: args.pageSize ?? 20,
      pageToken: args.pageToken,
      includeSpamTrash: args.includeTrash || undefined,
    });
    const ids: string[] = (list.threads ?? []).map((thread: { id: string }) => thread.id);
    const format: MessageFormat =
      args.view === "THREAD_VIEW_METADATA_ONLY" ? "METADATA_ONLY" : "MINIMAL";
    const headers = SUMMARY_HEADERS.map((name) => `metadataHeaders=${name}`).join("&");
    const responses = await this.accounts.batch(
      account,
      BATCH,
      ids.map((id) => ({
        method: "GET" as const,
        path: `/gmail/v1/users/me/threads/${id}?format=metadata&${headers}`,
      }))
    );
    return {
      account,
      threads: responses.map((response, index) =>
        response.status === 200
          ? this.threadView(account, response.body, format)
          : { id: ids[index], error: response.body?.error?.message ?? `HTTP ${response.status}` }
      ),
      nextPageToken: list.nextPageToken ?? null,
      resultSizeEstimate: list.resultSizeEstimate ?? ids.length,
    };
  }

  private threadView(
    account: string,
    thread: { id: string; messages?: GmailMessage[] },
    format: MessageFormat,
    maxBodyChars?: number
  ) {
    return {
      id: thread.id,
      viewUrl: messageUrl(account, thread.id),
      messages: (thread.messages ?? [])
        .filter((message) => !message.labelIds?.includes("DRAFT"))
        .map((message) => messageView(account, message, format, maxBodyChars)),
    };
  }

  async getThread(account: string, threadId: string, format: MessageFormat, maxBodyChars?: number) {
    if (format === "RAW")
      throw new Error("RAW is not supported for threads; use gmail_get_message.");
    const metadata = format === "MINIMAL" || format === "METADATA_ONLY";
    const thread = await this.get(account, `threads/${encodeURIComponent(threadId)}`, {
      format: metadata ? "metadata" : "full",
      metadataHeaders: metadata ? SUMMARY_HEADERS : undefined,
    });
    return { account, ...this.threadView(account, thread, format, maxBodyChars) };
  }

  private fetchMessage(
    account: string,
    messageId: string,
    format: MessageFormat
  ): Promise<GmailMessage> {
    const metadata = format === "MINIMAL" || format === "METADATA_ONLY";
    return this.get(account, `messages/${encodeURIComponent(messageId)}`, {
      format: format === "RAW" ? "raw" : metadata ? "metadata" : "full",
      metadataHeaders: metadata ? SUMMARY_HEADERS : undefined,
    });
  }

  async getMessage(
    account: string,
    messageId: string,
    format: MessageFormat,
    maxBodyChars?: number
  ) {
    const message = await this.fetchMessage(account, messageId, format);
    if (message.labelIds?.includes("DRAFT")) {
      throw new Error("This is a draft; use gmail_get_draft or gmail_list_drafts.");
    }
    return { account, ...messageView(account, message, format, maxBodyChars) };
  }

  async getAttachment(account: string, messageId: string, attachmentId: string) {
    const data = await this.get(
      account,
      `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
    );
    const bytes = Buffer.from(data.data ?? "", "base64url");
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 20 MiB.");
    return {
      account,
      messageId,
      attachmentId,
      size: bytes.length,
      contentBase64: bytes.toString("base64"),
    };
  }

  private draftView(
    account: string,
    draft: { id: string; message: GmailMessage },
    format: MessageFormat,
    maxBodyChars?: number
  ): Record<string, unknown> {
    return {
      ...messageView(account, draft.message, format, maxBodyChars),
      id: draft.id,
      messageId: draft.message.id,
      viewUrl: draftUrl(account, draft.message.id),
    };
  }

  async listDrafts(
    account: string,
    args: { query?: string; pageSize?: number; pageToken?: string; view?: string }
  ) {
    const list = await this.get(account, "drafts", {
      q: args.query,
      maxResults: args.pageSize ?? 20,
      pageToken: args.pageToken,
    });
    const ids: string[] = (list.drafts ?? []).map((draft: { id: string }) => draft.id);
    const full = args.view === "DRAFT_VIEW_FULL";
    const headers = SUMMARY_HEADERS.map((name) => `metadataHeaders=${name}`).join("&");
    const responses = await this.accounts.batch(
      account,
      BATCH,
      ids.map((id) => ({
        method: "GET" as const,
        path: `/gmail/v1/users/me/drafts/${id}?format=${full ? "full" : `metadata&${headers}`}`,
      }))
    );
    return {
      account,
      drafts: responses.map((response, index) => {
        if (response.status !== 200) {
          return {
            id: ids[index],
            error: response.body?.error?.message ?? `HTTP ${response.status}`,
          };
        }
        const view = this.draftView(
          account,
          response.body,
          full ? "PLAIN_TEXT" : "METADATA_ONLY",
          5000
        );
        if (full) delete view.attachments;
        return view;
      }),
      nextPageToken: list.nextPageToken ?? null,
    };
  }

  async getDraft(account: string, draftId: string, format: MessageFormat, maxBodyChars?: number) {
    const metadata = format === "MINIMAL" || format === "METADATA_ONLY";
    const draft = await this.get(account, `drafts/${encodeURIComponent(draftId)}`, {
      format: format === "RAW" ? "raw" : metadata ? "metadata" : "full",
    });
    if (format === "RAW") {
      return {
        account,
        id: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        viewUrl: draftUrl(account, draft.message.id),
        raw: Buffer.from(draft.message.raw ?? "", "base64url").toString("utf8"),
      };
    }
    return { account, ...this.draftView(account, draft, format, maxBodyChars) };
  }

  /** Recipients, threading headers and quoting for a reply to `messageId`. */
  private async replyContext(
    account: string,
    messageId: string,
    options: { replyAll?: boolean; quote: boolean }
  ): Promise<ReplyContext> {
    const original = await this.fetchMessage(account, messageId, "FULL_CONTENT");
    const headers = original.payload?.headers ?? [];
    const block = `${headers.map((item) => `${item.name}: ${item.value}`).join("\r\n")}\r\n\r\n`;
    const parsed = parseOriginalHeaders(block);
    parsed.subject = header(headers, "Subject") ?? parsed.subject;
    const sendAs = await this.sendAs(account);
    const self = sendAs.map((item) => item.sendAsEmail);
    const isSelf = (address: string) => self.some((item) => same(item, address));
    const { text, html } = collectParts(original.payload);
    const originalText = text.length ? text.join("\n") : htmlToText(html.join("\n"));
    const reply = buildReplyOptions({
      original: parsed,
      originalPlainText: options.quote ? originalText : "",
      body: "",
      replyAll: options.replyAll ?? false,
      self,
    });
    let to = reply.to;
    let cc = reply.cc;
    const ownMessage = to.every(isSelf) && parsed.to.some((address) => !isSelf(address));
    if (ownMessage) {
      // Replying to our own message goes to its recipients, as in Gmail.
      to = parsed.to.filter((address) => !isSelf(address));
      cc = cc?.filter((address) => !to.some((item) => same(item, address)));
      if (!cc?.length) cc = undefined;
    }
    // Answer from the address we sent it from, or the one it was sent to, when it is ours.
    const candidates = ownMessage
      ? parsed.from
      : [...parsed.to, ...parsed.cc, ...(header(headers, "Delivered-To") ?? "").split(",")];
    const received = candidates.map((address) => address.trim()).filter(Boolean);
    const alias = sendAs.find((item) =>
      received.some((address) => same(address, item.sendAsEmail))
    );
    const from = alias ? formatSender(alias) : await this.defaultSender(account);
    const quotedText = reply.body;
    const attribution = `On ${parsed.date ?? "an earlier date"}, ${header(headers, "From") ?? parsed.from[0] ?? "the sender"} wrote:`;
    const originalHtml = html.length ? bodyHtml(html.join("\n")) : textAsHtml(originalText);
    return {
      threadId: original.threadId,
      from,
      to,
      cc,
      subject: withSubjectPrefix(parsed.subject, "Re:"),
      inReplyTo: reply.inReplyTo,
      references: reply.references,
      text: (body) => `${body}${quotedText}`,
      html: (htmlBody) =>
        options.quote
          ? `${htmlBody}<br><div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attribution)}</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${originalHtml}</blockquote></div>`
          : htmlBody,
    };
  }

  async createDraft(account: string, args: ComposeFields & { replyToMessageId?: string }) {
    const attachments = attachmentsFromInput(args.attachments);
    let input: ComposeInput;
    let threadId: string | undefined;
    if (args.replyToMessageId) {
      const reply = await this.replyContext(account, args.replyToMessageId, { quote: true });
      threadId = reply.threadId;
      input = {
        from: reply.from,
        to: args.to?.length ? args.to : reply.to,
        cc: args.cc?.length ? args.cc : reply.cc,
        bcc: args.bcc,
        subject: args.subject || reply.subject,
        text: reply.text(args.body ?? (args.htmlBody ? htmlToText(args.htmlBody) : "")),
        html: args.htmlBody ? reply.html(args.htmlBody) : undefined,
        attachments,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      };
    } else {
      input = {
        from: await this.defaultSender(account),
        to: args.to ?? [],
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject ?? "",
        text: args.body,
        html: args.htmlBody,
        attachments,
      };
    }
    const draft = await this.upload(
      account,
      "POST",
      "drafts",
      { message: threadId ? { threadId } : {} },
      await composeMime(input)
    );
    return this.draftResult(account, draft);
  }

  private draftResult(account: string, draft: { id: string; message: GmailMessage }) {
    return {
      account,
      id: draft.id,
      messageId: draft.message?.id,
      threadId: draft.message?.threadId,
      viewUrl: draftUrl(account, draft.message?.id),
    };
  }

  /**
   * Merge an update into a draft. Unlike Gmail's connector, existing
   * attachments are kept unless `attachments` is given (an empty list removes them).
   */
  async updateDraft(account: string, draftId: string, args: ComposeFields) {
    const draft = await this.get(account, `drafts/${encodeURIComponent(draftId)}`, {
      format: "raw",
    });
    const current = parseDraftMime(Buffer.from(draft.message.raw ?? "", "base64url"));
    const pick = (next: string[] | undefined, existing: string[]) =>
      next?.length ? next : existing;
    let text: string | undefined = current.body;
    let html: string | undefined = current.htmlBody;
    if (args.body || args.htmlBody) {
      // If only one is given, the other follows it so the two stay in sync.
      html = args.htmlBody || undefined;
      text = args.body || (args.htmlBody ? htmlToText(args.htmlBody) : "");
    }
    const raw = await composeMime({
      from: current.from || (await this.defaultSender(account)),
      to: pick(args.to, current.to),
      cc: pick(args.cc, current.cc),
      bcc: pick(args.bcc, current.bcc),
      subject: args.subject || current.subject,
      text,
      html,
      attachments:
        args.attachments !== undefined
          ? attachmentsFromInput(args.attachments)
          : current.attachments.map((item) => ({
              filename: item.filename,
              content: item.content,
              contentType: item.contentType,
            })),
      inReplyTo: current.inReplyTo,
      references: current.references,
    });
    const updated = await this.upload(
      account,
      "PUT",
      `drafts/${encodeURIComponent(draftId)}`,
      { id: draftId, message: { threadId: draft.message.threadId } },
      raw
    );
    return this.draftResult(account, updated);
  }

  async deleteDraft(account: string, draftId: string) {
    await this.accounts.request(account, `${API}/drafts/${encodeURIComponent(draftId)}`, {
      method: "DELETE",
    });
    return { account, success: true, draftId };
  }

  private sent(account: string, message: GmailMessage) {
    return {
      account,
      id: message.id,
      threadId: message.threadId,
      labelIds: message.labelIds ?? [],
      viewUrl: messageUrl(account, message.id),
    };
  }

  async sendMessage(
    account: string,
    args: ComposeFields & { draftId?: string; replyThreadId?: string; replyToMessageId?: string }
  ) {
    if (args.draftId) {
      return this.sent(
        account,
        await this.call(account, "POST", "drafts/send", { id: args.draftId })
      );
    }
    if (!args.to?.length && !args.cc?.length && !args.bcc?.length) {
      throw new Error("Give at least one recipient, or a draftId to send.");
    }
    let threadId = args.replyThreadId;
    let replyTo = args.replyToMessageId;
    if (!replyTo && threadId) {
      // Reply to the thread's latest message so other mail clients thread it too.
      const thread = await this.get(account, `threads/${encodeURIComponent(threadId)}`, {
        format: "minimal",
      });
      const messages = (thread.messages ?? []).filter(
        (message: GmailMessage) => !message.labelIds?.includes("DRAFT")
      );
      replyTo = messages.at(-1)?.id;
    }
    let input: ComposeInput = {
      from: await this.defaultSender(account),
      to: args.to ?? [],
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject ?? "",
      text: args.body,
      html: args.htmlBody,
      attachments: attachmentsFromInput(args.attachments),
    };
    if (replyTo) {
      const reply = await this.replyContext(account, replyTo, { quote: false });
      threadId = reply.threadId;
      input = {
        ...input,
        from: reply.from,
        subject: args.subject || reply.subject,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      };
    }
    const message = await this.upload(
      account,
      "POST",
      "messages/send",
      threadId ? { threadId } : {},
      await composeMime(input)
    );
    return this.sent(account, message);
  }

  async reply(
    account: string,
    args: {
      messageId: string;
      body?: string;
      htmlBody?: string;
      replyAll?: boolean;
      to?: string[];
      cc?: string[];
      bcc?: string[];
    }
  ) {
    if (!args.body && !args.htmlBody) throw new Error("Give body or htmlBody.");
    const reply = await this.replyContext(account, args.messageId, {
      replyAll: args.replyAll,
      quote: true,
    });
    const to = args.to?.length ? args.to : reply.to;
    if (!to.length) throw new Error("The original message has no address to reply to; give to.");
    const raw = await composeMime({
      from: reply.from,
      to,
      cc: args.cc?.length ? args.cc : reply.cc,
      bcc: args.bcc,
      subject: reply.subject,
      text: reply.text(args.body ?? htmlToText(args.htmlBody ?? "")),
      html: args.htmlBody ? reply.html(args.htmlBody) : undefined,
      inReplyTo: reply.inReplyTo,
      references: reply.references,
    });
    return this.sent(
      account,
      await this.upload(account, "POST", "messages/send", { threadId: reply.threadId }, raw)
    );
  }

  async forward(
    account: string,
    args: {
      messageId: string;
      to?: string[];
      cc?: string[];
      bcc?: string[];
      forwardText?: string;
      htmlBody?: string;
    }
  ) {
    if (!args.to?.length && !args.cc?.length && !args.bcc?.length) {
      throw new Error("Give at least one recipient to forward to.");
    }
    const original = await this.fetchMessage(account, args.messageId, "FULL_CONTENT");
    const headers = original.payload?.headers;
    const { text, html, attachments } = collectParts(original.payload);
    const fields: Array<[string, string | undefined]> = [
      ["From", header(headers, "From")],
      ["Date", header(headers, "Date")],
      ["Subject", header(headers, "Subject")],
      ["To", header(headers, "To")],
      ["Cc", header(headers, "Cc")],
    ];
    const present = fields.filter((field): field is [string, string] => Boolean(field[1]));
    const intro = "---------- Forwarded message ---------";
    const originalText = text.length ? text.join("\n") : htmlToText(html.join("\n"));
    const plain =
      `${args.forwardText ?? (args.htmlBody ? htmlToText(args.htmlBody) : "")}\n\n${intro}\n${present
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")}\n\n${originalText}`.trimStart();
    const comment = args.htmlBody ?? (args.forwardText ? textAsHtml(args.forwardText) : "");
    const htmlBody = `${comment}<br><br><div class="gmail_quote"><div class="gmail_attr">${intro}<br>${present
      .map(([name, value]) => `${name}: ${escapeHtml(value)}`)
      .join(
        "<br>"
      )}</div><br>${html.length ? bodyHtml(html.join("\n")) : textAsHtml(originalText)}</div>`;
    const files = await this.originalAttachments(account, original.id, attachments);
    const raw = await composeMime({
      from: await this.defaultSender(account),
      to: args.to ?? [],
      cc: args.cc,
      bcc: args.bcc,
      subject: withSubjectPrefix(header(headers, "Subject") ?? "", "Fwd:"),
      text: plain,
      html: htmlBody,
      attachments: files,
    });
    return this.sent(account, await this.upload(account, "POST", "messages/send", {}, raw));
  }

  /** The original's attachments, fetched in one batch, for forwarding. */
  private async originalAttachments(account: string, messageId: string, parts: CollectedPart[]) {
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    if (total > MAX_INLINE_ATTACHMENT_BYTES) {
      throw new Error("The original's attachments exceed Gmail's 25 MB limit.");
    }
    const remote = parts.filter((part) => part.attachmentId && !part.data);
    const responses = await this.accounts.batch(
      account,
      BATCH,
      remote.map((part) => ({
        method: "GET" as const,
        path: `/gmail/v1/users/me/messages/${messageId}/attachments/${part.attachmentId}`,
      }))
    );
    return parts.map((part): MimeAttachment => {
      const index = remote.indexOf(part);
      const data = index < 0 ? part.data : responses[index].body?.data;
      if (index >= 0 && responses[index].status !== 200) {
        throw new Error(`Could not fetch attachment "${part.filename}" to forward.`);
      }
      return {
        filename: part.filename,
        content: Buffer.from(data ?? "", "base64url"),
        contentType: part.mimeType,
        inline: part.inline,
        cid: part.inline ? part.contentId : undefined,
      };
    });
  }

  async listLabels(account: string) {
    const data = await this.get(account, "labels");
    return {
      account,
      labels: (data.labels ?? []).map((label: any) => ({
        id: label.id,
        name: label.name,
        type: label.type,
        labelListVisibility: label.labelListVisibility,
        messageListVisibility: label.messageListVisibility,
        color: label.color,
      })),
    };
  }

  private labelBody(args: {
    displayName?: string;
    colorPreset?: string;
    labelListVisibility?: string;
    messageListVisibility?: string;
  }) {
    const color = args.colorPreset ? LABEL_COLOR_PRESETS[args.colorPreset] : undefined;
    const list = args.labelListVisibility
      ? LABEL_LIST_VISIBILITY[args.labelListVisibility]
      : undefined;
    const messages = args.messageListVisibility
      ? MESSAGE_LIST_VISIBILITY[args.messageListVisibility]
      : undefined;
    return {
      ...(args.displayName && { name: args.displayName }),
      ...(color && { color }),
      ...(list && { labelListVisibility: list }),
      ...(messages && { messageListVisibility: messages }),
    };
  }

  async createLabel(
    account: string,
    args: {
      displayName: string;
      autoCreateParentLabels?: boolean;
      colorPreset?: string;
      labelListVisibility?: string;
      messageListVisibility?: string;
    }
  ) {
    const segments = args.displayName.split("/").map((segment) => segment.trim());
    if (segments.some((segment) => !segment))
      throw new Error("Label names cannot have empty segments.");
    const createdParents: string[] = [];
    if (segments.length > 1 && args.autoCreateParentLabels !== false) {
      const existing = new Set(
        ((await this.get(account, "labels")).labels ?? []).map((label: any) =>
          String(label.name).toLowerCase()
        )
      );
      for (let depth = 1; depth < segments.length; depth += 1) {
        const name = segments.slice(0, depth).join("/");
        if (existing.has(name.toLowerCase())) continue;
        await this.call(account, "POST", "labels", { name });
        createdParents.push(name);
      }
    }
    const label = await this.call(account, "POST", "labels", {
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
      ...this.labelBody({ ...args, displayName: segments.join("/") }),
    });
    return { account, label, createdParents };
  }

  async updateLabel(
    account: string,
    args: {
      labelId: string;
      displayName?: string;
      colorPreset?: string;
      labelListVisibility?: string;
      messageListVisibility?: string;
    }
  ) {
    const body = this.labelBody(args);
    if (!Object.keys(body).length) throw new Error("Give a new name, color or visibility.");
    const label = await this.call(
      account,
      "PATCH",
      `labels/${encodeURIComponent(args.labelId)}`,
      body
    );
    return { account, label };
  }

  async deleteLabel(account: string, labelId: string) {
    await this.accounts.request(account, `${API}/labels/${encodeURIComponent(labelId)}`, {
      method: "DELETE",
    });
    return { account, success: true, labelId };
  }

  async modify(
    account: string,
    kind: "messages" | "threads",
    id: string,
    add: string[] = [],
    remove: string[] = []
  ) {
    if (!add.length && !remove.length) throw new Error("Give labels to add or remove.");
    const result = await this.call(account, "POST", `${kind}/${encodeURIComponent(id)}/modify`, {
      addLabelIds: add,
      removeLabelIds: remove,
    });
    return this.modified(account, kind, result);
  }

  async trash(account: string, kind: "messages" | "threads", id: string, restore = false) {
    const result = await this.call(
      account,
      "POST",
      `${kind}/${encodeURIComponent(id)}/${restore ? "untrash" : "trash"}`
    );
    return this.modified(
      account,
      kind,
      restore ? await this.backToInbox(account, kind, result) : result
    );
  }

  /** Mark as not spam: out of Spam, and received mail back in the inbox. */
  async notSpam(account: string, kind: "messages" | "threads", id: string) {
    const result = await this.call(account, "POST", `${kind}/${encodeURIComponent(id)}/modify`, {
      removeLabelIds: ["SPAM"],
    });
    return this.modified(account, kind, await this.backToInbox(account, kind, result));
  }

  /**
   * Return received messages to the inbox, as Gmail's "Not spam" and "Move to
   * Inbox" do. Our own sent messages and drafts never belong there.
   */
  private async backToInbox(account: string, kind: "messages" | "threads", result: any) {
    const messages: GmailMessage[] = kind === "threads" ? (result.messages ?? []) : [result];
    const received = messages.filter(
      (message) =>
        !message.labelIds?.some((label) =>
          ["SENT", "DRAFT", "TRASH", "SPAM", "INBOX"].includes(label)
        )
    );
    if (!received.length) return result;
    await this.call(account, "POST", "messages/batchModify", {
      ids: received.map((message) => message.id),
      addLabelIds: ["INBOX"],
    });
    for (const message of received) message.labelIds = [...(message.labelIds ?? []), "INBOX"];
    return result;
  }

  private modified(account: string, kind: "messages" | "threads", result: any) {
    if (kind === "threads") {
      return {
        account,
        threadId: result.id,
        messages: (result.messages ?? []).map((message: GmailMessage) => ({
          id: message.id,
          labelIds: message.labelIds ?? [],
        })),
      };
    }
    return { account, id: result.id, threadId: result.threadId, labelIds: result.labelIds ?? [] };
  }
}
