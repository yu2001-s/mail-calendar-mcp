/**
 * One set of mail tools for the iCloud account and every linked Gmail
 * account. Each ID names its account (see ids.ts), so a message found in one
 * account is read, answered and moved there without an account argument, and
 * a draft's from address picks the account it is sent from.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectMimeType } from "nodemailer/lib/mime-funcs/mime-types.js";
import { z } from "zod";
import type { GoogleAccounts } from "../google/accounts.js";
import { Gmail, MAX_ATTACHMENT_BYTES, tidyText, type AttachmentInput } from "../google/gmail.js";
import type { ConnectorContext } from "../icloud/context.js";
import {
  addressesIn,
  applyDisplayName,
  applySettingsUpdate,
  applySignature,
  displayNameFor,
  mergeDiscovered,
  sameAddress,
} from "../icloud/settings.js";
import { withSignature } from "../icloud/signature.js";
import { registerTool, toolResult, type ToolAnnotations } from "../mcp/tooling.js";
import {
  uploadRefShape,
  withUploads,
  type UploadedFile,
  type UploadRef,
  type Uploads,
} from "../mcp/uploads.js";
import {
  decodeImapId,
  encodeImapId,
  imapCreateMailbox,
  imapDeleteMailbox,
  imapDeleteMessageById,
  imapFetchAttachment,
  imapFlagMessage,
  imapMarkRead,
  imapMarkUnread,
  imapMoveMessageById,
  imapReadMessage,
  imapRenameMailbox,
  imapScanHeaders,
  imapUnflagMessage,
  type ImapOpResult,
} from "../services/imapClient.js";
import type { ImapDraftResult } from "../services/imapDraftManager.js";
import type { MimeDraftAttachment } from "../services/mimeDraft.js";
import { withSubjectPrefix } from "../services/replyForward.js";
import { resolveSmtpConfig } from "../services/smtpMailer.js";
import type { AttachmentInput as InlineAttachment, Draft } from "../types.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { htmlToText } from "../utils/htmlText.js";
import { findConversation } from "./conversation.js";
import { attachmentId, draftId, gmailId, messageId, parseGmailId, readableId } from "./ids.js";
import {
  gmailQuery,
  imapCriteria,
  imapFolderPaths,
  mailboxSpecial,
  specialFolder,
  type Mailbox,
  type MailQuery,
} from "./query.js";

/** How long discovered sending addresses are trusted before Sent is scanned again. */
const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BODY_CHARS = 20000;

/** What the mail tools do; part of the server instructions. */
export function mailInstructions(primaryAddress?: string): string {
  const sender = primaryAddress
    ? `by default ${primaryAddress} (iCloud, whose inbox also receives custom-domain mail)`
    : "by default the account's own address";
  return `mail_* tools work alike for the iCloud account and every linked Gmail account. Every ID names its account, so follow-up calls take no account; mail_search, mail_list_drafts and mail_list_folders cover every account unless given accounts. mail_create_draft saves a new message, a reply (replyTo) or a forward (forward); its from address picks the account, ${sender}. mail_update_draft edits a draft, and mail_send sends one with its current revision. Saved signatures are added to drafts. mail_update marks, flags, labels and moves messages. Before saying where a conversation stands, read it with mail_read thread: true, which includes your sent replies, and go by its last message.`;
}

export interface MailServices {
  icloud?: ConnectorContext;
  google?: GoogleAccounts;
  gmail?: Gmail;
  uploads?: Uploads;
}

type Account = { kind: "icloud"; name: string } | { kind: "gmail"; name: string };

/** One message as a search result, the same for every account. */
interface MailRow {
  id: string;
  threadId?: string;
  account: string;
  folder?: string;
  labels?: string[];
  date?: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  snippet?: string;
  unread: boolean;
  flagged: boolean;
  error?: string;
}

const HIDDEN_LABELS = new Set(["UNREAD", "STARRED", "DRAFT", "CHAT"]);

function addresses(list?: Array<{ name?: string; address?: string }>): string[] {
  return (list ?? [])
    .filter((item) => item.address)
    .map((item) => (item.name ? `${item.name} <${item.address}>` : item.address!));
}

function bounded(text: string, max: number): { body: string; bodyTruncated?: true } {
  return text.length > max ? { body: text.slice(0, max), bodyTruncated: true } : { body: text };
}

function textAsHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function bodyHtml(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*)<\/body\s*>/i)?.[1] ?? html;
}

function encodeCursor(positions: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(positions)).toString("base64url");
}

function decodeCursor(cursor: string): Record<string, string | number> {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value && typeof value === "object") return value;
  } catch {
    // Reported below.
  }
  throw new Error("Use the nextCursor of a previous mail_search.");
}

