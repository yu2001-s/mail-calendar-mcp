/**
 * Decode mail text in the charset its sender declared. Both Node and the
 * Workers runtime ship the full WHATWG Encoding set in TextDecoder (big5,
 * gb18030, shift_jis, euc-kr, iso-2022-jp, ...), so no lookup table is needed.
 */

/** The charset parameter of a Content-Type value, if it has one. */
export function contentTypeCharset(contentType: string | null | undefined): string | undefined {
  return /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "")?.[1];
}

/** Decode bytes in `charset`, falling back to UTF-8 when it is missing or unknown. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
