/**
 * The quoted original below a reply, or the forwarded message below a
 * forward's comments. Editing a draft's body replaces only the new text above
 * it, as a mail client's compose window does.
 */
import { escapeHtml } from "../utils/escapeHtml.js";
import { htmlToText } from "../utils/htmlText.js";

export const FORWARD_INTRO = "---------- Forwarded message ---------";

/** An attribution line over `>` lines, or a forwarded-message rule. */
const TEXT_QUOTE =
  /^[^\n]* wrote:[ \t]*\n(?:[ \t]*\n)?>|^-{5,} ?(?:Forwarded message|Original Message) ?-{5,}[ \t]*$/m;
/** Gmail's quote block, Apple Mail's cited blockquote, or a forwarded-message rule. */
const HTML_QUOTE =
  /<div\b[^>]*\bclass=["'][^"']*\bgmail_quote\b|<blockquote\b[^>]*\btype=["']?cite|<div>\s*-{5,} ?Forwarded message/i;

/** The quoted part of a plain-text body, from its attribution or rule on; "" when none. */
export function quotedText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const at = normalized.search(TEXT_QUOTE);
  return at < 0 ? "" : normalized.slice(at);
}

/** The quoted part of an HTML body; "" when none. */
export function quotedHtml(html: string | undefined): string {
  const at = html?.search(HTML_QUOTE) ?? -1;
  return at < 0 ? "" : html!.slice(at);
}

/**
 * The body and HTML body a draft edit saves: the new content, then the
 * current draft's quoted part unless `keepQuoted` is false. When only one of
 * body and htmlBody is new, the other follows it; a null htmlBody means the
 * draft has no HTML part, so a stale one is dropped.
 */
export function editedContent(
  current: { body: string; htmlBody?: string },
  next: { body?: string; htmlBody?: string },
  keepQuoted = true
): { body: string; htmlBody: string | null } {
  const textTail = keepQuoted ? quotedText(current.body) : "";
  const htmlTail = keepQuoted ? quotedHtml(current.htmlBody) : "";
  const text = next.body ?? (next.htmlBody ? htmlToText(next.htmlBody) : "");
  const body = textTail ? `${text.trimEnd()}\n\n${textTail}` : text;
  const html = next.htmlBody ?? (htmlTail ? escapeHtml(text).replace(/\n/g, "<br>") : undefined);
  return {
    body,
    htmlBody: html === undefined ? null : htmlTail ? `${html}<br><br>${htmlTail}` : html,
  };
}
