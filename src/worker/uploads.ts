/**
 * /uploads/<id>: one-time upload URLs for attachments, stored in R2.
 *
 * create_attachment_upload signs a URL that names the upload, its file name
 * and an expiry; nothing is stored until the file arrives, so the PUT may
 * reach any data center. A conditional put makes each URL single use. The
 * Durable Object reads the file back when a draft attaches it and then leaves
 * an empty marker in its place, so the URL stays used until it expires; a
 * lifecycle rule (scripts/setup-worker.mjs) removes markers and leftovers.
 *
 * /downloads/<id> is the other way: mail_get_attachment keeps a copy of an
 * attachment and signs a GET link to it, valid for LINK_TTL_S.
 */
import type { DownloadLink, UploadedFile, Uploads, UploadTicket } from "../mcp/uploads.js";
import { UPLOAD_ID_PATTERN } from "../mcp/uploads.js";
import { MAX_INLINE_ATTACHMENT_BYTES } from "../utils/attachmentLimits.js";

/** The subset of the R2 bucket binding used here. */
export interface R2 {
  put(
    key: string,
    value: Uint8Array,
    options?: {
      onlyIf?: Headers;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<object | null>;
  get(key: string): Promise<{
    uploaded: Date;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
}

export interface UploadEnv {
  UPLOADS?: R2;
  CONNECTOR_SECRET_KEY?: string;
}

const LINK_TTL_S = 15 * 60;
/** How long an uploaded file stays attachable. */
const KEEP_MS = 24 * 60 * 60 * 1000;
const PREFIX = "uploads/";
const DOWNLOADS = "downloads/";
const DOWNLOAD_ID = /^dl_[A-Za-z0-9_-]{22}$/;
/** Custom metadata of the empty object left in place of an attached upload. */
const ATTACHED = { attached: "1" };

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString(
    "base64url"
  );
}

/** An HMAC key for upload links, derived from CONNECTOR_SECRET_KEY for this use only. */
async function signingKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: encoder.encode("mail-calendar attachment uploads v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function signedText(uploadId: string, expires: number, filename: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`upload\n${uploadId}\n${expires}\n${filename}`);
}

function downloadText(downloadId: string, expires: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`download\n${downloadId}\n${expires}`);
}

/** A file name without folders or control characters. */
function plainName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 255 &&
    ![...name].some((c) => c < " " || c === "\u007f" || c === "/" || c === "\\")
  );
}

function checkFilename(filename: string): string {
  const name = filename.trim();
  if (!plainName(name)) {
    throw new Error("Use a plain file name such as report.pdf, without folders.");
  }
  return name;
}

function configured(env: UploadEnv): { bucket: R2; secret: string } | undefined {
  const secret = env.CONNECTOR_SECRET_KEY ?? "";
  return env.UPLOADS && secret.length >= 32 ? { bucket: env.UPLOADS, secret } : undefined;
}

