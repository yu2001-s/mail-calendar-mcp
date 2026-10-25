/**
 * Attachments uploaded out of band. A client that can run shell commands
 * (Claude Code, Codex) uploads a local file to a one-time URL and then names
 * it by uploadId, so the file's bytes never pass through the conversation.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, toolResult } from "./tooling.js";

export interface UploadedFile {
  filename: string;
  content: Buffer;
  contentType?: string;
  size: number;
  sha256: string;
}

export interface UploadTicket {
  uploadId: string;
  uploadUrl: string;
  expiresAt: string;
  maxBytes: number;
}

/** Where uploaded files are kept until a draft or message attaches them. */
export interface Uploads {
  create(filename: string): Promise<UploadTicket>;
  /** The uploaded file; throws when it was never uploaded, was attached, or expired. */
  get(uploadId: string): Promise<UploadedFile>;
  delete(uploadIds: string[]): Promise<void>;
}

export const UPLOAD_ID_PATTERN = /^up_[A-Za-z0-9_-]{22}$/;

export interface UploadRef {
  uploadId: string;
  filename?: string;
}

/** Fields of an upload reference. Each call builds new schemas, so none is emitted as a $ref. */
export function uploadRefShape() {
  return {
    uploadId: z
      .string()
      .regex(UPLOAD_ID_PATTERN, "Use an uploadId returned by create_attachment_upload."),
    filename: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("Overrides the name given to create_attachment_upload."),
  };
}

export function isUploadRef(value: unknown): value is UploadRef {
  return typeof value === "object" && value !== null && "uploadId" in value;
}

/**
 * Replace each upload reference in `items` with what `attach` builds from the
 * file, then call `run`. Uploads are deleted only once `run` succeeds, so a
 * draft that failed can be retried with the same uploadIds.
 */
export async function withUploads<T, A, R>(
  uploads: Uploads | undefined,
  items: Array<T | UploadRef> | undefined,
  attach: (file: UploadedFile, ref: UploadRef) => A,
  run: (items: Array<T | A> | undefined) => Promise<R>
): Promise<R> {
  const refs = (items ?? []).filter(isUploadRef);
  if (!refs.length) return run(items as T[] | undefined);
  if (!uploads) throw new Error("This server does not accept uploads; attach files inline.");
  const resolved = await Promise.all(
    items!.map(async (item) =>
      isUploadRef(item) ? attach(await uploads.get(item.uploadId), item) : item
    )
  );
  const result = await run(resolved);
  if ((result as { success?: boolean } | undefined)?.success !== false) {
    await uploads.delete([...new Set(refs.map((ref) => ref.uploadId))]).catch(() => undefined);
  }
  return result;
}

export const UPLOAD_INSTRUCTIONS =
  "create_attachment_upload returns a one-time URL for uploading a local file, which drafts and messages then attach by uploadId instead of base64.";

export function registerUploadTool(server: McpServer, uploads: Uploads): void {
  registerTool(
    server,
    "create_attachment_upload",
    {
      description:
        "Get a one-time URL for attaching a local file without passing its bytes through the conversation, for clients that can run shell commands (such as Claude Code). Upload the file with the returned command within 15 minutes; the response reports its size and sha256. Then pass {uploadId} as an attachment to mail_create_draft or mail_update_draft (attachmentsToAdd). Up to 25 MiB per file. An upload is deleted once attached, or after a day.",
      inputSchema: {
        filename: z
          .string()
          .min(1)
          .max(255)
          .describe("The attachment's file name as recipients will see it, e.g. report.pdf."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (args) =>
      toolResult(async () => {
        const ticket = await uploads.create(args.filename);
        return {
          ...ticket,
          command: `curl -sS --fail-with-body -T <path-to-file> '${ticket.uploadUrl}'`,
        };
      })
  );
}