export function registerMailTools(server: McpServer, services: MailServices): void {
  const { icloud, google, uploads } = services;
  const gmail = google ? (services.gmail ?? new Gmail(google)) : undefined;
  const icloudAccount: Account | undefined = icloud && { kind: "icloud", name: icloud.account };

  function tool(
    name: string,
    description: string,
    inputSchema: z.ZodRawShape,
    kind: "read" | "write" | "destructive",
    fn: (args: any) => Promise<unknown>
  ) {
    const annotations: ToolAnnotations = {
      readOnlyHint: kind === "read",
      destructiveHint: kind === "destructive",
      idempotentHint: kind === "read",
      openWorldHint: true,
    };
    registerTool(server, name, { description, inputSchema, annotations }, (args) =>
      // iCloud drafts and sends are serialized, and read the current settings.
      icloud
        ? icloud.serialize(() =>
            toolResult(async () => {
              await icloud.refresh();
              return fn(args);
            })
          )
        : toolResult(() => fn(args))
    );
  }

  function needIcloud(): ConnectorContext {
    if (!icloud) throw new Error("No iCloud account is configured.");
    return icloud;
  }

  function needGmail(): { google: GoogleAccounts; gmail: Gmail } {
    if (!google || !gmail) throw new Error("No Google account is linked.");
    return { google, gmail };
  }

  async function gmailAccounts(): Promise<string[]> {
    return google ? google.resolveAll(undefined, "gmail").catch(() => []) : [];
  }

  /** The accounts named, or every mail account. */
  async function mailAccounts(names?: string[]): Promise<Account[]> {
    if (!names?.length) {
      const all: Account[] = icloudAccount ? [icloudAccount] : [];
      for (const name of await gmailAccounts()) all.push({ kind: "gmail", name });
      if (!all.length) {
        throw new Error(
          google
            ? `No mail account is set up yet; link Gmail accounts at ${google.manageUrl}.`
            : "No mail account is set up."
        );
      }
      return all;
    }
    const found: Account[] = [];
    for (const name of names) {
      const isIcloud =
        icloud &&
        (sameAddress(name, icloud.account) ||
          name.trim().toLowerCase() === "icloud" ||
          icloud.settings.addresses.some((address) => sameAddress(address, name)));
      const account: Account = isIcloud
        ? icloudAccount!
        : { kind: "gmail", name: await needGmail().google.resolve(name, "gmail") };
      if (!found.some((item) => item.name === account.name)) found.push(account);
    }
    return found;
  }

  /** The account an ID belongs to; a Gmail account must still be linked. */
  async function accountOf(id: string): Promise<Account> {
    const parsed = parseGmailId(id);
    if (parsed) {
      return { kind: "gmail", name: await needGmail().google.resolve(parsed.account, "gmail") };
    }
    if (/^(imap|apple-draft):/.test(id)) {
      needIcloud();
      return icloudAccount!;
    }
    throw new Error("Use an ID returned by the mail_* tools.");
  }

  /** Whether `address` sends as `account`: an iCloud sending address, or a Gmail send-as. */
  async function sendsAs(account: Account, address: string): Promise<boolean> {
    if (account.kind === "icloud") {
      return needIcloud().settings.addresses.some((item) => sameAddress(item, address));
    }
    const list = await needGmail().gmail.sendAs(account.name);
    return list.some((item) => sameAddress(item.sendAsEmail, address));
  }

  /** The account a new draft from `from` goes out of. */
  async function senderAccount(from?: string): Promise<Account> {
    if (!from) {
      if (icloudAccount) return icloudAccount;
      const emails = await gmailAccounts();
      if (emails.length === 1) return { kind: "gmail", name: emails[0] };
      throw new Error(`Several accounts can send; give from, one of: ${emails.join(", ")}.`);
    }
    if (icloudAccount && (await sendsAs(icloudAccount, from))) return icloudAccount;
    const emails = await gmailAccounts();
    const own = emails.find((email) => sameAddress(email, from));
    if (own) return { kind: "gmail", name: own };
    for (const email of emails) {
      if (await sendsAs({ kind: "gmail", name: email }, from))
        return { kind: "gmail", name: email };
    }
    throw new Error(`${from} is not a sending address of any account; list_accounts lists them.`);
  }

  /** The iCloud sending address `selector` names, or the primary one. */
  function icloudSender(selector?: string): string {
    const settings = needIcloud().settings;
    const address = settings.addresses.find((item) =>
      sameAddress(item, selector ?? settings.primaryAddress)
    );
    if (!address) throw new Error(`"${selector}" is not an iCloud sending address.`);
    return address;
  }

  /** Every Gmail address that can send, for signatures. */
  async function gmailAddresses(): Promise<string[]> {
    if (!gmail) return [];
    const lists = await Promise.all(
      (await gmailAccounts()).map(async (email) => [
        email,
        ...(await gmail.sendAs(email).catch(() => [])).map((item) => item.sendAsEmail),
      ])
    );
    return lists.flat();
  }

  function signed<T extends { body?: string; htmlBody?: string | null }>(
    mail: T,
    from: string,
    includeSignature?: boolean
  ): T {
    const preferences = icloud?.settings ?? { signatures: {} };
    return withSignature({ ...mail, from, includeSignature }, preferences, from) as unknown as T;
  }

  // ---------------------------------------------------------------- Views

  const labelNameCache = new Map<string, Promise<Map<string, string>>>();
  function labelNames(account: string): Promise<Map<string, string>> {
    let names = labelNameCache.get(account);
    if (!names) {
      names = needGmail()
        .gmail.listLabels(account)
        .then(
          (list) =>
            new Map<string, string>(
              list.labels.map((label: { id: string; name: string }) => [label.id, label.name])
            )
        )
        .catch(() => new Map<string, string>());
      labelNameCache.set(account, names);
    }
    return names;
  }

  function shownLabels(ids: string[], names: Map<string, string>): string[] {
    return ids
      .filter((id) => !HIDDEN_LABELS.has(id) && !id.startsWith("CATEGORY_"))
      .map((id) => names.get(id) ?? id);
  }

  function gmailRow(account: string, view: any, names: Map<string, string>): MailRow {
    const labels: string[] = view.labelIds ?? [];
    const cc: string[] = view.ccRecipients ?? [];
    return {
      id: gmailId("message", account, view.id),
      threadId: gmailId("thread", account, view.threadId),
      account,
      labels: shownLabels(labels, names),
      date: view.date,
      from: view.sender ?? "",
      to: view.toRecipients ?? [],
      ...(cc.length && { cc }),
      subject: view.subject ?? "",
      snippet: view.snippet,
      unread: labels.includes("UNREAD"),
      flagged: labels.includes("STARRED"),
    };
  }

  function gmailMessage(account: string, view: any, names: Map<string, string>) {
    const row: Partial<MailRow> = gmailRow(account, view, names);
    delete row.snippet;
    const bcc: string[] = view.bccRecipients ?? [];
    return {
      ...row,
      ...(bcc.length && { bcc }),
      viewUrl: view.viewUrl,
      body: view.plaintextBody ?? "",
      ...(view.bodyTruncated && { bodyTruncated: true }),
      ...(view.htmlBody && { htmlBody: view.htmlBody }),
      attachments: (view.attachments ?? []).map((item: any) => ({
        ...(item.attachmentId && {
          id: gmailId("attachment", account, `${view.id}:${item.attachmentId}`),
        }),
        name: item.filename,
        mimeType: item.mimeType,
        size: item.size,
      })),
    };
  }

  function gmailDraft(account: string, view: any) {
    const cc: string[] = view.ccRecipients ?? [];
    const bcc: string[] = view.bccRecipients ?? [];
    return {
      draftId: gmailId("draft", account, view.id),
      revision: view.messageId,
      account,
      viewUrl: view.viewUrl,
      from: view.sender ?? "",
      to: view.toRecipients ?? [],
      ...(cc.length && { cc }),
      ...(bcc.length && { bcc }),
      subject: view.subject ?? "",
      ...(view.plaintextBody !== undefined && { body: view.plaintextBody }),
      ...(view.attachments?.length && {
        attachments: view.attachments.map((item: any) => item.filename),
      }),
    };
  }

  function icloudDraft(draft: Draft, full = true) {
    return {
      draftId: draft.draftId,
      revision: draft.revision,
      account: needIcloud().account,
      from: draft.from,
      to: draft.to,
      ...(draft.cc.length && { cc: draft.cc }),
      ...(draft.bcc.length && { bcc: draft.bcc }),
      subject: draft.subject,
      ...(full && { body: draft.body }),
      ...(full && draft.htmlBody && { htmlBody: draft.htmlBody }),
      ...(draft.attachments?.length && {
        attachments: draft.attachments.map((item) => item.name),
      }),
      ...(draft.deliveryState &&
        draft.deliveryState !== "draft" && { deliveryState: draft.deliveryState }),
    };
  }

  function icloudDraftResult(result: ImapDraftResult) {
    if (!result.success || !result.draft) throw new Error(result.error ?? "The draft failed.");
    return { ...icloudDraft(result.draft), ...(result.warning && { warning: result.warning }) };
  }

  async function gmailDraftById(account: string, id: string) {
    return gmailDraft(account, await needGmail().gmail.getDraft(account, id, "PLAIN_TEXT"));
  }

  // ---------------------------------------------------------------- iCloud helpers

  async function icloudMailboxes(): Promise<Mailbox[]> {
    return needIcloud().withImap(async (client) => (await client.list()) as Mailbox[]);
  }

  async function icloudFolderPath(folder: string): Promise<string> {
    return imapFolderPaths(await icloudMailboxes(), folder)[0];
  }

  async function searchIcloud(query: MailQuery, limit: number, offset: number) {
    const ctx = needIcloud();
    return ctx.withImap(async (client) => {
      const paths = imapFolderPaths((await client.list()) as Mailbox[], query.folder);
      const criteria = imapCriteria(query);
      const rows: MailRow[] = [];
      let total = 0;
      for (const path of paths) {
        const lock = await client.getMailboxLock(path);
        try {
          const found = await client.search(criteria, { uid: true });
          const uids = Array.isArray(found) ? found : [];
          total += uids.length;
          // UIDs grow with arrival, so the newest are last.
          const recent = uids.slice(-(offset + limit));
          if (!recent.length) continue;
          for await (const message of client.fetch(
            recent.join(","),
            { envelope: true, flags: true },
            { uid: true }
          )) {
            const envelope = message.envelope ?? {};
            const cc = addresses(envelope.cc);
            rows.push({
              id: encodeImapId(ctx.account, path, message.uid),
              account: ctx.account,
              folder: path,
              date: envelope.date ? new Date(envelope.date).toISOString() : undefined,
              from: addresses(envelope.from)[0] ?? "",
              to: addresses(envelope.to),
              ...(cc.length && { cc }),
              subject: envelope.subject || "(no subject)",
              unread: !message.flags?.has("\\Seen"),
              flagged: message.flags?.has("\\Flagged") ?? false,
            });
          }
        } finally {
          lock.release();
        }
      }
      rows.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      return {
        messages: rows.slice(offset, offset + limit),
        next: offset + limit < total ? offset + limit : undefined,
      };
    });
  }

  async function searchGmail(account: string, query: MailQuery, limit: number, page?: string) {
    const result = await needGmail().gmail.searchMessages(account, {
      query: gmailQuery(query),
      pageSize: limit,
      pageToken: page,
    });
    const names = await labelNames(account);
    return {
      messages: result.messages.map((view: any) =>
        view.error
          ? ({ id: gmailId("message", account, view.id), account, error: view.error } as MailRow)
          : gmailRow(account, view, names)
      ),
      next: result.nextPageToken ?? undefined,
    };
  }

  function checkIcloudId(id: string) {
    needIcloud().checkId(id);
  }

  async function icloudMessage(id: string, format: string, maxBodyChars: number) {
    const ctx = needIcloud();
    checkIcloudId(id);
    const read = await imapReadMessage(id, false, ctx.imapDeps);
    if (!read.message) throw new Error(read.error ?? "The message could not be read.");
    const message = read.message;
    if (/draft/i.test(message.mailbox ?? "")) {
      // A draft another mail app saved: its revision lets mail_send send it.
      return icloudDraftResult(await ctx.drafts.getImapDraft(id));
    }
    const text = tidyText(message.textBody || htmlToText(message.htmlBody ?? ""));
    const replyTo = message.replyTo.filter(
      (address) => !message.from.some((item) => sameAddress(item, address))
    );
    return {
      id,
      account: ctx.account,
      folder: message.mailbox,
      date: message.date,
      from: message.from[0] ?? "",
      ...(replyTo.length && { replyTo }),
      to: message.to,
      ...(message.cc.length && { cc: message.cc }),
      ...(message.bcc.length && { bcc: message.bcc }),
      subject: message.subject,
      unread: !message.flags?.isRead,
      flagged: message.flags?.isFlagged ?? false,
      ...bounded(text, maxBodyChars),
      ...(format === "html" && message.htmlBody && { htmlBody: message.htmlBody }),
      attachments: message.attachments.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
      })),
    };
  }

  /** The conversation an iCloud message is in, oldest first, from every folder. */
  async function icloudConversation(id: string, format: string, maxBodyChars: number) {
    const ctx = needIcloud();
    checkIcloudId(id);
    const found = await ctx.withImap((client) =>
      findConversation(client, decodeImapId(id)!, (address) =>
        ctx.settings.addresses.some((own) => sameAddress(own, address))
      )
    );
    const messages = [];
    for (const item of found.messages) {
      const itemId = encodeImapId(ctx.account, item.path, item.uid);
      messages.push(await icloudMessage(itemId, format, maxBodyChars));
    }
    return {
      account: ctx.account,
      messages,
      ...(found.omitted && { omitted: found.omitted }),
    };
  }

  /** A forward of an iCloud message, with its attachments, below the comments. */
  async function icloudForward(sourceId: string, comment: { body?: string; htmlBody?: string }) {
    const ctx = needIcloud();
    checkIcloudId(sourceId);
    const read = await imapReadMessage(sourceId, false, ctx.imapDeps);
    if (!read.message) throw new Error(read.error ?? "The message could not be read.");
    const original = read.message;
    const fields = (
      [
        ["From", original.from.join(", ")],
        ["Date", original.date],
        ["Subject", original.subject],
        ["To", original.to.join(", ")],
        ["Cc", original.cc.join(", ")],
      ] as Array<[string, string | undefined]>
    ).filter((field): field is [string, string] => Boolean(field[1]));
    const intro = "---------- Forwarded message ---------";
    const originalText = original.textBody || htmlToText(original.htmlBody ?? "");
    const body =
      `${comment.body ?? (comment.htmlBody ? htmlToText(comment.htmlBody) : "")}\n\n${intro}\n${fields
        .map(([name, value]) => `${name}: ${value}`)
        .join("\n")}\n\n${originalText}`.trimStart();
    const htmlBody =
      comment.htmlBody || original.htmlBody
        ? `${comment.htmlBody ?? textAsHtml(comment.body ?? "")}<br><br><div>${intro}<br>${fields
            .map(([name, value]) => `${name}: ${escapeHtml(value)}`)
            .join("<br>")}</div><br>${
            original.htmlBody ? bodyHtml(original.htmlBody) : textAsHtml(originalText)
          }`
        : undefined;
    const files: InlineAttachment[] = [];
    for (const item of original.attachments) {
      const part = item.id.slice(item.id.lastIndexOf("#") + 1);
      const fetched = await imapFetchAttachment(sourceId, part, ctx.imapDeps);
      if (!fetched.success || fetched.base64 === undefined) {
        throw new Error(fetched.error ?? `Could not fetch "${item.name}" to forward.`);
      }
      files.push({ filename: item.name, contentBase64: fetched.base64 });
    }
    return { subject: withSubjectPrefix(original.subject, "Fwd:"), body, htmlBody, files };
  }

  function opResult(result: ImapOpResult): ImapOpResult {
    if (!result.success) throw new Error(result.error ?? "The IMAP operation failed.");
    return result;
  }

  // ---------------------------------------------------------------- Attachments

  const inlineAttachment = () =>
    z.object({ filename: z.string().min(1).max(255), contentBase64: z.string().min(1) });
  const attachments = () =>
    z
      .array(
        uploads ? z.union([inlineAttachment(), z.object(uploadRefShape())]) : inlineAttachment()
      )
      .max(20)
      .optional()
      .describe(
        uploads
          ? "Inline {filename, contentBase64}, or {uploadId} from create_attachment_upload for a local file; 25 MB in all."
          : "Inline {filename, contentBase64}; 25 MB in all."
      );
  type AttachmentArg = InlineAttachment | UploadRef;

  /** Attachments for an iCloud draft, uploads read from storage. */
  function icloudFiles<R>(
    items: AttachmentArg[] | undefined,
    run: (files: Array<InlineAttachment | MimeDraftAttachment> | undefined) => Promise<R>
  ): Promise<R> {
    return withUploads(
      uploads,
      items,
      (file: UploadedFile, ref: UploadRef): MimeDraftAttachment => ({
        filename: ref.filename ?? file.filename,
        content: file.content,
        contentType: file.contentType,
      }),
      run
    );
  }

  /** Attachments for a Gmail draft. */
  function gmailFiles<R>(
    items: AttachmentArg[] | undefined,
    run: (files: AttachmentInput[] | undefined) => Promise<R>
  ): Promise<R> {
    return withUploads(
      uploads,
      items,
      (file: UploadedFile, ref: UploadRef): AttachmentInput => {
        const filename = ref.filename ?? file.filename;
        return {
          content: file.content,
          filename,
          mimeType: file.contentType ?? detectMimeType(filename),
        };
      },
      (files) =>
        run(
          files?.map((item) =>
            "contentBase64" in item
              ? {
                  content: item.contentBase64,
                  filename: item.filename,
                  mimeType: detectMimeType(item.filename),
                }
              : item
          )
        )
    );
  }

  // ---------------------------------------------------------------- Shared fields

  const accountsField = () =>
    z
      .array(z.string().min(1).max(254))
      .max(20)
      .optional()
      .describe(
        'Accounts to cover: "iCloud" or an iCloud address, or a Gmail address or nickname (see list_accounts). Default: every account.'
      );
  const emails = (description: string) =>
    z.array(z.string().email()).max(100).optional().describe(description);
  const includeSignature = () =>
    z
      .boolean()
      .optional()
      .describe("Add the sender's saved signature to supplied body content; default true.");

  // ---------------------------------------------------------------- Reading

  tool(
    "mail_search",
    "Search mail in every account, or those in accounts, newest first. Returns headers, not bodies: read one with mail_read. text finds only the messages that contain it, so later replies in a conversation can be missing: before saying where a conversation stands, read it with mail_read thread: true. Each account returns up to limit messages; pass nextCursor back as cursor for more.",
    {
      accounts: accountsField(),
      folder: z
        .string()
        .min(1)
        .optional()
        .describe(
          "inbox (default), sent, drafts, archive, junk, trash, all (everything but drafts, junk and trash), or a folder or Gmail label name from mail_list_folders."
        ),
      text: z
        .string()
        .optional()
        .describe("Words anywhere in the message. Gmail operators also work for Gmail accounts."),
      from: z.string().optional().describe("Part of the sender's name or address."),
      to: z
        .string()
        .optional()
        .describe(
          "Part of a recipient's name or address; the iCloud inbox also receives mail for custom-domain addresses."
        ),
      with: z
        .string()
        .optional()
        .describe(
          "Part of the name or address of someone the mail is from, to or copied to: your mail with them both ways. Without folder, searches all."
        ),
      subject: z.string().optional().describe("Part of the subject."),
      since: z.string().date().optional().describe("YYYY-MM-DD, inclusive."),
      before: z.string().date().optional().describe("YYYY-MM-DD, exclusive."),
      unread: z.boolean().optional().describe("true for unread mail only, false for read only."),
      flagged: z.boolean().optional().describe("Flagged (Gmail: starred) mail only, or unflagged."),
      hasAttachment: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).default(20).describe("Messages per account."),
      cursor: z
        .string()
        .optional()
        .describe("nextCursor from a previous call with the same filters."),
    },
    "read",
    async (args) => {
      const positions = args.cursor ? decodeCursor(args.cursor) : undefined;
      const targets = await mailAccounts(positions ? Object.keys(positions) : args.accounts);
      // A correspondence is in Sent as much as in the inbox.
      const query: MailQuery = { ...args, folder: args.folder ?? (args.with ? "all" : undefined) };
      const results = await Promise.all(
        targets.map(async (account) => {
          try {
            const at = positions?.[account.name];
            const found =
              account.kind === "icloud"
                ? await searchIcloud(query, args.limit, Number(at ?? 0))
                : await searchGmail(account.name, query, args.limit, at as string | undefined);
            return { account: account.name, ...found };
          } catch (error) {
            return { account: account.name, error: (error as Error).message };
          }
        })
      );
      const messages = results
        .flatMap((result) => ("messages" in result ? result.messages : []))
        .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
      const next = Object.fromEntries(
        results.flatMap((result) =>
          "next" in result && result.next !== undefined ? [[result.account, result.next]] : []
        )
      );
      const errors = results.flatMap((result) =>
        "error" in result ? [{ account: result.account, error: result.error }] : []
      );
      return {
        messages,
        ...(errors.length && { errors }),
        ...(Object.keys(next).length && { nextCursor: encodeCursor(next) }),
      };
    }
  );

  tool(
    "mail_read",
    "Read a message, a whole conversation (thread: true, or a Gmail thread ID), or a draft (with its revision), with attachment IDs for mail_get_attachment. A conversation comes oldest first from every folder, your sent replies included, so its last message is where it stands. Does not mark mail read.",
    {
      id: readableId(),
      thread: z
        .boolean()
        .default(false)
        .describe("true: the whole conversation the message is in, not just the message."),
      format: z
        .enum(["text", "html"])
        .default("text")
        .describe("text: the plain-text body. html: also the HTML body."),
      maxBodyChars: z
        .number()
        .int()
        .min(100)
        .max(200000)
        .default(DEFAULT_BODY_CHARS)
        .describe("Truncate each body to this many characters."),
    },
    "read",
    async (args) => {
      const parsed = parseGmailId(args.id);
      if (!parsed) {
        if (args.id.startsWith("apple-draft:")) {
          return icloudDraftResult(await needIcloud().drafts.getDraft(args.id));
        }
        return args.thread
          ? icloudConversation(args.id, args.format, args.maxBodyChars)
          : icloudMessage(args.id, args.format, args.maxBodyChars);
      }
      const { gmail } = needGmail();
      const account = (await accountOf(args.id)).name;
      const format = args.format === "html" ? "FULL_CONTENT" : "PLAIN_TEXT";
      if (parsed.kind === "draft") {
        return gmailDraft(
          account,
          await gmail.getDraft(account, parsed.id, format, args.maxBodyChars)
        );
      }
      const names = await labelNames(account);
      let threadId = parsed.kind === "thread" ? parsed.id : undefined;
      if (args.thread && parsed.kind === "message") {
        const view: Record<string, unknown> = await gmail.getMessage(
          account,
          parsed.id,
          "METADATA_ONLY"
        );
        threadId = view.threadId as string | undefined;
      }
      if (threadId) {
        const thread = await gmail.getThread(account, threadId, format, args.maxBodyChars);
        return {
          threadId: gmailId("thread", account, threadId),
          account,
          messages: thread.messages.map((view) => gmailMessage(account, view, names)),
        };
      }
      return gmailMessage(
        account,
        await gmail.getMessage(account, parsed.id, format, args.maxBodyChars),
        names
      );
    }
  );

  tool(
    "mail_get_attachment",
    "Download one attachment, by an ID from mail_read, as base64 (up to 20 MiB).",
    { id: attachmentId() },
    "read",
    async (args) => {
      const parsed = parseGmailId(args.id);
      if (parsed) {
        const account = (await accountOf(args.id)).name;
        const split = parsed.id.indexOf(":");
        const result = await needGmail().gmail.getAttachment(
          account,
          parsed.id.slice(0, split),
          parsed.id.slice(split + 1)
        );
        return { id: args.id, size: result.size, contentBase64: result.contentBase64 };
      }
      const at = args.id.lastIndexOf("#");
      const message = args.id.slice(0, at);
      checkIcloudId(message);
      const result = await imapFetchAttachment(
        message,
        args.id.slice(at + 1),
        needIcloud().imapDeps
      );
      if (!result.success) throw new Error(result.error ?? "Attachment not found.");
      if ((result.bytes ?? 0) > MAX_ATTACHMENT_BYTES) throw new Error("Attachment exceeds 20 MiB.");
      return {
        id: args.id,
        size: result.bytes,
        mimeType: result.mimeType,
        contentBase64: result.base64,
      };
    }
  );

  tool(
    "mail_list_folders",
    "List the folders (iCloud mailboxes and Gmail labels) of every account, or those in accounts, with the special folder each one is.",
    { accounts: accountsField() },
    "read",
    async (args) => {
      const folders: unknown[] = [];
      const errors: unknown[] = [];
      for (const account of await mailAccounts(args.accounts)) {
        try {
          if (account.kind === "icloud") {
            for (const box of await icloudMailboxes()) {
              const special = mailboxSpecial(box);
              folders.push({ account: account.name, name: box.path, ...(special && { special }) });
            }
          } else {
            const { labels } = await needGmail().gmail.listLabels(account.name);
            for (const label of labels) {
              if (/^(CATEGORY_|CHAT$|UNREAD$|STARRED$|IMPORTANT$)/.test(label.id)) continue;
              const special = specialFolder(label.id === "SPAM" ? "junk" : label.id);
              folders.push({
                account: account.name,
                name: label.name,
                ...(label.type === "system" && special && { special }),
              });
            }
          }
        } catch (error) {
          errors.push({ account: account.name, error: (error as Error).message });
        }
      }
      return { folders, ...(errors.length && { errors }) };
    }
  );

  // ---------------------------------------------------------------- Drafts and sending

  const composeFields = {
    to: emails("Recipients, as plain addresses."),
    cc: emails("Cc recipients."),
    bcc: emails("Bcc recipients."),
    subject: z.string().optional(),
    body: z
      .string()
      .optional()
      .describe("Plain-text body; no Markdown. Put formatting in htmlBody."),
    htmlBody: z
      .string()
      .optional()
      .describe("HTML body; body, if given, is its plain-text alternative."),
  };

  tool(
    "mail_create_draft",
    "Save a draft without sending it: a new message, a reply to replyTo (recipients, subject and threading come from the original), or a forward of forward with its attachments. Returns the saved draft with its revision for mail_send.",
    {
      from: z
        .string()
        .email()
        .optional()
        .describe(
          "Sending address; it picks the account. Default: the primary address, or for a reply or forward the account the original is in."
        ),
      ...composeFields,
      attachments: attachments(),
      replyTo: messageId().optional().describe("Message (or Gmail thread) to reply to."),
      replyAll: z.boolean().optional().describe("Reply to every recipient of the original."),
      quoteOriginal: z
        .boolean()
        .optional()
        .describe("Quote the original below a reply; default true."),
      forward: messageId().optional().describe("Message to forward."),
      includeSignature: includeSignature(),
    },
    "write",
    async (args) => {
      if (args.replyTo && args.forward) throw new Error("Give replyTo or forward, not both.");
      const source: string | undefined = args.replyTo ?? args.forward;
      const account = source ? await accountOf(source) : await senderAccount(args.from);
      if (source && args.from && !(await sendsAs(account, args.from))) {
        throw new Error(`${args.from} cannot send from ${account.name}, where the original is.`);
      }
      if (!source && !args.to?.length && !args.cc?.length && !args.bcc?.length) {
        throw new Error("Give at least one recipient.");
      }
      return account.kind === "icloud"
        ? createIcloudDraft(args)
        : createGmailDraft(account.name, args);
    }
  );

  async function createIcloudDraft(args: any) {
    const ctx = needIcloud();
    const from = icloudSender(args.from);
    const sign = <T extends { body?: string; htmlBody?: string | null }>(mail: T) =>
      signed(mail, from, args.includeSignature);
    if (args.replyTo) {
      checkIcloudId(args.replyTo);
      // Attachments are read first, so a bad upload fails before the draft exists.
      return icloudFiles(args.attachments, async (files) => {
        const reply = icloudDraftResult(
          await ctx.drafts.createReplyDraft(
            sign({
              originalMessageId: args.replyTo,
              from,
              body: args.body ?? (args.htmlBody ? htmlToText(args.htmlBody) : ""),
              replyAll: args.replyAll ?? false,
              quoteOriginal: args.quoteOriginal ?? true,
            }) as any
          )
        );
        const extra = {
          ...(args.to?.length && { to: args.to }),
          ...(args.cc?.length && { cc: args.cc }),
          ...(args.bcc?.length && { bcc: args.bcc }),
          ...(args.subject && { subject: args.subject }),
          ...(args.htmlBody && { htmlBody: sign({ htmlBody: args.htmlBody }).htmlBody }),
          ...(files?.length && { attachmentsToAdd: files }),
        };
        if (!Object.keys(extra).length) return reply;
        return icloudDraftResult(
          await ctx.drafts.updateDraft(reply.draftId, {
            expectedRevision: reply.revision,
            ...extra,
          })
        );
      });
    }
    // The signature belongs to the new text, above a forwarded message.
    const content = sign({ body: args.body ?? "", htmlBody: args.htmlBody });
    const forward = args.forward
      ? await icloudForward(args.forward, {
          body: content.body,
          htmlBody: content.htmlBody ?? undefined,
        })
      : undefined;
    return icloudFiles(args.attachments, async (files) =>
      icloudDraftResult(
        await ctx.drafts.createDraft({
          from,
          to: args.to ?? [],
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject || forward?.subject || "",
          body: forward?.body ?? content.body ?? "",
          htmlBody: (forward ? forward.htmlBody : content.htmlBody) ?? undefined,
          attachments: [...(forward?.files ?? []), ...(files ?? [])],
        })
      )
    );
  }

  /** The Gmail message a reply goes to: the message, or a thread's latest one. */
  async function gmailReplyTarget(account: string, id: string): Promise<string> {
    const parsed = parseGmailId(id)!;
    if (parsed.kind === "message") return parsed.id;
    const thread = await needGmail().gmail.getThread(account, parsed.id, "MINIMAL");
    const latest = thread.messages.at(-1)?.id as string | undefined;
    if (!latest) throw new Error("That thread has no message to reply to.");
    return latest;
  }

  async function gmailDefaultAddress(account: string): Promise<string> {
    const list = await needGmail().gmail.sendAs(account);
    return (list.find((item) => item.isDefault) ?? list[0])?.sendAsEmail ?? account;
  }

  async function createGmailDraft(account: string, args: any) {
    const { gmail } = needGmail();
    const signer = args.from ?? (await gmailDefaultAddress(account));
    const content = signed(
      { body: args.body, htmlBody: args.htmlBody },
      signer,
      args.includeSignature
    );
    const replyTo = args.replyTo ? await gmailReplyTarget(account, args.replyTo) : undefined;
    const forwardOf = args.forward ? parseGmailId(args.forward)!.id : undefined;
    return gmailFiles(args.attachments, async (files) => {
      const draft = await gmail.createDraft(account, {
        from: args.from,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: content.body,
        htmlBody: content.htmlBody ?? undefined,
        attachments: files,
        replyToMessageId: replyTo,
        replyAll: args.replyAll,
        quote: args.quoteOriginal ?? true,
        forwardOf,
      });
      return gmailDraftById(account, draft.id);
    });
  }

  /** A Gmail draft's ID, once its revision matches. */
  async function checkedGmailDraft(id: string, revision: string) {
    const account = (await accountOf(id)).name;
    const draft = parseGmailId(id)!.id;
    const current = await needGmail().gmail.draftRevision(account, draft);
    if (current !== revision) {
      throw new Error(
        `The draft changed since revision ${revision}; its current revision is ${current}. Read it again with mail_read.`
      );
    }
    return { account, draft };
  }

  tool(
    "mail_update_draft",
    "Change a draft saved by mail_create_draft: given fields replace its own, the rest stay. Needs the draft's current revision, and returns the new one.",
    {
      draftId: draftId(),
      revision: z.string().min(1).describe("The draft's current revision."),
      from: z.string().email().optional().describe("Another sending address of the same account."),
      ...composeFields,
      attachmentsToAdd: attachments(),
      attachmentNamesToRemove: z.array(z.string()).max(20).optional(),
      includeSignature: includeSignature(),
    },
    "write",
    async (args) => {
      const account = await accountOf(args.draftId);
      if (args.from && !(await sendsAs(account, args.from))) {
        throw new Error(`${args.from} cannot send from ${account.name}.`);
      }
      const hasBody = args.body !== undefined || Boolean(args.htmlBody);
      if (account.kind === "gmail") {
        const { gmail } = needGmail();
        const { draft } = await checkedGmailDraft(args.draftId, args.revision);
        const signer =
          args.from ??
          addressesIn(
            String(
              ((await gmail.getDraft(account.name, draft, "METADATA_ONLY")) as { sender?: string })
                .sender ?? ""
            )
          )[0] ??
          account.name;
        const content: { body?: string; htmlBody?: string | null } = hasBody
          ? signed({ body: args.body, htmlBody: args.htmlBody }, signer, args.includeSignature)
          : {};
        return gmailFiles(args.attachmentsToAdd, async (files) => {
          await gmail.updateDraft(account.name, draft, {
            from: args.from,
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            ...content,
            htmlBody: content.htmlBody ?? undefined,
            attachmentsToAdd: files,
            attachmentNamesToRemove: args.attachmentNamesToRemove,
          });
          return gmailDraftById(account.name, draft);
        });
      }
      if (!args.draftId.startsWith("apple-draft:")) {
        throw new Error(
          "This draft was saved by another mail app: send or delete it here, or edit it there."
        );
      }
      const ctx = needIcloud();
      const from = args.from ? icloudSender(args.from) : undefined;
      let signer = from ?? ctx.settings.primaryAddress;
      if (!from && hasBody && args.includeSignature !== false) {
        const current = await ctx.drafts.getDraft(args.draftId);
        if (!current.success || !current.draft) return icloudDraftResult(current);
        signer = addressesIn(current.draft.from)[0] ?? current.draft.from;
      }
      const content: { body?: string; htmlBody?: string | null } = hasBody
        ? signed({ body: args.body, htmlBody: args.htmlBody }, signer, args.includeSignature)
        : {};
      return icloudFiles(args.attachmentsToAdd, async (files) =>
        icloudDraftResult(
          await ctx.drafts.updateDraft(args.draftId, {
            expectedRevision: args.revision,
            from,
            to: args.to,
            cc: args.cc,
            bcc: args.bcc,
            subject: args.subject,
            ...content,
            attachmentsToAdd: files,
            attachmentNamesToRemove: args.attachmentNamesToRemove,
          })
        )
      );
    }
  );

  tool(
    "mail_list_drafts",
    "List drafts in every account, or those in accounts: Gmail drafts and the iCloud drafts saved here. iCloud drafts saved by other mail apps are in mail_search with folder drafts.",
    {
      accounts: accountsField(),
      limit: z.number().int().min(1).max(50).default(20).describe("Drafts per Gmail account."),
    },
    "read",
    async (args) => {
      const drafts: unknown[] = [];
      const errors: unknown[] = [];
      for (const account of await mailAccounts(args.accounts)) {
        try {
          if (account.kind === "icloud") {
            const list = await needIcloud().drafts.listDrafts();
            if (!list.success) throw new Error(list.error ?? "Could not list drafts.");
            drafts.push(...(list.drafts ?? []).map((draft) => icloudDraft(draft, false)));
          } else {
            const list = await needGmail().gmail.listDrafts(account.name, { pageSize: args.limit });
            drafts.push(
              ...list.drafts.map((view: any) =>
                view.error
                  ? { draftId: gmailId("draft", account.name, view.id), error: view.error }
                  : gmailDraft(account.name, view)
              )
            );
          }
        } catch (error) {
          errors.push({ account: account.name, error: (error as Error).message });
        }
      }
      return { drafts, ...(errors.length && { errors }) };
    }
  );

  tool(
    "mail_delete_draft",
    "Delete a draft. An iCloud draft another mail app saved goes to Trash.",
    { draftId: draftId() },
    "destructive",
    async (args) => {
      const account = await accountOf(args.draftId);
      if (account.kind === "gmail") {
        await needGmail().gmail.deleteDraft(account.name, parseGmailId(args.draftId)!.id);
        return { deleted: args.draftId };
      }
      if (args.draftId.startsWith("apple-draft:")) {
        const result = await needIcloud().drafts.deleteDraft(args.draftId);
        if (!result.success) throw new Error(result.error ?? "The draft could not be deleted.");
        return { deleted: args.draftId };
      }
      checkIcloudId(args.draftId);
      opResult(await imapDeleteMessageById(args.draftId, needIcloud().imapDeps));
      return { deleted: args.draftId };
    }
  );

  tool(
    "mail_send",
    "Send a draft exactly as saved, from its own account, and keep a copy in Sent. Needs the draft's current revision. Never resend after an uncertain outcome: check Sent first.",
    { draftId: draftId(), revision: z.string().min(1).describe("The draft's current revision.") },
    "write",
    async (args) => {
      const account = await accountOf(args.draftId);
      if (account.kind === "gmail") {
        const { draft } = await checkedGmailDraft(args.draftId, args.revision);
        const sent = await needGmail().gmail.sendMessage(account.name, { draftId: draft });
        return {
          sent: true,
          account: account.name,
          id: gmailId("message", account.name, sent.id),
          threadId: gmailId("thread", account.name, sent.threadId),
          viewUrl: sent.viewUrl,
        };
      }
      const drafts = needIcloud().drafts;
      const result = args.draftId.startsWith("apple-draft:")
        ? await drafts.sendDraft(args.draftId, args.revision)
        : await drafts.sendImapDraft(args.draftId, args.revision);
      if (!result.success) throw new Error(result.error ?? "The draft was not sent.");
      return {
        sent: true,
        account: account.name,
        ...(result.sentMessageId && { id: result.sentMessageId }),
        ...(result.warning && { warning: result.warning }),
      };
    }
  );

  // ---------------------------------------------------------------- Organizing

  tool(
    "mail_update",
    "Mark, flag, label or move messages (or Gmail threads), in any accounts. moveTo takes inbox, archive, junk, trash, or a folder or Gmail label name; a moved iCloud message gets a new ID, returned when the server reports it. Labels are Gmail's; iCloud mail has folders.",
    {
      ids: z.array(messageId()).min(1).max(100),
      read: z.boolean().optional().describe("Mark read, or unread."),
      flagged: z.boolean().optional().describe("Flag (Gmail: star), or remove the flag."),
      addLabels: z.array(z.string().min(1)).max(20).optional().describe("Gmail label names."),
      removeLabels: z.array(z.string().min(1)).max(20).optional().describe("Gmail label names."),
      moveTo: z.string().min(1).optional(),
    },
    "write",
    async (args) => {
      const results: unknown[] = [];
      for (const id of args.ids as string[]) {
        try {
          const account = await accountOf(id);
          results.push(
            account.kind === "gmail"
              ? await updateGmail(account.name, id, args)
              : await updateIcloud(id, args)
          );
        } catch (error) {
          results.push({ id, error: (error as Error).message });
        }
      }
      return { results };
    }
  );

  async function updateGmail(account: string, id: string, args: any) {
    const { gmail } = needGmail();
    const parsed = parseGmailId(id)!;
    const kind = parsed.kind === "thread" ? "threads" : "messages";
    const add = await gmail.labelIdsFor(account, args.addLabels ?? []);
    const remove = await gmail.labelIdsFor(account, args.removeLabels ?? []);
    if (args.read !== undefined) (args.read ? remove : add).push("UNREAD");
    if (args.flagged !== undefined) (args.flagged ? add : remove).push("STARRED");
    const special = args.moveTo ? specialFolder(args.moveTo) : undefined;
    if (special === "inbox") {
      add.push("INBOX");
      remove.push("SPAM", "TRASH");
    } else if (special === "archive") {
      remove.push("INBOX");
    } else if (special === "junk") {
      add.push("SPAM");
      remove.push("INBOX");
    } else if (special && special !== "trash") {
      throw new Error(`Gmail mail cannot be moved to ${special}.`);
    } else if (args.moveTo && !special) {
      // Moving to a label, as Gmail does: label it and take it out of the inbox.
      add.push(...(await gmail.labelIdsFor(account, [args.moveTo])));
      remove.push("INBOX");
    }
    if (add.length || remove.length) {
      await gmail.modify(account, kind, parsed.id, [...new Set(add)], [...new Set(remove)]);
    }
    if (special === "trash") await gmail.trash(account, kind, parsed.id);
    return { id, updated: true };
  }

  async function updateIcloud(id: string, args: any) {
    const ctx = needIcloud();
    checkIcloudId(id);
    if (args.addLabels?.length || args.removeLabels?.length) {
      throw new Error("iCloud mail has folders, not labels; use moveTo.");
    }
    if (args.read !== undefined) {
      opResult(await (args.read ? imapMarkRead : imapMarkUnread)(id, ctx.imapDeps));
    }
    if (args.flagged !== undefined) {
      opResult(await (args.flagged ? imapFlagMessage : imapUnflagMessage)(id, ctx.imapDeps));
    }
    if (!args.moveTo) return { id, updated: true };
    const moved = opResult(
      await imapMoveMessageById(id, await icloudFolderPath(args.moveTo), ctx.imapDeps)
    );
    return { id, updated: true, ...(moved.id && { newId: moved.id }) };
  }

  tool(
    "mail_manage_folder",
    "Create, rename or delete a folder (an iCloud mailbox or a Gmail label). Deleting a Gmail label keeps its mail; deleting an iCloud mailbox deletes the mail in it.",
    {
      account: z
        .string()
        .min(1)
        .optional()
        .describe("The account, as in list_accounts; required when there are several."),
      action: z.enum(["create", "rename", "delete"]),
      name: z.string().min(1).max(225).describe("The folder, or the new folder's name; '/' nests."),
      newName: z.string().min(1).max(225).optional().describe("For rename."),
    },
    "destructive",
    async (args) => {
      const accounts = await mailAccounts(args.account ? [args.account] : undefined);
      if (accounts.length > 1) {
        throw new Error(`Give account, one of: ${accounts.map((item) => item.name).join(", ")}.`);
      }
      const [account] = accounts;
      if (args.action === "rename" && !args.newName) throw new Error("Give newName to rename.");
      if (account.kind === "icloud") {
        const deps = needIcloud().imapDeps;
        const result =
          args.action === "create"
            ? await imapCreateMailbox(args.name, deps)
            : args.action === "rename"
              ? await imapRenameMailbox(args.name, args.newName, deps)
              : await imapDeleteMailbox(args.name, deps);
        return { account: account.name, done: opResult(result).info };
      }
      const { gmail } = needGmail();
      if (args.action === "create") {
        const { label } = await gmail.createLabel(account.name, { displayName: args.name });
        return { account: account.name, created: label.name };
      }
      const [labelId] = await gmail.labelIdsFor(account.name, [args.name]);
      if (args.action === "rename") {
        const { label } = await gmail.updateLabel(account.name, {
          labelId,
          displayName: args.newName,
        });
        return { account: account.name, renamed: label.name };
      }
      await gmail.deleteLabel(account.name, labelId);
      return { account: account.name, deleted: args.name };
    }
  );

  // ---------------------------------------------------------------- Settings and status

  if (icloud) {
    tool(
      "mail_settings",
      "Show the sending settings: the primary address new drafts send from, the iCloud sending addresses, display names and saved signatures. Give fields to change them. Gmail send-as addresses are managed in Gmail, but can have saved signatures here.",
      {
        primaryAddress: z
          .string()
          .email()
          .optional()
          .describe("New primary address; one of the iCloud sending addresses."),
        addAddresses: emails("iCloud addresses to allow as senders."),
        removeAddresses: emails("iCloud addresses to stop sending from."),
        signature: z.string().max(4000).optional().describe("Saved signature; empty removes it."),
        signatureFrom: z
          .string()
          .email()
          .optional()
          .describe("Address the signature is for; default the primary address."),
        displayName: z
          .string()
          .max(100)
          .optional()
          .describe("Name recipients see, e.g. Shao Yu Huang; empty removes it."),
        displayNameFrom: z
          .string()
          .email()
          .optional()
          .describe("iCloud address the name is for; default every iCloud address."),
        refresh: z
          .boolean()
          .optional()
          .describe("Rescan Sent for sending addresses and the inbox for custom-domain ones now."),
      },
      "write",
      async (args) => {
        const ctx = needIcloud();
        if (args.primaryAddress || args.addAddresses?.length || args.removeAddresses?.length) {
          await ctx.saveSettings(applySettingsUpdate(ctx.settings, args));
        }
        if (args.signature !== undefined) {
          const from = args.signatureFrom ?? ctx.settings.primaryAddress;
          const others = (await sendsAs(icloudAccount!, from)) ? [] : await gmailAddresses();
          await ctx.saveSettings(applySignature(ctx.settings, from, args.signature, others));
        }
        if (args.displayName !== undefined) {
          const from = args.displayNameFrom ? icloudSender(args.displayNameFrom) : undefined;
          await ctx.saveSettings(applyDisplayName(ctx.settings, args.displayName, from));
        }
        let discovery: { newlyAdded: string[]; suggested: string[] } | undefined;
        let discoveryError: string | undefined;
        const stale = !(
          Date.now() - Date.parse(ctx.settings.discoveredAt ?? "") <
          DISCOVERY_INTERVAL_MS
        );
        if (args.refresh || (stale && process.env.ICLOUD_MAIL_ADDRESS_DISCOVERY !== "off")) {
          try {
            const sent = await imapScanHeaders("sent", ["From"], ctx.imapDeps, 500);
            const inbox = await imapScanHeaders(
              "inbox",
              ["Delivered-To", "X-Original-To", "To", "Cc"],
              ctx.imapDeps,
              300
            );
            const result = mergeDiscovered(
              ctx.settings,
              sent.flatMap((row) => addressesIn(row.From ?? "")),
              inbox.flatMap((row) => Object.values(row).flatMap(addressesIn))
            );
            await ctx.saveSettings(result.settings);
            discovery = { newlyAdded: result.added, suggested: result.suggested };
          } catch (error) {
            discoveryError = (error as Error).message;
          }
        }
        const settings = ctx.settings;
        return {
          primaryAddress: settings.primaryAddress,
          icloudAddresses: settings.addresses.map((address) => ({
            address,
            ...(displayNameFor(settings, address) && {
              displayName: displayNameFor(settings, address),
            }),
          })),
          signatures: settings.signatures,
          ...(settings.excluded.length && { removedByUser: settings.excluded }),
          ...discovery,
          ...(discoveryError && { discoveryError }),
        };
      }
    );
  }

  tool(
    "mail_health_check",
    "Check that every mail account connects: iCloud IMAP and SMTP sign-in, and each Gmail account's access. Sends nothing.",
    {},
    "read",
    async () => {
      const status: Record<string, unknown> = {};
      if (icloud) {
        try {
          await icloud.withImap((client) => client.noop());
          const cfg = resolveSmtpConfig();
          const smtp = icloud.tlsTransport({
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
            auth: { user: cfg.user, pass: cfg.pass },
          });
          try {
            await smtp.verify();
          } finally {
            smtp.close();
          }
          status[icloud.account] = "ok";
        } catch (error) {
          status[icloud.account] = (error as Error).message;
        }
      }
      for (const email of await gmailAccounts()) {
        try {
          await needGmail().gmail.profile(email);
          status[email] = "ok";
        } catch (error) {
          status[email] = (error as Error).message;
        }
      }
      return status;
    }
  );
}
