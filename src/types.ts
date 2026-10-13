/**
 * Shared types for the iCloud mail tools: messages, sending identities,
 * drafts and attachments.
 *
 * @module types
 */

/**
 * Provider-neutral full message resource returned by robust read tools.
 *
 * The public `messageId` remains the opaque connector handle used by follow-up
 * tools. IMAP UID and mailbox details stay internal.
 */
export interface MessageResource {
  messageId: string;
  rfcMessageId?: string;
  account: string;
  mailbox: string;
  from: string[];
  replyTo: string[];
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  date?: string;
  textBody: string;
  htmlBody?: string;
  attachments: Attachment[];
  flags: {
    isRead: boolean;
    isFlagged: boolean;
    isJunk?: boolean;
    isDeleted?: boolean;
  };
  /** Present only when the caller explicitly requests the original source. */
  rawMime?: string;
}

/**
 * A concrete From identity of the iCloud account.
 *
 * One account can have several sender aliases, each its own identity.
 */
export interface SendingIdentity {
  /** Opaque stable identifier returned to MCP callers */
  identityId: string;
  /** Stable account identifier */
  accountId: string;
  /** Account display name */
  accountName: string;
  /** Configured From address */
  email: string;
  /** Display name configured for the account */
  fullName: string;
  /** Fully formatted sender value, e.g. "Name <address>" */
  sender: string;
  /** Whether the receiving account is enabled */
  enabled: boolean;
  /** Whether this identity is the default sender */
  isDefault: boolean;
}

/**
 * A connector-managed iCloud draft. `draftId` remains stable across edits;
 * `nativeId` is the `imap:` id of its current server copy.
 */
export interface Draft {
  draftId: string;
  /** Content revision used for optimistic concurrency with edits made elsewhere. */
  revision: string;
  nativeId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Optional HTML alternative stored in the RFC 5322 draft. */
  htmlBody?: string;
  /** Whether the draft is still in the server Drafts mailbox, i.e. not yet sent. */
  visible: boolean;
  /** Whether this handle came from a saved Drafts mailbox or a live compose session. */
  sourceKind: "mailbox" | "compose" | "imap";
  /** Stable Mail account identifier for saved mailbox drafts. */
  accountId?: string;
  /** Mail account display name for saved mailbox drafts. */
  accountName?: string;
  /** Draft mailbox display name for saved mailbox drafts. */
  mailboxName?: string;
  /** RFC 5322 Message-ID for saved mailbox drafts when available. */
  messageId?: string;
  /** Reply threading preserved across IMAP draft edits and SMTP submission. */
  inReplyTo?: string;
  references?: string[];
  /** Whether Mail reports one or more attachments on this draft. */
  hasAttachments: boolean;
  /** Attachment metadata for IMAP/MIME drafts. */
  attachments?: Attachment[];
  /** Storage backend used by this draft resource. */
  backend?: "imap" | "applescript";
  /** Delivery state used to prevent automatic duplicate SMTP sends. */
  deliveryState?: "draft" | "sending" | "sent" | "needs_review";
}

/**
 * Represents an email attachment.
 */
export interface Attachment {
  /** Attachment identifier */
  id: string;

  /** Filename of the attachment */
  name: string;

  /** MIME type of the attachment */
  mimeType: string;

  /** Size in bytes */
  size: number;
}

/** An attachment sent inline: its bytes as base64, with a filename. */
export type AttachmentInput = { filename: string; contentBase64: string };
