/**
 * Search fields and folder names every mail account understands, translated
 * to a Gmail query or to IMAP SEARCH criteria and mailbox paths.
 */

export interface MailQuery {
  /** Words anywhere in the message. Gmail also takes its own operators here. */
  text?: string;
  from?: string;
  to?: string;
  subject?: string;
  /** YYYY-MM-DD, inclusive. */
  since?: string;
  /** YYYY-MM-DD, exclusive. */
  before?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  /** A special folder or a folder or label name; default inbox. */
  folder?: string;
}

export const SPECIAL_FOLDERS = ["inbox", "sent", "drafts", "archive", "junk", "trash", "all"];
export type SpecialFolder = "inbox" | "sent" | "drafts" | "archive" | "junk" | "trash" | "all";

const ALIASES: Record<string, SpecialFolder> = {
  inbox: "inbox",
  sent: "sent",
  "sent mail": "sent",
  "sent messages": "sent",
  draft: "drafts",
  drafts: "drafts",
  archive: "archive",
  "all mail": "all",
  all: "all",
  junk: "junk",
  spam: "junk",
  trash: "trash",
  bin: "trash",
  "deleted messages": "trash",
};

export function specialFolder(name: string | undefined): SpecialFolder | undefined {
  return ALIASES[(name ?? "inbox").trim().toLowerCase()];
}

/** A value Gmail search reads as one term. */
function term(value: string): string {
  const clean = value.replace(/"/g, "").trim();
  return /[\s()]/.test(clean) ? `"${clean}"` : clean;
}

const GMAIL_FOLDERS: Record<SpecialFolder, string> = {
  inbox: "in:inbox",
  sent: "in:sent",
  drafts: "in:drafts",
  archive: "-in:inbox -in:sent -in:drafts",
  junk: "in:spam",
  trash: "in:trash",
  all: "",
};

export function gmailQuery(query: MailQuery): string {
  const special = specialFolder(query.folder);
  const parts = [
    special
      ? GMAIL_FOLDERS[special]
      : // Gmail searches labels with dashes for spaces and slashes.
        `label:${term(query.folder!.trim().replace(/[\s/]+/g, "-"))}`,
  ];
  if (query.from) parts.push(`from:${term(query.from)}`);
  if (query.to) parts.push(`to:${term(query.to)}`);
  if (query.subject) parts.push(`subject:${term(query.subject)}`);
  if (query.since) parts.push(`after:${query.since.replace(/-/g, "/")}`);
  if (query.before) parts.push(`before:${query.before.replace(/-/g, "/")}`);
  if (query.unread !== undefined) parts.push(query.unread ? "is:unread" : "-is:unread");
  if (query.flagged !== undefined) parts.push(query.flagged ? "is:starred" : "-is:starred");
  if (query.hasAttachment) parts.push("has:attachment");
  if (query.text) parts.push(query.text.trim());
  return parts.filter(Boolean).join(" ");
}

export function imapCriteria(query: MailQuery): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};
  if (query.text) criteria.text = query.text;
  if (query.from) criteria.from = query.from;
  if (query.to) criteria.to = query.to;
  if (query.subject) criteria.subject = query.subject;
  if (query.since) criteria.since = query.since;
  if (query.before) criteria.before = query.before;
  if (query.unread !== undefined) criteria.seen = !query.unread;
  if (query.flagged !== undefined) criteria.flagged = query.flagged;
  // IMAP cannot search for attachments; mail with them is multipart/mixed.
  if (query.hasAttachment) criteria.header = { "content-type": "multipart/mixed" };
  if (!Object.keys(criteria).length) criteria.all = true;
  return criteria;
}

export interface Mailbox {
  path: string;
  name: string;
  specialUse?: string;
  flags?: Set<string>;
}

const SPECIAL_USE: Partial<Record<SpecialFolder, string>> = {
  sent: "\\Sent",
  drafts: "\\Drafts",
  archive: "\\Archive",
  junk: "\\Junk",
  trash: "\\Trash",
};

/** The special folder an IMAP mailbox is, if any. */
export function mailboxSpecial(box: Mailbox): SpecialFolder | undefined {
  if (box.path.toUpperCase() === "INBOX") return "inbox";
  const special = (Object.keys(SPECIAL_USE) as SpecialFolder[]).find(
    (name) => SPECIAL_USE[name]!.toLowerCase() === box.specialUse?.toLowerCase()
  );
  return special ?? ALIASES[box.name.toLowerCase()];
}

/**
 * The mailbox paths a folder name means on an IMAP account: one, or for
 * "all" every mailbox except Drafts, Junk and Trash.
 */
export function imapFolderPaths(boxes: Mailbox[], folder: string | undefined): string[] {
  const special = specialFolder(folder);
  const selectable = boxes.filter((box) => !box.flags?.has("\\Noselect"));
  if (special === "all") {
    return selectable
      .filter((box) => !["drafts", "junk", "trash"].includes(mailboxSpecial(box) ?? ""))
      .map((box) => box.path);
  }
  const wanted = (folder ?? "inbox").trim().toLowerCase();
  const found =
    (special && selectable.find((box) => mailboxSpecial(box) === special)) ||
    selectable.find((box) => box.path.toLowerCase() === wanted) ||
    selectable.find((box) => box.name.toLowerCase() === wanted);
  if (!found) {
    throw new Error(
      `No folder "${folder}". Folders: ${selectable.map((box) => box.path).join(", ")}.`
    );
  }
  return [found.path];
}