/** Uploads backed by the Worker's R2 bucket, or undefined when it is not set up. */
export function workerUploads(env: UploadEnv, origin: string): Uploads | undefined {
  const setup = configured(env);
  if (!setup) return undefined;
  const { bucket, secret } = setup;
  return {
    async create(filename: string): Promise<UploadTicket> {
      const name = checkFilename(filename);
      const uploadId = `up_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
      const expires = Math.floor(Date.now() / 1000) + LINK_TTL_S;
      const signature = await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        signedText(uploadId, expires, name)
      );
      // URLSearchParams also encodes ', so the URL is safe inside single quotes.
      const query = new URLSearchParams({
        expires: String(expires),
        filename: name,
        signature: base64url(signature),
      });
      return {
        uploadId,
        uploadUrl: `${origin}/uploads/${uploadId}?${query}`,
        expiresAt: new Date(expires * 1000).toISOString(),
        maxBytes: MAX_INLINE_ATTACHMENT_BYTES,
      };
    },

    async get(uploadId: string): Promise<UploadedFile> {
      const object = UPLOAD_ID_PATTERN.test(uploadId) ? await bucket.get(PREFIX + uploadId) : null;
      if (
        !object ||
        object.customMetadata?.attached ||
        object.uploaded.getTime() < Date.now() - KEEP_MS
      ) {
        throw new Error(
          `Upload ${uploadId} was not found: it was never uploaded, was already attached, or expired. Create a new one with create_attachment_upload.`
        );
      }
      const content = Buffer.from(await object.arrayBuffer());
      return {
        filename: object.customMetadata?.filename || "attachment",
        content,
        contentType: object.httpMetadata?.contentType,
        size: content.length,
        sha256: object.customMetadata?.sha256 ?? "",
      };
    },

    /**
     * Replaces each file with an empty marker rather than deleting it: while
     * the key exists the conditional put refuses the link, so it cannot store
     * a new file under an uploadId that was already attached.
     */
    async delete(uploadIds: string[]): Promise<void> {
      await Promise.all(
        uploadIds.map((id) =>
          bucket.put(PREFIX + id, new Uint8Array(), { customMetadata: ATTACHED })
        )
      );
    },

    async share(file): Promise<DownloadLink> {
      const downloadId = `dl_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`;
      const expires = Math.floor(Date.now() / 1000) + LINK_TTL_S;
      await bucket.put(DOWNLOADS + downloadId, new Uint8Array(file.content), {
        httpMetadata: file.contentType ? { contentType: file.contentType } : undefined,
        customMetadata: {
          filename: plainName(file.filename) ? file.filename : "attachment",
          expires: String(expires),
        },
      });
      const signature = await crypto.subtle.sign(
        "HMAC",
        await signingKey(secret),
        downloadText(downloadId, expires)
      );
      const query = new URLSearchParams({
        expires: String(expires),
        signature: base64url(signature),
      });
      return {
        downloadUrl: `${origin}/downloads/${downloadId}?${query}`,
        expiresAt: new Date(expires * 1000).toISOString(),
      };
    },
  };
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** The request body, or undefined once it exceeds `max` bytes. */
async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  max: number
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Receive a file PUT to a signed upload URL. */
export async function handleUpload(request: Request, env: UploadEnv): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.pathname.slice("/uploads/".length);
  if (!UPLOAD_ID_PATTERN.test(uploadId)) return json({ error: "Not found." }, 404);
  if (request.method !== "PUT") {
    return json({ error: "Upload the file with PUT, e.g. curl -T." }, 405, { Allow: "PUT" });
  }
  const setup = configured(env);
  if (!setup) return json({ error: "Uploads are not set up on this server." }, 501);

  const expires = Number(url.searchParams.get("expires"));
  const filename = url.searchParams.get("filename") ?? "";
  const signature = new Uint8Array(
    Buffer.from(url.searchParams.get("signature") ?? "", "base64url")
  );
  const valid =
    Number.isSafeInteger(expires) &&
    plainName(filename) &&
    (await crypto.subtle.verify(
      "HMAC",
      await signingKey(setup.secret),
      signature,
      signedText(uploadId, expires, filename)
    ));
  if (!valid) return json({ error: "This upload link is not valid." }, 403);
  if (expires * 1000 < Date.now()) {
    return json({ error: "This upload link expired; create a new one." }, 410);
  }

  const tooLarge = () =>
    json({ error: `The file exceeds ${MAX_INLINE_ATTACHMENT_BYTES} bytes (25 MiB).` }, 413);
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_INLINE_ATTACHMENT_BYTES) {
    return tooLarge();
  }
  const bytes = await readCapped(request.body, MAX_INLINE_ATTACHMENT_BYTES);
  if (!bytes) return tooLarge();
  if (!bytes.length) return json({ error: "The file is empty." }, 400);

  const sha256 = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
  // curl -T sends no type, and --data-binary a form type; the mail libraries
  // then infer one from the file name.
  const sent = request.headers.get("Content-Type") ?? "";
  const contentType =
    sent && !sent.startsWith("application/x-www-form-urlencoded") ? sent : undefined;
  const stored = await setup.bucket.put(PREFIX + uploadId, bytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: contentType ? { contentType } : undefined,
    customMetadata: { filename, sha256 },
  });
  if (!stored) return json({ error: "This upload link was already used; create a new one." }, 409);
  return json({ uploadId, filename, size: bytes.length, sha256 }, 201);
}

/** Serve a file kept by share() to whoever holds its signed link, until it expires. */
export async function handleDownload(request: Request, env: UploadEnv): Promise<Response> {
  const url = new URL(request.url);
  const downloadId = url.pathname.slice("/downloads/".length);
  if (!DOWNLOAD_ID.test(downloadId)) return json({ error: "Not found." }, 404);
  if (request.method !== "GET") {
    return json({ error: "Download the file with GET, e.g. curl -o." }, 405, { Allow: "GET" });
  }
  const setup = configured(env);
  if (!setup) return json({ error: "Downloads are not set up on this server." }, 501);
  const expires = Number(url.searchParams.get("expires"));
  const signature = new Uint8Array(
    Buffer.from(url.searchParams.get("signature") ?? "", "base64url")
  );
  const valid =
    Number.isSafeInteger(expires) &&
    (await crypto.subtle.verify(
      "HMAC",
      await signingKey(setup.secret),
      signature,
      downloadText(downloadId, expires)
    ));
  if (!valid) return json({ error: "This download link is not valid." }, 403);
  if (expires * 1000 < Date.now()) {
    return json({ error: "This download link expired; get the attachment again." }, 410);
  }
  const object = await setup.bucket.get(DOWNLOADS + downloadId);
  if (!object) return json({ error: "This file is no longer kept." }, 410);
  const filename = object.customMetadata?.filename || "attachment";
  return new Response(await object.arrayBuffer(), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
