/**
 * MIME Source Parser for Attachment Extraction
 *
 * Parses raw email MIME source to extract attachment metadata and content.
 * Used as a fallback when AppleScript's `mail attachments` returns empty
 * (which happens across all account types: iCloud, Google, Exchange).
 *
 * @module utils/mimeParse
 */

import { contentTypeCharset, decodeCharset } from "./charset.js";

export interface MimeAttachmentInfo {
  /** Filename from Content-Disposition or Content-Type name parameter */
  name: string;
  /** MIME type from Content-Type header */
  mimeType: string;
  /** Size in bytes from Content-Disposition size parameter, or estimated from body */
  size: number;
}

export interface MimeAttachmentData extends MimeAttachmentInfo {
  /** Decoded binary content */
  data: Buffer;
}

interface MimePart {
  headers: string;
  body: string;
}

/**
 * Extract the boundary string from a Content-Type header value
 * (or from any string containing a boundary= parameter).
 */
function extractBoundary(source: string): string | null {
  const match = source.match(/boundary="?([^";\s\r\n]+)"?/i);
  return match ? match[1] : null;
}

/**
 * Extract a header value from a MIME part header block.
 * Handles folded headers (continuation lines starting with whitespace).
 */
export function getMimeHeader(headers: string, name: string): string | null {
  const regex = new RegExp(`^${name}:\\s*(.+(?:\\r?\\n[ \\t]+.+)*)`, "im");
  const match = headers.match(regex);
  if (!match) return null;
  // Unfold: replace newline+whitespace with single space
  return match[1].replace(/\r?\n[ \t]+/g, " ").trim();
}

/**
 * Extract filename from Content-Disposition or Content-Type headers.
 */
function extractFilename(headers: string): string | null {
  // Try Content-Disposition filename first
  const dispHeader = getMimeHeader(headers, "Content-Disposition");
  if (dispHeader) {
    const fnMatch = dispHeader.match(/filename="?([^";\r\n]+)"?/i);
    if (fnMatch) return fnMatch[1].trim();
  }
  // Fall back to Content-Type name parameter
  const ctHeader = getMimeHeader(headers, "Content-Type");
  if (ctHeader) {
    const nameMatch = ctHeader.match(/name="?([^";\r\n]+)"?/i);
    if (nameMatch) return nameMatch[1].trim();
  }
  return null;
}

/**
 * Check if a MIME part has inline disposition (not a real attachment).
 */
function isInlineDisposition(headers: string): boolean {
  const dispHeader = getMimeHeader(headers, "Content-Disposition");
  if (!dispHeader) return false;
  return dispHeader.toLowerCase().startsWith("inline");
}

/**
 * Extract size from Content-Disposition size parameter.
 */
function extractSize(headers: string): number {
  const dispHeader = getMimeHeader(headers, "Content-Disposition");
  if (dispHeader) {
    const sizeMatch = dispHeader.match(/size=(\d+)/i);
    if (sizeMatch) return parseInt(sizeMatch[1], 10);
  }
  return 0;
}

/**
 * Extract MIME type from Content-Type header.
 */
function extractMimeType(headers: string): string {
  const ctHeader = getMimeHeader(headers, "Content-Type");
  if (!ctHeader) return "application/octet-stream";
  const typeMatch = ctHeader.match(/^([^;\s]+)/);
  return typeMatch ? typeMatch[1].toLowerCase() : "application/octet-stream";
}

/**
 * Estimate decoded size from base64 content length.
 */
function estimateBase64Size(base64Body: string): number {
  const cleaned = base64Body.replace(/[\s\r\n]/g, "");
  return Math.floor((cleaned.length * 3) / 4);
}

/**
 * Split a MIME block into parts using the given boundary.
 * Does not recurse — call walkLeafParts for recursive traversal.
 */
function splitMimeParts(source: string, boundary: string): MimePart[] {
  const parts: MimePart[] = [];
  const boundaryDelim = `--${boundary}`;

  const sections = source.split(boundaryDelim);

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.startsWith("--")) continue;

    // Split headers from body at first blank line
    const blankLineIdx = trimmed.search(/\r?\n\r?\n/);
    if (blankLineIdx === -1) continue;

    const headers = trimmed.substring(0, blankLineIdx);
    const body = trimmed.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");

    parts.push({ headers, body });
  }

  return parts;
}

/**
 * Maximum nesting depth for multipart MIME traversal. Bounds recursion so a
 * pathologically (or maliciously) deeply nested multipart tree can't blow the
 * stack — past this depth we stop descending and treat the container as a leaf.
 * Real mail nests only a few levels (e.g. mixed → related → alternative).
 */
const MAX_MIME_DEPTH = 20;

/**
 * Walk a multipart MIME block and return all non-multipart leaf parts,
 * descending into nested multipart/* containers (alternative, related, mixed).
 *
 * Descent is bounded by MAX_MIME_DEPTH; once reached, deeper multipart
 * containers are returned as-is (as leaf parts) rather than recursed into,
 * yielding what's parsed so far instead of overflowing the stack.
 */
