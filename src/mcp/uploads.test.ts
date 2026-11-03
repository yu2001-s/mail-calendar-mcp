import { describe, expect, it, vi } from "vitest";
import { withUploads, type UploadedFile, type Uploads } from "@/mcp/uploads.js";

const uploadId = "up_AAAAAAAAAAAAAAAAAAAAAA";

function fakeUploads(): Uploads & {
  get: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(),
    get: vi.fn(async (id: string): Promise<UploadedFile> => ({
      filename: "report.pdf",
      content: Buffer.from(id),
      size: id.length,
      sha256: "",
    })),
    delete: vi.fn(async () => undefined),
    share: vi.fn(),
  };
}

const attach = (file: UploadedFile, ref: { filename?: string }) => ({
  filename: ref.filename ?? file.filename,
  content: file.content,
});

describe("withUploads", () => {
  it("passes attachments through when none is an upload", async () => {
    const uploads = fakeUploads();
    const inline = [{ filename: "a.txt", contentBase64: "YQ==" }];
    const run = vi.fn(async (items: unknown) => ({ success: true, items }));
    await withUploads(uploads, inline, attach, run);
    expect(run).toHaveBeenCalledWith(inline);
    expect(await withUploads(undefined, undefined, attach, run)).toEqual({
      success: true,
      items: undefined,
    });
    expect(uploads.get).not.toHaveBeenCalled();
  });

  it("replaces uploads with their bytes and deletes them once used", async () => {
    const uploads = fakeUploads();
    const inline = { filename: "a.txt", contentBase64: "YQ==" };
    const run = vi.fn(async (items: unknown) => ({ success: true, items }));
    const result = await withUploads(
      uploads,
      [inline, { uploadId }, { uploadId, filename: "copy.pdf" }],
      attach,
      run
    );
    expect(result.items).toEqual([
      inline,
      { filename: "report.pdf", content: Buffer.from(uploadId) },
      { filename: "copy.pdf", content: Buffer.from(uploadId) },
    ]);
    expect(uploads.delete).toHaveBeenCalledWith([uploadId]);
  });

  it("keeps uploads when the draft fails, so it can be retried", async () => {
    const uploads = fakeUploads();
    await withUploads(uploads, [{ uploadId }], attach, async () => ({ success: false }));
    await expect(
      withUploads(uploads, [{ uploadId }], attach, async () => {
        throw new Error("IMAP is down");
      })
    ).rejects.toThrow("IMAP is down");
    expect(uploads.delete).not.toHaveBeenCalled();
  });

  it("explains when the server takes no uploads", async () => {
    await expect(
      withUploads(undefined, [{ uploadId }], attach, async () => ({ success: true }))
    ).rejects.toThrow(/does not accept uploads/);
  });
});
