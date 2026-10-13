import { randomUUID } from "crypto";
import type { AttachmentInput, Draft, SendingIdentity } from "@/types.js";
import {
  imapAppendRawMessage,
  imapDeleteExactMessage,
  imapFetchRawMessage,
  imapFindRawMessageByHeader,
  imapListMessagesWithHeader,
  imapSetKeyword,
  imapSpecialMailboxPath,
  isImapAccount,
  decodeImapId,
  type ImapDeps,
  type ImapRawMessage,
} from "@/services/imapClient.js";
import {
  composeDraftMime,
  DRAFT_ID_HEADER,
  draftIdFromMime,
  draftMimeRevision,
  mimeAttachmentsForResource,
  parseDraftMime,
  prepareDraftMimeForSend,
  type MimeDraftAttachment,
} from "@/services/mimeDraft.js";
import { sendRawViaSmtp, type SmtpConfig, type SmtpSendResult } from "@/services/smtpMailer.js";
import { buildReplyOptions, parseOriginalHeaders } from "@/services/replyForward.js";
import { z } from "zod";

const DRAFT_PREFIX = "apple-draft:";

/**
 * IMAP keyword left on a server draft while its SMTP submission is pending or
 * uncertain. Every device reads it, so a second device will not resend.
 */
export const SENDING_KEYWORD = "$IcloudMailSending";
const REMOTE_SENDING_WARNING =
  "Another device started sending this draft and its outcome is unknown. Verify Sent before taking further action.";

interface ImapDraftRegistryEntry {
  imapId: string;
  account: string;
  identityId: string;
  fromEmail: string;
  identitySender?: string;
  identityAccountId?: string;
  identityAccountName?: string;
  revision: string;
  messageId?: string;
  updatedAt: string;
  state: "draft" | "sending" | "sent" | "needs_review";
  smtpMessageId?: string;
  sentImapId?: string;
  warning?: string;
  /** Whether SENDING_KEYWORD was set on the server copy by this device. */
  remoteMarked?: boolean;
}

interface CurrentDraft {
  raw: Buffer;
  imapId: string;
  revision: string;
  /** The server copy carries SENDING_KEYWORD. */
  remoteSending: boolean;
}

interface ImapDraftRegistry {
  version: 1;
  drafts: Record<string, ImapDraftRegistryEntry>;
}

export interface ImapDraftCreateInput {
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  htmlBody?: string;
  attachments?: Array<AttachmentInput | MimeDraftAttachment>;
  inReplyTo?: string;
  references?: string[];
}

export interface ImapReplyInput {
  originalMessageId: string;
  body: string;
  from?: string;
  replyAll?: boolean;
  /** Opt in to quoting the original; otherwise preserve the supplied body exactly. */
  quoteOriginal?: boolean;
}

export interface ImapReplyPreviewResult {
  success: boolean;
  reply?: ImapDraftCreateInput;
  error?: string;
}

export interface ImapDraftUpdate {
  expectedRevision?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body?: string;
  htmlBody?: string | null;
  attachmentsToAdd?: Array<AttachmentInput | MimeDraftAttachment>;
  attachmentNamesToRemove?: string[];
}

export interface ImapDraftResult {
  success: boolean;
  draft?: Draft;
  error?: string;
  warning?: string;
  smtpMessageId?: string;
  sentMessageId?: string;
}

/**
 * The draft cache lives in memory for the manager's lifetime: the Drafts
 * mailbox and its send markers carry everything needed to recover.
 */
export interface ImapDraftManagerOptions {
  resolveIdentity: (selector?: string) => SendingIdentity | null;
  imapDeps?: (account: string) => ImapDeps;
  imapAccount?: (identity: SendingIdentity) => string;
  smtpConfig: (identity: SendingIdentity) => SmtpConfig;
  smtpSend?: typeof sendRawViaSmtp;
  sleep?: (ms: number) => Promise<void>;
  /** Configured aliases excluded from reply recipients, or a getter for the current ones. */
  selfAddresses?: string[] | (() => string[]);
}

function emptyRegistry(): ImapDraftRegistry {
  return { version: 1, drafts: {} };
}

