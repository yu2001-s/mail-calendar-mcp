/**
 * Pure helpers that turn an existing message (its raw RFC 5322 source plus the
 * decoded plain-text body) into {@link SmtpSendOptions} for a threaded reply,
 * with correct `In-Reply-To`/`References` headers. Kept separate so the
 * addressing, subject-prefix and quoting rules are unit-testable without a
 * mail server.
 */
import { decodeHeaderWord } from "@/services/mimeDraft.js";
import type { SmtpSendOptions } from "@/services/smtpMailer.js";

/** The subset of an original message's headers we need to reply/forward. */
export interface OriginalHeaders {
  /** Raw `Message-ID` including angle brackets, e.g. `<abc@host>`. */
  messageId?: string;
  /** Thread chain: every `<id>` from `References` + `In-Reply-To`, in order. */
  references: string[];
  /** `From` address(es), bare (no display name). */
  from: string[];
  /** The first sender's display name, decoded, when it has one. */
  fromName?: string;
  /** `Reply-To` address(es), bare. Preferred over {@link from} for replies. */
  replyTo: string[];
  /** `To` address(es), bare. */
  to: string[];
  /** `Cc` address(es), bare. */
  cc: string[];
  /** `Bcc` address(es), bare. Usually available only on sent/draft mail. */
  bcc: string[];
  /** `Subject`, unfolded and trimmed (no `Re:`/`Fwd:` normalization). */
  subject: string;
  /** `Date` header verbatim, for the reply attribution line. */
  date?: string;
}

/**
 * Pull bare email addresses out of a header value such as
 * `"Alice <a@x.com>, bob@y.com"` → `["a@x.com", "bob@y.com"]`. Splits on commas
 * (address lists are comma-separated) and unwraps `<...>` when present. Anything
 * without an `@` is dropped, so group syntax / junk is ignored.
 */
export function extractAddresses(headerValue: string): string[] {
  if (!headerValue.trim()) return [];
  return headerValue
    .split(",")
    .map((part) => {
      const angle = part.match(/<([^>]+)>/);
      return (angle ? angle[1] : part).trim();
    })
    .filter((addr) => addr.includes("@"));
}

/** The decoded display name of the first mailbox in `Name <addr>, ...`, if any. */
export function firstDisplayName(headerValue: string): string | undefined {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^<,"]*?))\s*<([^<>\s]+)>/.exec(headerValue);
  if (!match) return undefined;
  const name = decodeHeaderWord((match[1] ?? match[2] ?? "").replace(/\\(.)/g, "$1")).trim();
  return name && name.toLowerCase() !== match[3].toLowerCase() ? name : undefined;
}

/**
 * Parse the header block (everything before the first blank line) of a raw
 * message. Continuation lines (folded headers, leading WSP) are unfolded, and
 * header names are matched case-insensitively. Only the headers in
 * {@link OriginalHeaders} are extracted.
 */
export function parseOriginalHeaders(raw: string): OriginalHeaders {
  const headerBlock = raw.split(/\r?\n\r?\n/)[0] ?? "";

  // Unfold: any line starting with a space/tab continues the previous header.
  const lines: string[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += " " + line.trim();
    } else {
      lines.push(line);
    }
  }

  const get = (name: string): string | undefined => {
    const prefix = `${name.toLowerCase()}:`;
    const found = lines.find((l) => l.toLowerCase().startsWith(prefix));
    return found ? found.slice(found.indexOf(":") + 1).trim() : undefined;
  };

  const rawMessageId = get("Message-ID");
  const messageId = rawMessageId?.match(/<[^>]+>/)?.[0] ?? rawMessageId ?? undefined;
  const references =
    `${get("References") ?? ""} ${get("In-Reply-To") ?? ""}`.match(/<[^>]+>/g) ?? [];

  const fromName = firstDisplayName(get("From") ?? "");

  return {
    messageId,
    references,
    from: extractAddresses(get("From") ?? ""),
    ...(fromName && { fromName }),
    replyTo: extractAddresses(get("Reply-To") ?? ""),
    to: extractAddresses(get("To") ?? ""),
    cc: extractAddresses(get("Cc") ?? ""),
    bcc: extractAddresses(get("Bcc") ?? ""),
    subject: get("Subject") ?? "",
    date: get("Date"),
  };
}

/** Case-insensitive de-dupe that preserves first-seen order and casing. */
function dedupe(addrs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addrs) {
    const k = a.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(a);
    }
  }
  return out;
}

/**
 * Ensure `subject` carries `prefix` exactly once. Existing `Re:`/`Fwd:`/`Fw:`
 * prefixes (any case) are treated as already-present so we never stack them.
 */
export function withSubjectPrefix(subject: string, prefix: "Re:" | "Fwd:"): string {
  const s = subject.trim();
  const present = prefix === "Re:" ? /^re:/i : /^(fwd?|fw):/i;
  return present.test(s) ? s : `${prefix} ${s}`;
}

/** Prefix every line of the original body with `> ` for the quoted reply block. */
export function quoteBody(plainText: string): string {
  return plainText
    .replace(/\s+$/, "")
    .split(/\r?\n/)
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

/**
 * Build {@link SmtpSendOptions} for a threaded reply.
 *
 * - recipients: `Reply-To` if the original had one, else `From`; with
 *   `replyAll`, the original `To`+`Cc` (minus our own addresses and the primary
 *   recipients) become `Cc`.
 * - subject: `Re: ` prepended unless already present.
 * - threading: `In-Reply-To` = original `Message-ID`; `References` = original
 *   chain + that `Message-ID`.
 * - body: the new text, then an attribution line and the quoted original.
 */
export function buildReplyOptions(args: {
  original: OriginalHeaders;
  originalPlainText: string;
  body: string;
  replyAll: boolean;
  /** Our own addresses, excluded from a reply-all recipient set. */
  self: string[];
  /** From override (defaults to the SMTP identity at send time when omitted). */
  from?: string;
}): SmtpSendOptions {
  const { original, originalPlainText, body, replyAll, self, from } = args;
  const selfSet = new Set(self.filter(Boolean).map((s) => s.toLowerCase()));

  const to = dedupe((original.replyTo.length ? original.replyTo : original.from).filter(Boolean));
  const toSet = new Set(to.map((t) => t.toLowerCase()));

  let cc: string[] | undefined;
  if (replyAll) {
    const extra = dedupe(
      [...original.to, ...original.cc].filter(
        (a) => !selfSet.has(a.toLowerCase()) && !toSet.has(a.toLowerCase())
      )
    );
    cc = extra.length ? extra : undefined;
  }

  const attribution = buildAttribution(original);
  const quoted = originalPlainText.trim()
    ? `\n\n${attribution}${quoteBody(originalPlainText)}`
    : "";

  const references = dedupe(
    original.messageId ? [...original.references, original.messageId] : original.references
  );

  return {
    to,
    cc,
    subject: withSubjectPrefix(original.subject, "Re:"),
    body: `${body}${quoted}`,
    inReplyTo: original.messageId,
    references: references.length ? references : undefined,
    from,
  };
}

/**
 * "On <date>, <Name> <sender> wrote:\n", as mail clients write it; the name
 * when the sender has one, and no date clause when it is unknown.
 */
function buildAttribution(original: OriginalHeaders): string {
  const address = original.from[0];
  const who = address
    ? original.fromName
      ? `${original.fromName} <${address}>`
      : address
    : (original.replyTo[0] ?? "the sender");
  return original.date ? `On ${original.date}, ${who} wrote:\n` : `${who} wrote:\n`;
}