function walkLeafParts(source: string, boundary: string, depth = 0): MimePart[] {
  const result: MimePart[] = [];
  const parts = splitMimeParts(source, boundary);

  for (const part of parts) {
    const ct = getMimeHeader(part.headers, "Content-Type");
    if (ct && /^multipart\//i.test(ct) && depth < MAX_MIME_DEPTH) {
      const nestedBoundary = extractBoundary(ct);
      if (nestedBoundary) {
        result.push(...walkLeafParts(part.body, nestedBoundary, depth + 1));
        continue;
      }
    }
    result.push(part);
  }

  return result;
}

/**
 * Decode a MIME part body to bytes based on its transfer encoding.
 * Supports base64, quoted-printable, and 7bit/8bit/binary (raw).
 */
function decodeBody(body: string, encoding: string | null): Buffer {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") {
    return Buffer.from(body.replace(/[\s\r\n]/g, ""), "base64");
  }
  if (enc === "quoted-printable") {
    return decodeQuotedPrintable(body);
  }
  // 7bit, 8bit, binary, or unspecified — treat as raw bytes
  return Buffer.from(body, "binary");
}

/**
 * Decode quoted-printable-encoded body to bytes.
 * Handles soft line breaks (=<CRLF>) and =XX hex escapes per RFC 2045 §6.7.
 */
