import { createHash } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_INLINE_ATTACHMENT_BYTES } from "@/utils/attachmentLimits.js";
import { handleDownload, handleUpload, workerUploads, type R2 } from "@/worker/uploads.js";

const origin = "https://mail.example";
const secret = "0123456789abcdef0123456789abcdef";

interface Stored {
  bytes: Uint8Array;
  uploaded: Date;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

/** In-memory R2 with the create-only condition the handler relies on. */
function fakeR2() {
  const objects = new Map<string, Stored>();
  const bucket: R2 = {
    async put(key, value, options) {
      if (options?.onlyIf?.get("If-None-Match") === "*" && objects.has(key)) return null;
      objects.set(key, {
        bytes: value.slice(),
        uploaded: new Date(),
        httpMetadata: options?.httpMetadata,
        customMetadata: options?.customMetadata,
      });
      return {};
    },
    async get(key) {
      const object = objects.get(key);
      return object ? { ...object, arrayBuffer: async () => object.bytes.slice().buffer } : null;
    },
  };
  return { bucket, objects };
}

function setup() {
  const { bucket, objects } = fakeR2();
  const env = { UPLOADS: bucket, CONNECTOR_SECRET_KEY: secret };
  return { env, objects, uploads: workerUploads(env, origin)! };
}

function put(url: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(url, { method: "PUT", body, headers, duplex: "half" } as RequestInit);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("attachment uploads", () => {
  it("stores a file sent to a signed link and serves it back once", async () => {
    const { env, objects, uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    expect(ticket.uploadId).toMatch(/^up_[A-Za-z0-9_-]{22}$/);
    expect(ticket.uploadUrl.startsWith(`${origin}/uploads/${ticket.uploadId}?`)).toBe(true);
    expect(ticket.maxBytes).toBe(MAX_INLINE_ATTACHMENT_BYTES);

    const bytes = new TextEncoder().encode("%PDF-1.7 hello");
    const response = await handleUpload(put(ticket.uploadUrl, bytes), env);
    expect(response.status).toBe(201);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(await response.json()).toEqual({
      uploadId: ticket.uploadId,
      filename: "report.pdf",
      size: bytes.length,
      sha256,
    });

    const again = await handleUpload(put(ticket.uploadUrl, "replacement"), env);
    expect(again.status).toBe(409);

    const file = await uploads.get(ticket.uploadId);
    expect(file).toMatchObject({ filename: "report.pdf", size: bytes.length, sha256 });
    expect(file.contentType).toBeUndefined();
    expect(file.content.equals(Buffer.from(bytes))).toBe(true);

    await uploads.delete([ticket.uploadId]);
    expect(objects.get(`uploads/${ticket.uploadId}`)?.bytes.length).toBe(0);
    await expect(uploads.get(ticket.uploadId)).rejects.toThrow(/create_attachment_upload/);

    // Once attached, the link still cannot store a new file under the same uploadId.
    const reused = await handleUpload(put(ticket.uploadUrl, "replacement"), env);
    expect(reused.status).toBe(409);
    await expect(uploads.get(ticket.uploadId)).rejects.toThrow(/not found/);
  });

  it("keeps a sent content type but not a form type", async () => {
    const { env, uploads } = setup();
    const typed = await uploads.create("photo.png");
    await handleUpload(put(typed.uploadUrl, "png", { "Content-Type": "image/png" }), env);
    expect((await uploads.get(typed.uploadId)).contentType).toBe("image/png");

    const form = await uploads.create("notes.txt");
    await handleUpload(
      put(form.uploadUrl, "text", { "Content-Type": "application/x-www-form-urlencoded" }),
      env
    );
    expect((await uploads.get(form.uploadId)).contentType).toBeUndefined();
  });

  it("rejects links whose name, expiry or signature were changed", async () => {
    const { env, uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    for (const [field, value] of [
      ["filename", "other.pdf"],
      ["expires", "9999999999"],
      ["signature", "AAAA"],
    ]) {
      const url = new URL(ticket.uploadUrl);
      url.searchParams.set(field, value);
      expect((await handleUpload(put(url.href, "x"), env)).status, field).toBe(403);
    }
    const unsigned = new URL(ticket.uploadUrl);
    unsigned.searchParams.delete("signature");
    expect((await handleUpload(put(unsigned.href, "x"), env)).status).toBe(403);
  });

  it("rejects a link after 15 minutes", async () => {
    vi.useFakeTimers();
    const { env, uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect((await handleUpload(put(ticket.uploadUrl, "x"), env)).status).toBe(410);
  });

  it("forgets a file a day after it was uploaded", async () => {
    vi.useFakeTimers();
    const { env, uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    expect((await handleUpload(put(ticket.uploadUrl, "x"), env)).status).toBe(201);
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);
    await expect(uploads.get(ticket.uploadId)).rejects.toThrow(/not found/);
  });

  it("rejects empty and oversized files", async () => {
    const { env, objects, uploads } = setup();
    const empty = await uploads.create("empty.txt");
    expect((await handleUpload(put(empty.uploadUrl, ""), env)).status).toBe(400);

    const declared = await uploads.create("big.bin");
    const tooLong = put(declared.uploadUrl, "x", {
      "Content-Length": String(MAX_INLINE_ATTACHMENT_BYTES + 1),
    });
    expect((await handleUpload(tooLong, env)).status).toBe(413);

    // A streamed body without a length is counted as it arrives.
    const streamed = await uploads.create("big.bin");
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
        if (sent > MAX_INLINE_ATTACHMENT_BYTES + chunk.length) controller.close();
      },
    });
    expect((await handleUpload(put(streamed.uploadUrl, body), env)).status).toBe(413);
    expect(objects.size).toBe(0);
  });

  it("answers only PUT on upload paths", async () => {
    const { env, uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    const get = await handleUpload(new Request(ticket.uploadUrl), env);
    expect(get.status).toBe(405);
    expect(get.headers.get("Allow")).toBe("PUT");
    expect((await handleUpload(put(`${origin}/uploads/../etc`, "x"), env)).status).toBe(404);
  });

  it("needs a bucket and a long secret", async () => {
    const { bucket } = fakeR2();
    expect(workerUploads({ CONNECTOR_SECRET_KEY: secret }, origin)).toBeUndefined();
    expect(
      workerUploads({ UPLOADS: bucket, CONNECTOR_SECRET_KEY: "short" }, origin)
    ).toBeUndefined();
    const { uploads } = setup();
    const ticket = await uploads.create("report.pdf");
    const response = await handleUpload(put(ticket.uploadUrl, "x"), {});
    expect(response.status).toBe(501);
  });

  it("names files plainly and keeps links shell-safe", async () => {
    const { uploads } = setup();
    for (const name of ["a/b.pdf", "a\\b.pdf", "line\nbreak.txt", "", " "]) {
      await expect(uploads.create(name), JSON.stringify(name)).rejects.toThrow(/plain file name/);
    }
    const ticket = await uploads.create("Bob's notes (final).txt");
    expect(ticket.uploadUrl).not.toContain("'");
    expect(new URL(ticket.uploadUrl).searchParams.get("filename")).toBe("Bob's notes (final).txt");
  });
});

describe("attachment downloads", () => {
  it("serves a shared file to its signed link until the link expires", async () => {
    const { env, uploads } = setup();
    const link = await uploads.share({
      filename: "Q3 報告.pdf",
      content: Buffer.from("%PDF-1.7"),
      contentType: "application/pdf",
    });
    expect(link.downloadUrl).toMatch(/^https:\/\/mail\.example\/downloads\/dl_[A-Za-z0-9_-]{22}\?/);

    const response = await handleDownload(new Request(link.downloadUrl), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent("Q3 報告.pdf")}`
    );
    expect(await response.text()).toBe("%PDF-1.7");

    const tampered = new URL(link.downloadUrl);
    tampered.searchParams.set("expires", "9999999999");
    expect((await handleDownload(new Request(tampered.href), env)).status).toBe(403);
    expect(
      (await handleDownload(new Request(link.downloadUrl, { method: "POST" }), env)).status
    ).toBe(405);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    expect((await handleDownload(new Request(link.downloadUrl), env)).status).toBe(410);
  });
});