function senderEmail(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

function draftUuid(draftId: string): string {
  return draftId.startsWith(DRAFT_PREFIX) ? draftId.slice(DRAFT_PREFIX.length) : "";
}

export class ImapDraftManager {
  private memory: ImapDraftRegistry = emptyRegistry();
  /**
   * Send state of drafts other clients created, keyed by Message-ID. The
   * server marker carries the same guard to other instances.
   */
  private imapSends = new Map<
    string,
    {
      state: ImapDraftRegistryEntry["state"];
      smtpMessageId?: string;
      sentImapId?: string;
      warning?: string;
    }
  >();
  private readonly identityResolver: (selector?: string) => SendingIdentity | null;
  private readonly depsForAccount: (account: string) => ImapDeps;
  private readonly accountForIdentity?: (identity: SendingIdentity) => string;
  private readonly smtpConfigResolver: (identity: SendingIdentity) => SmtpConfig;
  private readonly smtpSend: typeof sendRawViaSmtp;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly selfAddressList: () => string[];

  constructor(options: ImapDraftManagerOptions) {
    this.identityResolver = options.resolveIdentity;
    this.depsForAccount = options.imapDeps ?? ((account) => ({ account }));
    this.accountForIdentity = options.imapAccount;
    this.smtpConfigResolver = options.smtpConfig;
    this.smtpSend = options.smtpSend ?? sendRawViaSmtp;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const self = options.selfAddresses ?? [];
    this.selfAddressList = typeof self === "function" ? self : () => self;
  }

  private load(): ImapDraftRegistry {
    return structuredClone(this.memory);
  }

  /** Apply `change` to one cached entry, if it still exists, and persist it. */
  private patch(uuid: string, change: (entry: ImapDraftRegistryEntry) => void): void {
    const registry = this.load();
    const entry = registry.drafts[uuid];
    if (!entry) return;
    change(entry);
    entry.updatedAt = new Date().toISOString();
    this.save(registry);
  }

  private save(registry: ImapDraftRegistry): void {
    this.memory = structuredClone(registry);
  }

  owns(draftId: string): boolean {
    return Boolean(this.load().drafts[draftUuid(draftId)]);
  }

  private identityFor(selector?: string): SendingIdentity {
    const identity = this.identityResolver(selector);
    if (!identity?.enabled) {
      throw new Error(
        selector
          ? `Sending identity "${selector}" was not found or is disabled.`
          : "No enabled default sending identity is available."
      );
    }
    return identity;
  }

  private identityForEntry(entry: ImapDraftRegistryEntry): SendingIdentity {
    if (entry.identitySender && entry.identityAccountName) {
      return {
        identityId: entry.identityId,
        accountId: entry.identityAccountId ?? "",
        accountName: entry.identityAccountName,
        email: entry.fromEmail,
        fullName: "",
        sender: entry.identitySender,
        enabled: true,
        isDefault: false,
      };
    }
    return this.identityFor(entry.identityId || entry.fromEmail);
  }

  private imapAccountFor(identity: SendingIdentity): string {
    if (this.accountForIdentity) return this.accountForIdentity(identity);
    if (isImapAccount(identity.accountName)) return identity.accountName;
    if (isImapAccount(identity.email)) return identity.email;
    throw new Error(
      `No unambiguous IMAP profile matches ${identity.sender}. Configure account "${identity.accountName}" or address "${identity.email}" in APPLE_MAIL_MCP_IMAP_ACCOUNTS.`
    );
  }

  canCreate(selector?: string): boolean {
    try {
      const identity = this.identityFor(selector);
      this.imapAccountFor(identity);
      return true;
    } catch {
      return false;
    }
  }

  private defaultAccount(): string | null {
    try {
      return this.imapAccountFor(this.identityFor());
    } catch {
      return null;
    }
  }

  /**
   * The local registry is only a cache. A draft created or edited on another
   * device is recovered from its server copy through the connector draft header.
   */
  private async resolveEntry(uuid: string): Promise<ImapDraftRegistryEntry | null> {
    if (!uuid) return null;
    const cached = this.load().drafts[uuid];
    if (cached) return cached;
    const account = this.defaultAccount();
    if (!account) return null;
    const found = await imapFindRawMessageByHeader(
      "drafts",
      { name: DRAFT_ID_HEADER, value: uuid },
      this.depsForAccount(account)
    );
    return found ? this.adopt(uuid, found, account) : null;
  }

  /** Cache a server draft this device has not seen before. */
  private adopt(
    uuid: string,
    found: ImapRawMessage,
    account: string
  ): ImapDraftRegistryEntry | null {
    if (draftIdFromMime(found.raw) !== uuid) return null;
    const parsed = parseDraftMime(found.raw);
    const email = senderEmail(parsed.from);
    const identity = this.identityResolver(email);
    const sending = (found.flags ?? []).includes(SENDING_KEYWORD);
    const registry = this.load();
    registry.drafts[uuid] ??= {
      imapId: found.id,
      account,
      identityId: identity?.identityId ?? email,
      fromEmail: identity?.email ?? email,
      identitySender: identity?.sender,
      identityAccountId: identity?.accountId,
      identityAccountName: identity?.accountName,
      revision: draftMimeRevision(found.raw),
      messageId: parsed.messageId,
      updatedAt: new Date().toISOString(),
      state: sending ? "needs_review" : "draft",
      warning: sending ? REMOTE_SENDING_WARNING : undefined,
      remoteMarked: sending,
    };
    this.save(registry);
    return registry.drafts[uuid];
  }

  /**
   * Reconcile the cached send state with the marker devices leave on the
   * server copy: a marker means another device's send is unresolved, and a
   * marker this device set that has disappeared was resolved elsewhere.
   */
  private reconcileState(
    uuid: string,
    entry: ImapDraftRegistryEntry,
    current: CurrentDraft
  ): ImapDraftRegistryEntry["state"] {
    if (current.remoteSending && entry.state === "draft") {
      this.patch(uuid, (latest) => {
        latest.state = "needs_review";
        latest.warning = REMOTE_SENDING_WARNING;
        latest.remoteMarked = true;
      });
      return "needs_review";
    }
    if (!current.remoteSending && entry.state === "needs_review" && entry.remoteMarked) {
      this.patch(uuid, (latest) => {
        latest.state = "draft";
        latest.warning = undefined;
        latest.remoteMarked = false;
      });
      return "draft";
    }
    return entry.state;
  }

  /** Find a Sent copy of a draft whose server copy is gone, e.g. sent elsewhere. */
  private async findSentCopy(entry: ImapDraftRegistryEntry): Promise<ImapRawMessage | null> {
    if (!entry.messageId) return null;
    return imapFindRawMessageByHeader(
      "sent",
      { name: "Message-ID", value: entry.messageId },
      this.depsForAccount(entry.account)
    ).catch(() => null);
  }

  private markSent(uuid: string, sentCopy: ImapRawMessage, warning?: string): void {
    this.patch(uuid, (latest) => {
      latest.state = "sent";
      latest.sentImapId = sentCopy.id;
      latest.warning = warning;
      latest.remoteMarked = false;
    });
  }

  private async fetchCurrent(
    uuid: string,
    entry: ImapDraftRegistryEntry
  ): Promise<CurrentDraft | null> {
    const deps = this.depsForAccount(entry.account);
    let current = await imapFetchRawMessage(entry.imapId, deps);
    if (!current) {
      current = await imapFindRawMessageByHeader(
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        deps
      );
    }
    if (!current && entry.messageId) {
      current = await imapFindRawMessageByHeader(
        "drafts",
        { name: "Message-ID", value: entry.messageId },
        deps
      );
    }
    if (!current) return null;
    const revision = draftMimeRevision(current.raw);
    if (current.id !== entry.imapId || revision !== entry.revision) {
      this.patch(uuid, (latest) => {
        latest.imapId = current.id;
        latest.revision = revision;
      });
    }
    return {
      raw: current.raw,
      imapId: current.id,
      revision,
      remoteSending: (current.flags ?? []).includes(SENDING_KEYWORD),
    };
  }

  private toDraft(
    draftId: string,
    entry: ImapDraftRegistryEntry,
    raw: Buffer,
    imapId = entry.imapId
  ): Draft {
    const parsed = parseDraftMime(raw);
    return {
      draftId,
      revision: draftMimeRevision(raw),
      nativeId: imapId,
      from: parsed.from || entry.fromEmail,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      body: parsed.body,
      htmlBody: parsed.htmlBody,
      // A server draft shows in every mail client until it is sent.
      visible: entry.state !== "sent",
      sourceKind: "imap",
      accountName: entry.account,
      mailboxName: imapId,
      messageId: parsed.messageId ?? entry.messageId,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      hasAttachments: parsed.attachments.length > 0,
      attachments: mimeAttachmentsForResource(parsed, draftId),
      backend: "imap",
      deliveryState: entry.state,
    };
  }

  async listDrafts(): Promise<{ success: boolean; drafts?: Draft[]; error?: string }> {
    try {
      const account = this.defaultAccount();
      const uuids = new Set<string>();
      // The server is authoritative: list every connector draft, including
      // those created on other devices, then any cached ones in other accounts.
      if (account) {
        const matches = await imapListMessagesWithHeader(
          "drafts",
          DRAFT_ID_HEADER,
          this.depsForAccount(account)
        );
        for (const match of matches) uuids.add(match.value);
      }
      for (const [uuid, entry] of Object.entries(this.load().drafts)) {
        if (entry.state !== "sent" && entry.account !== account) uuids.add(uuid);
      }
      const drafts: Draft[] = [];
      for (const uuid of uuids) {
        const entry = await this.resolveEntry(uuid);
        if (!entry || entry.state === "sent") continue;
        const current = await this.fetchCurrent(uuid, entry);
        if (!current) continue;
        const state = this.reconcileState(uuid, entry, current);
        drafts.push(
          this.toDraft(
            `${DRAFT_PREFIX}${uuid}`,
            { ...entry, state, revision: current.revision },
            current.raw,
            current.imapId
          )
        );
      }
      return { success: true, drafts };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getDraft(draftId: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const entry = await this.resolveEntry(uuid);
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        const sentCopy = entry.state === "sent" ? null : await this.findSentCopy(entry);
        if (sentCopy) {
          this.markSent(uuid, sentCopy);
          return {
            success: false,
            error: `Draft "${draftId}" was already sent, possibly from another device.`,
            sentMessageId: sentCopy.id,
          };
        }
        return {
          success: false,
          error: `Draft "${draftId}" no longer exists in the server Drafts mailbox.`,
        };
      }
      const state = this.reconcileState(uuid, entry, current);
      return {
        success: true,
        draft: this.toDraft(
          draftId,
          { ...entry, state, revision: current.revision },
          current.raw,
          current.imapId
        ),
        warning: state === entry.state ? entry.warning : this.load().drafts[uuid]?.warning,
        smtpMessageId: entry.smtpMessageId,
        sentMessageId: entry.sentImapId,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Resolve a reply from server headers without writing or sending anything. */
  async previewReply(input: ImapReplyInput): Promise<ImapReplyPreviewResult> {
    try {
      const identity = this.identityFor(input.from);
      const account = this.imapAccountFor(identity);
      const ref = decodeImapId(input.originalMessageId);
      if (!ref || ref.account !== account || !Number.isSafeInteger(ref.uid) || ref.uid < 1) {
        throw new Error("Reply source must be a message in the selected IMAP account.");
      }
      const source = await imapFetchRawMessage(
        input.originalMessageId,
        this.depsForAccount(account)
      );
      if (!source) throw new Error("The original message was not found on the IMAP server.");
      const original = parseOriginalHeaders(source.raw.toString("utf8"));
      if (!original.messageId || !/^<[^<>\s]+@[^<>\s]+>$/.test(original.messageId)) {
        throw new Error(
          "The original message has no valid Message-ID; a threaded reply cannot be created."
        );
      }
      const decoded = parseDraftMime(source.raw);
      original.subject = decoded.subject;
      const self = [...this.selfAddressList(), identity.email];
      const selfSet = new Set(self.map((address) => address.toLowerCase()));
      const sentBySelf =
        original.from.length > 0 &&
        original.from.every((address) => selfSet.has(address.toLowerCase()));
      const recipients = sentBySelf
        ? original.to
        : original.replyTo.length
          ? original.replyTo
          : original.from;
      original.replyTo = recipients.filter((address) => !selfSet.has(address.toLowerCase()));
      if (!original.replyTo.length)
        throw new Error("The original message has no non-self reply recipient.");
      const reply = buildReplyOptions({
        original,
        originalPlainText: input.quoteOriginal ? decoded.body : "",
        body: input.body,
        replyAll: input.replyAll ?? false,
        self,
        from: identity.email,
      });
      for (const address of [...reply.to, ...(reply.cc ?? [])]) {
        if (!z.string().email().safeParse(address).success)
          throw new Error("The original message contains an invalid reply address.");
      }
      // Message-ID values are case-sensitive. Preserve the parent's full chain.
      reply.references = [...new Set([...original.references, original.messageId])];
      if (reply.references.some((value) => !/^<[^<>\s]+@[^<>\s]+>$/.test(value))) {
        throw new Error("The original message contains invalid threading headers.");
      }
      return { success: true, reply };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async createReplyDraft(input: ImapReplyInput): Promise<ImapDraftResult> {
    const preview = await this.previewReply(input);
    if (!preview.success || !preview.reply) return { success: false, error: preview.error };
    return this.createDraft(preview.reply);
  }

  async createDraft(input: ImapDraftCreateInput): Promise<ImapDraftResult> {
    try {
      const identity = this.identityFor(input.from);
      const account = this.imapAccountFor(identity);
      const uuid = randomUUID();
      const raw = await composeDraftMime({
        draftUuid: uuid,
        from: identity.sender,
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        body: input.body,
        htmlBody: input.htmlBody,
        attachments: input.attachments,
        inReplyTo: input.inReplyTo,
        references: input.references,
      });
      const appended = await imapAppendRawMessage(
        raw,
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        this.depsForAccount(account)
      );
      const verified = await imapFetchRawMessage(appended.id, this.depsForAccount(account));
      if (!verified) {
        throw new Error("Draft was appended, but its exact server copy could not be verified.");
      }
      const draftId = `${DRAFT_PREFIX}${uuid}`;
      const parsed = parseDraftMime(verified.raw);
      const entry: ImapDraftRegistryEntry = {
        imapId: appended.id,
        account,
        identityId: identity.identityId,
        fromEmail: identity.email,
        identitySender: identity.sender,
        identityAccountId: identity.accountId,
        identityAccountName: identity.accountName,
        revision: draftMimeRevision(verified.raw),
        messageId: parsed.messageId,
        updatedAt: new Date().toISOString(),
        state: "draft",
      };
      const registry = this.load();
      registry.drafts[uuid] = entry;
      this.save(registry);
      return {
        success: true,
        draft: this.toDraft(draftId, entry, verified.raw),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async updateDraft(draftId: string, update: ImapDraftUpdate): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const entry = await this.resolveEntry(uuid);
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state !== "draft" && entry.state !== "needs_review") {
        return {
          success: false,
          error: `Draft "${draftId}" is ${entry.state} and cannot be edited automatically.`,
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        return { success: false, error: `Draft "${draftId}" was not found on the IMAP server.` };
      }
      const state = this.reconcileState(uuid, entry, current);
      if (state !== "draft") {
        return {
          success: false,
          error: `Draft "${draftId}" is ${state} and cannot be edited automatically.`,
        };
      }
      if (update.expectedRevision && update.expectedRevision !== current.revision) {
        return {
          success: false,
          error: `Draft revision conflict: expected ${update.expectedRevision}, current revision is ${current.revision}. Read the draft again before editing.`,
        };
      }

      const parsed = parseDraftMime(current.raw);
      const identity = update.from ? this.identityFor(update.from) : this.identityForEntry(entry);
      const account = this.imapAccountFor(identity);
      const removeNames = new Set(update.attachmentNamesToRemove ?? []);
      const preserved: MimeDraftAttachment[] = parsed.attachments.filter(
        (attachment) => !removeNames.has(attachment.filename)
      );
      const nextRaw = await composeDraftMime({
        draftUuid: uuid,
        from: identity.sender,
        to: update.to ?? parsed.to,
        cc: update.cc ?? parsed.cc,
        bcc: update.bcc ?? parsed.bcc,
        subject: update.subject ?? parsed.subject,
        body: update.body ?? parsed.body,
        htmlBody: update.htmlBody === null ? undefined : (update.htmlBody ?? parsed.htmlBody),
        attachments: [...preserved, ...(update.attachmentsToAdd ?? [])],
        messageId: parsed.messageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
      });
      const appended = await imapAppendRawMessage(
        nextRaw,
        "drafts",
        { name: DRAFT_ID_HEADER, value: uuid },
        this.depsForAccount(account)
      );
      const verified = await imapFetchRawMessage(appended.id, this.depsForAccount(account));
      if (!verified) {
        throw new Error(
          "Updated draft was appended, but its exact server copy could not be verified; the original was kept."
        );
      }

      const latestRegistry = this.load();
      const latest = latestRegistry.drafts[uuid];
      if (!latest || latest.imapId !== current.imapId) {
        await imapDeleteExactMessage(appended.id, this.depsForAccount(account)).catch(() => false);
        return {
          success: false,
          error: "Draft changed concurrently; the replacement was discarded. Read it again.",
        };
      }
      const nextParsed = parseDraftMime(verified.raw);
      const nextEntry: ImapDraftRegistryEntry = {
        ...latest,
        imapId: appended.id,
        account,
        identityId: identity.identityId,
        fromEmail: identity.email,
        identitySender: identity.sender,
        identityAccountId: identity.accountId,
        identityAccountName: identity.accountName,
        revision: draftMimeRevision(verified.raw),
        messageId: nextParsed.messageId,
        updatedAt: new Date().toISOString(),
        warning: undefined,
      };
      latestRegistry.drafts[uuid] = nextEntry;
      this.save(latestRegistry);

      let warning: string | undefined;
      const oldDeleted = await imapDeleteExactMessage(
        current.imapId,
        this.depsForAccount(entry.account)
      ).catch(() => false);
      if (!oldDeleted) {
        warning =
          "The updated draft is saved, but the older server copy could not be removed and may briefly appear as a duplicate.";
        const after = this.load();
        if (after.drafts[uuid]) after.drafts[uuid].warning = warning;
        this.save(after);
      }
      return {
        success: true,
        draft: this.toDraft(draftId, nextEntry, verified.raw),
        warning,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async sendDraft(draftId: string, expectedRevision?: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      let registry: ImapDraftRegistry;
      const entry = await this.resolveEntry(uuid);
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      const duplicateRisk = {
        success: false,
        error: `Draft "${draftId}" previously entered the sending state. It was not retried to avoid a duplicate; verify Sent before taking further action.`,
      };
      if (entry.state === "sending") return duplicateRisk;
      if (entry.state === "sent") {
        return {
          success: true,
          smtpMessageId: entry.smtpMessageId,
          sentMessageId: entry.sentImapId,
          warning: "This draft was already sent; no second SMTP submission occurred.",
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      if (!current) {
        const sentCopy = await this.findSentCopy(entry);
        if (sentCopy) {
          this.markSent(uuid, sentCopy);
          return {
            success: true,
            sentMessageId: sentCopy.id,
            warning:
              "This draft was already sent, possibly from another device; no second SMTP submission occurred.",
          };
        }
        return { success: false, error: `Draft "${draftId}" was not found on the IMAP server.` };
      }
      const parsed = parseDraftMime(current.raw);
      const deps = this.depsForAccount(entry.account);
      // A Sent copy with this Message-ID means some device already submitted
      // it and only its Drafts cleanup failed.
      const priorSend = await this.findSentCopy({ ...entry, messageId: parsed.messageId });
      if (priorSend) {
        const removed = await imapDeleteExactMessage(current.imapId, deps).catch(() => false);
        const warning = `This draft is already in Sent; no second SMTP submission occurred.${
          removed ? "" : " The leftover Drafts copy could not be removed."
        }`;
        this.markSent(uuid, priorSend, warning);
        return { success: true, sentMessageId: priorSend.id, warning };
      }
      if (this.reconcileState(uuid, entry, current) !== "draft") return duplicateRisk;
      if (expectedRevision && expectedRevision !== current.revision) {
        return {
          success: false,
          error: `Draft revision conflict: expected ${expectedRevision}, current revision is ${current.revision}. Read the draft again before sending.`,
        };
      }
      const recipients = [...parsed.to, ...parsed.cc, ...parsed.bcc];
      if (recipients.length === 0) {
        return { success: false, error: `Draft "${draftId}" has no recipients.` };
      }
      const identity = this.identityForEntry(entry);
      if (senderEmail(parsed.from) !== identity.email.toLowerCase()) {
        return {
          success: false,
          error: `Draft From changed to "${parsed.from}" and no longer matches its reviewed identity "${identity.email}".`,
        };
      }
      const config = this.smtpConfigResolver(identity);

      registry = this.load();
      if (registry.drafts[uuid]?.imapId !== current.imapId) {
        return {
          success: false,
          error: "Draft changed concurrently before send; read it again.",
        };
      }
      registry.drafts[uuid].state = "sending";
      registry.drafts[uuid].updatedAt = new Date().toISOString();
      this.save(registry);
      const marked = await imapSetKeyword(current.imapId, SENDING_KEYWORD, true, deps)
        .then((result) => result.success)
        .catch(() => false);
      this.patch(uuid, (latest) => {
        latest.remoteMarked = marked;
      });

      const deliverable = prepareDraftMimeForSend(current.raw);
      let sent: SmtpSendResult;
      try {
        sent = await this.smtpSend(
          deliverable,
          { from: identity.email, to: recipients.map(senderEmail) },
          config
        );
      } catch (error) {
        sent = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          uncertain: true,
        };
      }
      if (!sent.success) {
        // A definite rejection leaves the draft editable everywhere; an
        // uncertain outcome keeps the server marker for every device.
        const cleared =
          !sent.uncertain &&
          marked &&
          (await imapSetKeyword(current.imapId, SENDING_KEYWORD, false, deps)
            .then((result) => result.success)
            .catch(() => false));
        this.patch(uuid, (latest) => {
          if (latest.state !== "sending") return;
          latest.state = sent.uncertain ? "needs_review" : "draft";
          latest.warning = sent.error;
          if (cleared) latest.remoteMarked = false;
        });
        return {
          success: false,
          error: sent.uncertain
            ? `${sent.error ?? "SMTP outcome is uncertain."} Verify Sent before retrying.`
            : (sent.error ?? "SMTP send failed."),
        };
      }

      registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].state = "sent";
        registry.drafts[uuid].smtpMessageId = sent.messageId;
        registry.drafts[uuid].updatedAt = new Date().toISOString();
        this.save(registry);
      }

      const { sentCopy, warning } = await this.finishSend(
        deliverable,
        parsed.messageId,
        current.imapId,
        entry.account
      );
      registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].sentImapId = sentCopy?.id;
        registry.drafts[uuid].warning = warning;
        this.save(registry);
      }
      return {
        success: true,
        draft: this.toDraft(
          draftId,
          { ...entry, state: "sent", revision: current.revision },
          current.raw,
          current.imapId
        ),
        smtpMessageId: sent.messageId,
        sentMessageId: sentCopy?.id,
        warning,
      };
    } catch (error) {
      const uuid = draftUuid(draftId);
      try {
        const registry = this.load();
        if (registry.drafts[uuid]?.state === "sending") {
          registry.drafts[uuid].state = "needs_review";
          registry.drafts[uuid].warning =
            "Sending outcome is uncertain. Verify Sent before retrying.";
          this.save(registry);
        }
      } catch {
        // Preserve the original failure.
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * After SMTP accepted a draft: make sure Sent holds a copy, then remove the
   * Drafts copy. Neither step submits mail again.
   */
  private async finishSend(
    deliverable: Buffer,
    messageId: string | undefined,
    draftImapId: string,
    account: string
  ): Promise<{ sentCopy: ImapRawMessage | null; warning?: string }> {
    const deps = this.depsForAccount(account);
    const findSent = () =>
      messageId
        ? imapFindRawMessageByHeader("sent", { name: "Message-ID", value: messageId }, deps).catch(
            () => null
          )
        : Promise.resolve(null);
    let sentCopy = await findSent();
    for (let attempt = 0; !sentCopy && messageId && attempt < 2; attempt += 1) {
      await this.sleep(500);
      sentCopy = await findSent();
    }

    let warning: string | undefined;
    if (!sentCopy && messageId) {
      sentCopy = await imapAppendRawMessage(
        deliverable,
        "sent",
        { name: "Message-ID", value: messageId },
        deps
      ).catch(() => null);
      if (!sentCopy) {
        warning =
          "SMTP accepted the message, but the connector could not verify or append its Sent copy.";
      }
    }
    const draftDeleted = await imapDeleteExactMessage(draftImapId, deps).catch(() => false);
    if (!draftDeleted) {
      warning = warning
        ? `${warning} The original Drafts copy also could not be removed.`
        : "SMTP accepted the message, but the original Drafts copy could not be removed.";
    }
    return { sentCopy, warning };
  }

  /**
   * Load a message from the server Drafts mailbox by its imap: id. Returns
   * the connector draft id instead when the message is a managed draft.
   */
  private async loadImapDraft(
    imapId: string
  ): Promise<
    | { managedId: string }
    | { account: string; current: ImapRawMessage; parsed: ReturnType<typeof parseDraftMime> }
    | { error: string }
  > {
    const ref = decodeImapId(imapId);
    const account = this.defaultAccount();
    if (!ref || !account || ref.account !== account) {
      return { error: "Use a Drafts message ID returned by this connector's iCloud account." };
    }
    const deps = this.depsForAccount(account);
    const draftsPath = await imapSpecialMailboxPath("drafts", deps);
    if (ref.path !== draftsPath) {
      return {
        error: `"${imapId}" is in "${ref.path}", not the Drafts mailbox; only drafts can be sent.`,
      };
    }
    const current = await imapFetchRawMessage(imapId, deps);
    if (!current) {
      return {
        error: `Draft "${imapId}" no longer exists in the server Drafts mailbox; search Drafts and Sent for its current state.`,
      };
    }
    const uuid = draftIdFromMime(current.raw);
    if (uuid) return { managedId: `${DRAFT_PREFIX}${uuid}` };
    return { account, current, parsed: parseDraftMime(current.raw) };
  }

  /** The cache entry an IMAP draft would have, for building its Draft resource. */
  private imapDraftEntry(
    account: string,
    current: ImapRawMessage,
    parsed: ReturnType<typeof parseDraftMime>,
    state: ImapDraftRegistryEntry["state"]
  ): ImapDraftRegistryEntry {
    const email = senderEmail(parsed.from);
    return {
      imapId: current.id,
      account,
      identityId: email,
      fromEmail: email,
      revision: draftMimeRevision(current.raw),
      messageId: parsed.messageId,
      updatedAt: new Date().toISOString(),
      state,
    };
  }

  private imapDraftState(
    current: ImapRawMessage,
    parsed: ReturnType<typeof parseDraftMime>
  ): ImapDraftRegistryEntry["state"] {
    const local = parsed.messageId ? this.imapSends.get(parsed.messageId) : undefined;
    if (local) return local.state;
    return (current.flags ?? []).includes(SENDING_KEYWORD) ? "needs_review" : "draft";
  }

  /** Read any draft in the server Drafts mailbox by its imap: id. */
  async getImapDraft(imapId: string): Promise<ImapDraftResult> {
    try {
      const loaded = await this.loadImapDraft(imapId);
      if ("error" in loaded) return { success: false, error: loaded.error };
      if ("managedId" in loaded) return this.getDraft(loaded.managedId);
      const { account, current, parsed } = loaded;
      const state = this.imapDraftState(current, parsed);
      return {
        success: true,
        draft: this.toDraft(
          imapId,
          this.imapDraftEntry(account, current, parsed, state),
          current.raw
        ),
        warning:
          state === "draft"
            ? undefined
            : ((parsed.messageId && this.imapSends.get(parsed.messageId)?.warning) ??
              REMOTE_SENDING_WARNING),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Send a draft that another client saved in the server Drafts mailbox,
   * exactly as written: only Bcc is withheld from the delivered headers. A
   * connector-managed draft is sent through sendDraft. The Drafts copy is
   * removed only after SMTP accepts the message.
   */
  async sendImapDraft(imapId: string, expectedRevision?: string): Promise<ImapDraftResult> {
    let messageId: string | undefined;
    try {
      const loaded = await this.loadImapDraft(imapId);
      if ("error" in loaded) return { success: false, error: loaded.error };
      if ("managedId" in loaded) return this.sendDraft(loaded.managedId, expectedRevision);
      const { account, current, parsed } = loaded;
      const deps = this.depsForAccount(account);
      messageId = parsed.messageId;
      if (!messageId) {
        return {
          success: false,
          error: `Draft "${imapId}" has no Message-ID, so its Sent copy could not be matched; it was not sent.`,
        };
      }
      const local = this.imapSends.get(messageId);
      if (local?.state === "sent") {
        return {
          success: true,
          smtpMessageId: local.smtpMessageId,
          sentMessageId: local.sentImapId,
          warning: "This draft was already sent; no second SMTP submission occurred.",
        };
      }
      const duplicateRisk = {
        success: false,
        error: `Draft "${imapId}" previously entered the sending state. It was not retried to avoid a duplicate; verify Sent before taking further action.`,
      };
      if (this.imapDraftState(current, parsed) !== "draft") return duplicateRisk;

      // Some client already submitted this message; only its Drafts cleanup is left.
      const priorSend = await imapFindRawMessageByHeader(
        "sent",
        { name: "Message-ID", value: messageId },
        deps
      ).catch(() => null);
      if (priorSend) {
        const removed = await imapDeleteExactMessage(current.id, deps).catch(() => false);
        const warning = `This draft is already in Sent; no second SMTP submission occurred.${
          removed ? "" : " The leftover Drafts copy could not be removed."
        }`;
        this.imapSends.set(messageId, { state: "sent", sentImapId: priorSend.id, warning });
        return { success: true, sentMessageId: priorSend.id, warning };
      }
      const revision = draftMimeRevision(current.raw);
      if (expectedRevision && expectedRevision !== revision) {
        return {
          success: false,
          error: `Draft revision conflict: expected ${expectedRevision}, current revision is ${revision}. Read the draft again before sending.`,
        };
      }
      const recipients = [...parsed.to, ...parsed.cc, ...parsed.bcc];
      if (recipients.length === 0) {
        return { success: false, error: `Draft "${imapId}" has no recipients.` };
      }
      if (!parsed.from) {
        return { success: false, error: `Draft "${imapId}" has no From address.` };
      }
      const identity = this.identityFor(senderEmail(parsed.from));
      const config = this.smtpConfigResolver(identity);

      this.imapSends.set(messageId, { state: "sending" });
      const marked = await imapSetKeyword(current.id, SENDING_KEYWORD, true, deps)
        .then((result) => result.success)
        .catch(() => false);
      const deliverable = prepareDraftMimeForSend(current.raw);
      let sent: SmtpSendResult;
      try {
        sent = await this.smtpSend(
          deliverable,
          { from: identity.email, to: recipients.map(senderEmail) },
          config
        );
      } catch (error) {
        sent = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          uncertain: true,
        };
      }
      if (!sent.success) {
        if (sent.uncertain) {
          this.imapSends.set(messageId, { state: "needs_review", warning: sent.error });
        } else {
          // A definite rejection leaves the draft sendable again everywhere.
          if (marked) {
            await imapSetKeyword(current.id, SENDING_KEYWORD, false, deps).catch(() => undefined);
          }
          this.imapSends.delete(messageId);
        }
        return {
          success: false,
          error: sent.uncertain
            ? `${sent.error ?? "SMTP outcome is uncertain."} Verify Sent before retrying.`
            : (sent.error ?? "SMTP send failed."),
        };
      }

      this.imapSends.set(messageId, { state: "sent", smtpMessageId: sent.messageId });
      const { sentCopy, warning } = await this.finishSend(
        deliverable,
        messageId,
        current.id,
        account
      );
      this.imapSends.set(messageId, {
        state: "sent",
        smtpMessageId: sent.messageId,
        sentImapId: sentCopy?.id,
        warning,
      });
      return {
        success: true,
        draft: this.toDraft(
          imapId,
          this.imapDraftEntry(account, current, parsed, "sent"),
          current.raw
        ),
        smtpMessageId: sent.messageId,
        sentMessageId: sentCopy?.id,
        warning,
      };
    } catch (error) {
      if (messageId && this.imapSends.get(messageId)?.state === "sending") {
        this.imapSends.set(messageId, {
          state: "needs_review",
          warning: "Sending outcome is uncertain. Verify Sent before retrying.",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async deleteDraft(draftId: string): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const entry = await this.resolveEntry(uuid);
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state === "sending") {
        return {
          success: false,
          error: `Draft "${draftId}" is sending and cannot be deleted safely.`,
        };
      }
      const current = await this.fetchCurrent(uuid, entry);
      const draft = current ? this.toDraft(draftId, entry, current.raw, current.imapId) : undefined;
      if (current) {
        const deleted = await imapDeleteExactMessage(
          current.imapId,
          this.depsForAccount(entry.account)
        );
        if (!deleted) {
          return { success: false, error: `IMAP server refused to delete draft "${draftId}".` };
        }
      }
      const latest = this.load();
      delete latest.drafts[uuid];
      this.save(latest);
      return { success: true, draft };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Manual recovery for an uncertain SMTP outcome. This never submits mail:
   * it only records the user's verified Sent/not-Sent decision.
   */
  async resolveUncertainSend(
    draftId: string,
    outcome: "sent" | "not_sent"
  ): Promise<ImapDraftResult> {
    try {
      const uuid = draftUuid(draftId);
      const entry = await this.resolveEntry(uuid);
      if (!entry) return { success: false, error: `Draft "${draftId}" was not found.` };
      if (entry.state !== "sending" && entry.state !== "needs_review") {
        return {
          success: false,
          error: `Draft "${draftId}" is ${entry.state}; no uncertain send needs resolution.`,
        };
      }
      if (outcome === "not_sent") {
        const current = await this.fetchCurrent(uuid, entry);
        if (current?.remoteSending) {
          const cleared = await imapSetKeyword(
            current.imapId,
            SENDING_KEYWORD,
            false,
            this.depsForAccount(entry.account)
          );
          if (!cleared.success) {
            return {
              success: false,
              error: `The server send marker could not be cleared: ${cleared.error}`,
            };
          }
        }
        this.patch(uuid, (latest) => {
          latest.state = "draft";
          latest.warning = undefined;
          latest.remoteMarked = false;
        });
        return this.getDraft(draftId);
      }

      const sentCopy = entry.messageId
        ? await imapFindRawMessageByHeader(
            "sent",
            { name: "Message-ID", value: entry.messageId },
            this.depsForAccount(entry.account)
          ).catch(() => null)
        : null;
      const current = await this.fetchCurrent(uuid, entry);
      if (current) {
        await imapDeleteExactMessage(current.imapId, this.depsForAccount(entry.account)).catch(
          () => false
        );
      }
      const registry = this.load();
      if (registry.drafts[uuid]) {
        registry.drafts[uuid].state = "sent";
        registry.drafts[uuid].sentImapId = sentCopy?.id;
        registry.drafts[uuid].warning = sentCopy
          ? undefined
          : "Marked sent after manual verification; no matching IMAP Sent copy was found.";
        registry.drafts[uuid].updatedAt = new Date().toISOString();
        this.save(registry);
      }
      return {
        success: true,
        sentMessageId: sentCopy?.id ?? entry.sentImapId,
        warning: registry.drafts[uuid]?.warning,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