function decodeQuotedPrintable(body: string): Buffer {
  // Remove soft line breaks: `=` immediately followed by CRLF or LF
  const noSoft = body.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < noSoft.length; i++) {
    const c = noSoft[i];
    if (c === "=" && i + 2 < noSoft.length) {
      const hex = noSoft.substring(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(c.charCodeAt(0) & 0xff);
  }
  return Buffer.from(bytes);
}

/**
 * Estimate body size for metadata when Content-Disposition size is absent.
 */
function estimateSize(body: string, encoding: string | null): number {
  const enc = (encoding || "").toLowerCase().trim();
  if (enc === "base64") return estimateBase64Size(body);
  // For other encodings the body length is a reasonable proxy
  return body.length;
}

/**
 * Parse MIME source and return metadata for all file attachments.
 * Skips inline dispositions (signature images, etc.). Descends into
 * nested multipart/* containers.
 *
 * @param source - Raw MIME source of the email
 * @returns Array of attachment metadata (name, mimeType, size)
 */
export function parseMimeAttachments(source: string): MimeAttachmentInfo[] {
  if (!source || !source.trim()) return [];

  const boundary = extractBoundary(source);
  if (!boundary) return [];

  const parts = walkLeafParts(source, boundary);
  const attachments: MimeAttachmentInfo[] = [];

  for (const part of parts) {
    const filename = extractFilename(part.headers);
    if (!filename) continue;

    if (isInlineDisposition(part.headers)) continue;

    const encoding = getMimeHeader(part.headers, "Content-Transfer-Encoding");

    attachments.push({
      name: filename,
      mimeType: extractMimeType(part.headers),
      size: extractSize(part.headers) || estimateSize(part.body, encoding),
    });
  }

  return attachments;
}

/**
 * Decode every non-inline file attachment in source order.
 *
 * Unlike extractMimeAttachment(), this preserves duplicate filenames and is
 * therefore safe for a draft-edit round trip.
 */
export function parseMimeAttachmentData(source: string): MimeAttachmentData[] {
  if (!source || !source.trim()) return [];
  const boundary = extractBoundary(source);
  if (!boundary) return [];

  const attachments: MimeAttachmentData[] = [];
  for (const part of walkLeafParts(source, boundary)) {
    const name = extractFilename(part.headers);
    if (!name || isInlineDisposition(part.headers)) continue;
    const encoding = getMimeHeader(part.headers, "Content-Transfer-Encoding");
    const data = decodeBody(part.body, encoding);
    attachments.push({
      name,
      mimeType: extractMimeType(part.headers),
      size: data.length,
      data,
    });
  }
  return attachments;
}

/**
 * Raw MIME as fetched from the server, or text a caller already decoded from
 * it. A Buffer is read one char per byte (latin1), so an 8bit body keeps its
 * exact bytes until it is decoded in its own charset.
 */
export type MimeSource = Buffer | string;

/**
 * Decode a text part in its declared charset, or UTF-8 when it names none or
 * one the runtime doesn't know. A string source was already decoded, so its
 * 7bit/8bit parts have no bytes left to reinterpret and are returned as is.
 */
function decodeTextPart(headers: string, body: string, fromBytes: boolean): string {
  const encoding = getMimeHeader(headers, "Content-Transfer-Encoding");
  const enc = (encoding || "").toLowerCase().trim();
  if (!fromBytes && enc !== "base64" && enc !== "quoted-printable") return body;
  const charset = contentTypeCharset(getMimeHeader(headers, "Content-Type"));
  return decodeCharset(decodeBody(body, encoding), charset);
}

/**
 * Extract the decoded `text/html` body from raw MIME source.
 *
 * Used by get-message's `preferHtml` path so it returns the actual HTML body
 * rather than the entire raw MIME blob (headers + base64 attachments), which is
 * both wrong and enormous (#32). Handles both multipart messages (walks leaf
 * parts, descending into nested multipart/* containers) and a non-multipart
 * message whose top-level Content-Type is text/html. Bodies are decoded per
 * Content-Transfer-Encoding (base64 / quoted-printable / raw), then from the
 * part's declared charset (Big5, GB18030, Shift_JIS, ...; UTF-8 by default).
 *
 * @param source - Raw MIME source of the email; pass the fetched Buffer so
 *   8bit bodies can be decoded in their charset too
 * @returns The decoded HTML body, or null if the message has no text/html part
 */
export function extractHtmlBody(source: MimeSource): string | null {
  if (!source) return null;
  const fromBytes = typeof source !== "string";
  const text = fromBytes ? source.toString("latin1") : source;
  if (!text.trim()) return null;

  const boundary = extractBoundary(text);

  if (boundary) {
    for (const part of walkLeafParts(text, boundary)) {
      if (extractMimeType(part.headers) === "text/html") {
        return decodeTextPart(part.headers, part.body, fromBytes);
      }
    }
    return null;
  }

  // Non-multipart: split top headers from body and check the top Content-Type.
  const blankLineIdx = text.search(/\r?\n\r?\n/);
  if (blankLineIdx === -1) return null;
  const headers = text.substring(0, blankLineIdx);
  if (extractMimeType(headers) !== "text/html") return null;
  const body = text.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");
  return decodeTextPart(headers, body, fromBytes);
}

/**
 * Extract the decoded `text/plain` body from raw MIME source. Mirror of
 * extractHtmlBody; used by the IMAP get-message path (#43 Phase 3) to render a
 * message fetched by UID. Returns null when there's no text/plain part.
 */
export function extractTextBody(source: MimeSource): string | null {
  if (!source) return null;
  const fromBytes = typeof source !== "string";
  const text = fromBytes ? source.toString("latin1") : source;
  if (!text.trim()) return null;

  const boundary = extractBoundary(text);
  if (boundary) {
    for (const part of walkLeafParts(text, boundary)) {
      if (extractMimeType(part.headers) === "text/plain") {
        return decodeTextPart(part.headers, part.body, fromBytes);
      }
    }
    return null;
  }

  // Non-multipart: treat as text/plain unless the Content-Type says otherwise.
  const blankLineIdx = text.search(/\r?\n\r?\n/);
  if (blankLineIdx === -1) return null;
  const headers = text.substring(0, blankLineIdx);
  const ct = extractMimeType(headers);
  if (ct !== "text/plain" && getMimeHeader(headers, "Content-Type") !== null) return null;
  const body = text.substring(blankLineIdx).replace(/^\r?\n\r?\n/, "");
  return decodeTextPart(headers, body, fromBytes);
}

/**
 * Extract the RFC 5322 `Message-ID` header from raw MIME source, normalized to
 * bare form (surrounding angle brackets stripped). Only the header block (before
 * the first blank line) is scanned, so a `Message-ID:`-looking string inside the
 * body can't be mistaken for the header. Returns "" when absent — e.g. when
 * handed a subject+body blob that carries no headers, which is harmless.
 *
 * @param source - Raw MIME source (or any text) that may contain a header block
 * @returns The bare Message-ID, or "" if none is present
 */
export function extractRfcMessageIdFromSource(source: string): string {
  if (!source || !source.trim()) return "";
  const blankLineIdx = source.search(/\r?\n\r?\n/);
  const headers = blankLineIdx === -1 ? source : source.substring(0, blankLineIdx);
  const raw = getMimeHeader(headers, "Message-ID") ?? getMimeHeader(headers, "Message-Id");
  if (!raw) return "";
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Extract and decode a specific attachment from MIME source by filename.
 * Supports base64, quoted-printable, and 7bit/8bit/binary transfer encodings.
 * Descends into nested multipart/* containers.
 *
 * @param source - Raw MIME source of the email
 * @param attachmentName - Filename to extract
 * @returns Decoded attachment data, or null if not found
 */
export function extractMimeAttachment(
  source: string,
  attachmentName: string
): MimeAttachmentData | null {
  if (!source || !source.trim()) return null;

  const boundary = extractBoundary(source);
  if (!boundary) return null;

  const parts = walkLeafParts(source, boundary);

  for (const part of parts) {
    const filename = extractFilename(part.headers);
    if (filename !== attachmentName) continue;

    const encoding = getMimeHeader(part.headers, "Content-Transfer-Encoding");
    const data = decodeBody(part.body, encoding);

    return {
      name: filename,
      mimeType: extractMimeType(part.headers),
      size: extractSize(part.headers) || data.length,
      data,
    };
  }

  return null;
}
