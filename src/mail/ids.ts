/**
 * Mail IDs name their account, so once a message is found every mail_* tool
 * reaches it without an account argument. iCloud keeps its own forms
 * (imap:…, apple-draft:…, and imap:…#<part> for attachments); Gmail IDs are
 * gmail:<kind>:<account>:<Gmail ID>.
 */
import { z } from "zod";

const GMAIL_KINDS = { message: "m", thread: "t", draft: "d", attachment: "a" } as const;
export type GmailKind = keyof typeof GMAIL_KINDS;

export function gmailId(kind: GmailKind, account: string, id: string): string {
  return `gmail:${GMAIL_KINDS[kind]}:${account}:${id}`;
}

export function parseGmailId(
  value: string
): { kind: GmailKind; account: string; id: string } | null {
  const match = /^gmail:([mtda]):([^:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const kind = (Object.keys(GMAIL_KINDS) as GmailKind[]).find(
    (name) => GMAIL_KINDS[name] === match[1]
  )!;
  return { kind, account: match[2], id: match[3] };
}

// Hosts such as ChatGPT require a pattern to match the whole value, so each
// one lists every form in full rather than a shared prefix.
const IMAP = "imap:[A-Za-z0-9_-]+";
const APPLE_DRAFT = "apple-draft:[A-Za-z0-9_-]+";
const GMAIL = (kinds: string) => `gmail:[${kinds}]:[^:\\s]+:[A-Za-z0-9_-]+`;

/** Each call builds a new schema, so none is emitted as a JSON Schema $ref. */
function idSchema(pattern: string, message: string) {
  return z.string().regex(new RegExp(`^(?:${pattern})$`), message);
}

export const messageId = () =>
  idSchema(`${IMAP}|${GMAIL("mt")}`, "Use a message or thread ID from mail_search or mail_read.");

export const readableId = () =>
  idSchema(
    `${IMAP}|${APPLE_DRAFT}|${GMAIL("mtd")}`,
    "Use a message, thread or draft ID returned by the mail_* tools."
  );

export const draftId = () =>
  idSchema(
    `${APPLE_DRAFT}|${IMAP}|${GMAIL("d")}`,
    "Use a draft ID from mail_create_draft or mail_list_drafts."
  );

export const attachmentId = () =>
  idSchema(
    `${IMAP}#[0-9.]+|gmail:a:[^:\\s]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+`,
    "Use an attachment ID from mail_read."
  );
