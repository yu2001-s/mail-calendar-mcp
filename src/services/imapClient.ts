/**
 * IMAP access to iCloud mail: search, read, flag, move and the raw message
 * operations behind drafts, keyed by the composite `imap:` id the read path
 * emits (see encodeImapId/decodeImapId below).
 *
 * Configured from the environment:
 *   APPLE_MAIL_MCP_IMAP_USER      (required; the login address)
 *   APPLE_MAIL_MCP_IMAP_ACCOUNT   (account label used in ids; default = USER)
 *   APPLE_MAIL_MCP_IMAP_HOST      (default imap.gmail.com)
 *   APPLE_MAIL_MCP_IMAP_PORT      (default 993, implicit TLS)
 *   APPLE_MAIL_MCP_IMAP_PASSWORD  (an app-specific password)
 *
 * @module services/imapClient
 */
import { ImapFlow } from "@/services/imapFlow.js";
import { SETUP_HINT } from "@/utils/docsUrls.js";
import { extractHtmlBody, extractTextBody } from "@/utils/mimeParse.js";
import type { MessageResource } from "@/types.js";

export const IMAP_ENV = {
  user: "APPLE_MAIL_MCP_IMAP_USER",
  account: "APPLE_MAIL_MCP_IMAP_ACCOUNT",
  host: "APPLE_MAIL_MCP_IMAP_HOST",
  port: "APPLE_MAIL_MCP_IMAP_PORT",
  password: "APPLE_MAIL_MCP_IMAP_PASSWORD",
  // JSON array of additional accounts, e.g.
  // [{"account":"Work","user":"me@co.com","host":"imap.co.com","password":"..."}]
  accounts: "APPLE_MAIL_MCP_IMAP_ACCOUNTS",
} as const;

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  accountLabel: string;
}

export interface ImapSearchArgs {
  query?: string;
  account?: string;
  from?: string;
  subject?: string;
  mailbox?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
  isRead?: boolean;
  isFlagged?: boolean;
  unreadOnly?: boolean;
  offset?: number;
}

interface ImapAddress {
  name?: string;
  address?: string;
}
interface ImapEnvelope {
  subject?: string;
  date?: Date | string;
  from?: ImapAddress[];
  replyTo?: ImapAddress[];
  to?: ImapAddress[];
  cc?: ImapAddress[];
  bcc?: ImapAddress[];
  messageId?: string;
  inReplyTo?: string;
}
export interface ImapBodyStructure {
  part?: string; // IMAP section id, e.g. "2" or "1.2"
  type?: string; // MIME type, e.g. "image/png" or "multipart/mixed"
  disposition?: string; // "attachment" | "inline"
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  encoding?: string;
  childNodes?: ImapBodyStructure[];
}
interface ImapMessage {
  uid: number;
  envelope?: ImapEnvelope;
  flags?: Set<string>;
  source?: Buffer | string;
  bodyStructure?: ImapBodyStructure;
  headers?: Buffer | string;
}
interface ImapDownload {
  meta?: { filename?: string; contentType?: string };
  content: AsyncIterable<Uint8Array>;
}
interface MailboxLock {
  release: () => void;
}
interface ImapMailboxListing {
  path: string;
  name: string;
  /** RFC 6154 special-use flag ("\\Trash", "\\Sent", …) when the server advertises it. */
  specialUse?: string;
}
interface ImapAppendResponse {
  destination: string;
  uidValidity?: bigint;
  uid?: number;
  seq?: number;
}
type FlagOpts = { uid: boolean };
export interface ImapClientLike {
  connect(): Promise<void>;
  getMailboxLock(path: string): Promise<MailboxLock>;
  search(query: Record<string, unknown>, opts: { uid: true }): Promise<number[] | false>;
  fetch(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: true }
  ): AsyncIterable<ImapMessage>;
  fetchOne(
    range: string,
    query: Record<string, unknown>,
    opts: { uid: true }
  ): Promise<ImapMessage | false>;
  list(): Promise<ImapMailboxListing[]>;
  status(
    path: string,
    query: { messages?: boolean; unseen?: boolean; recent?: boolean }
  ): Promise<{ path: string; messages?: number; unseen?: number; recent?: number }>;
  download(range: string, part: string, opts: { uid: true }): Promise<ImapDownload>;
  mailboxCreate(path: string): Promise<{ path: string; created: boolean }>;
  mailboxRename(path: string, newPath: string): Promise<{ path: string; newPath: string }>;
  mailboxDelete(path: string): Promise<{ path: string }>;
  append?(
    path: string,
    content: string | Buffer,
    flags?: string[],
    idate?: Date | string
  ): Promise<ImapAppendResponse | false>;
  messageFlagsAdd(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
  messageFlagsRemove(range: number[], flags: string[], opts: FlagOpts): Promise<boolean>;
  messageMove(range: number[], destination: string, opts: FlagOpts): Promise<unknown>;
  messageDelete(range: number[], opts: FlagOpts): Promise<boolean>;
  noop(): Promise<void>;
  logout(): Promise<void>;
  /** Hard socket teardown (ImapFlow.close): destroys the connection even when a
   *  graceful logout() can't complete on a half-closed socket. Optional so test
   *  mocks needn't implement it. */
  close?(): void;
}

// ---------------------------------------------------------------------------
// Composite IMAP message id (Phase 3): a self-describing token the IMAP read
// path emits so the same id round-trips back to get-message and the message
// mutations. AppleScript message ids are bare numbers; an IMAP id is
// `imap:<base64url({a:account,p:mailboxPath,u:uid})>`. UIDs are per-mailbox, so
// the mailbox path must travel with the uid. base64url keeps it schema-safe.
// ---------------------------------------------------------------------------
export function encodeImapId(account: string, path: string, uid: number): string {
  const payload = Buffer.from(JSON.stringify({ a: account, p: path, u: uid }), "utf8").toString(
    "base64url"
  );
  return `imap:${payload}`;
}

export function decodeImapId(id: string): { account: string; path: string; uid: number } | null {
  if (!id || !id.startsWith("imap:")) return null;
  try {
    const obj = JSON.parse(Buffer.from(id.slice("imap:".length), "base64url").toString("utf8"));
    if (typeof obj.u !== "number" || typeof obj.p !== "string") return null;
    return { account: String(obj.a ?? ""), path: obj.p, uid: obj.u };
  } catch {
    return null;
  }
}

export type ImapConnect = (cfg: ImapConfig) => Promise<ImapClientLike>;

/**
 * Dependencies threaded through every IMAP op. `account` selects which
 * configured IMAP account to use (C2 multi-account); `config`/`connect` are
 * test seams. When `account` is omitted the default/first account is used.
 */
export interface ImapDeps {
  connect?: ImapConnect;
  config?: ImapConfig;
  account?: string;
}

type ImapMessageRef = NonNullable<ReturnType<typeof decodeImapId>>;

function sameImapAccount(left: string, right: string, deps: ImapDeps): boolean {
  if (left === right) return true;

  // Injected configs are the normal test seam and also give us both aliases
  // without consulting process.env.
  if (deps.config) {
    const aliases = new Set([deps.config.accountLabel, deps.config.user]);
    if (aliases.has(left) && aliases.has(right)) return true;
  }

  // Composite ids encode the stable account label, while callers may select
  // that same account by its login address. Resolve both selectors against the
  // same config list before deciding that the id belongs to another account.
  const specs = listImapAccountSpecs();
  const matches = (selector: string, spec: ImapAccountSpec) =>
    spec.accountLabel === selector || spec.user === selector;
  const leftSpec = specs.find((spec) => matches(left, spec));
  const rightSpec = specs.find((spec) => matches(right, spec));
  return leftSpec !== undefined && leftSpec === rightSpec;
}

function depsForAccount(account: string, deps: ImapDeps): ImapDeps {
  if (deps.account && !sameImapAccount(account, deps.account, deps)) {
    throw new Error(`IMAP message id belongs to account "${account}", not "${deps.account}".`);
  }
  return { ...deps, account };
}

function depsForMessageRef(ref: ImapMessageRef, deps: ImapDeps): ImapDeps {
  return depsForAccount(ref.account, deps);
}

/** A configured IMAP account, used for routing ids to their account. */
interface ImapAccountSpec {
  accountLabel: string;
  user: string;
  host: string;
  port: number;
  password?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Enumerate all configured IMAP accounts (C2): the legacy single-account env
 * vars plus any in the `APPLE_MAIL_MCP_IMAP_ACCOUNTS` JSON array. The legacy
 * account takes precedence on label collisions.
 */
function listImapAccountSpecs(env: NodeJS.ProcessEnv = process.env): ImapAccountSpec[] {
  const specs: ImapAccountSpec[] = [];
  const user = env[IMAP_ENV.user]?.trim();
  if (user) {
    specs.push({
      accountLabel: env[IMAP_ENV.account]?.trim() || user,
      user,
      host: env[IMAP_ENV.host]?.trim() || "imap.gmail.com",
      port: env[IMAP_ENV.port] ? Number.parseInt(env[IMAP_ENV.port] as string, 10) : 993,
      password: env[IMAP_ENV.password],
    });
  }
  const json = env[IMAP_ENV.accounts]?.trim();
  if (json) {
    try {
      const arr: unknown = JSON.parse(json);
      if (Array.isArray(arr)) {
        for (const raw of arr) {
          const a = raw as Record<string, unknown>;
          const u = str(a.user);
          if (!u) continue;
          const label = str(a.account) || str(a.accountLabel) || u;
          if (specs.some((s) => s.accountLabel === label)) continue; // legacy wins
          const port = a.port ? Number(a.port) : 993;
          specs.push({
            accountLabel: label,
            user: u,
            host: str(a.host) || "imap.gmail.com",
            port,
            password: str(a.password),
          });
        }
      }
    } catch (e) {
      console.error(`Invalid ${IMAP_ENV.accounts} JSON, ignoring: ${String(e)}`);
    }
  }
  return specs;
}

function specToConfig(spec: ImapAccountSpec): ImapConfig {
  if (!Number.isInteger(spec.port) || spec.port <= 0) {
    throw new Error(`Invalid IMAP port for account "${spec.accountLabel}": "${spec.port}".`);
  }
  const pass = spec.password;
  if (!pass) {
    throw new Error(`No IMAP password for account "${spec.accountLabel}". ${SETUP_HINT}`);
  }
  return {
    host: spec.host,
    port: spec.port,
    secure: spec.port === 993,
    user: spec.user,
    pass,
    accountLabel: spec.accountLabel,
  };
}

/** True when `account` matches any configured IMAP account (label or user). */
export function isImapAccount(
  account: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!account) return false;
  return listImapAccountSpecs(env).some((s) => s.accountLabel === account || s.user === account);
}

/**
 * Resolve the full IMAP config (password included) for `account`. With no
 * `account`, returns the default/first configured account. Throws if IMAP is
 * unconfigured or no account matches.
 */
export function resolveImapConfig(
  env: NodeJS.ProcessEnv = process.env,
  account?: string
): ImapConfig {
  const specs = listImapAccountSpecs(env);
  if (specs.length === 0) {
    throw new Error(
      `IMAP not configured. Set ${IMAP_ENV.user} (login address) to enable it. ${SETUP_HINT}`
    );
  }
  let spec: ImapAccountSpec | undefined;
  if (account) {
    spec = specs.find((s) => s.accountLabel === account || s.user === account);
    if (!spec) {
      throw new Error(
        `No IMAP account matching "${account}". Configured: ${specs.map((s) => s.accountLabel).join(", ")}.`
      );
    }
  } else {
    spec = specs[0];
  }
  return specToConfig(spec);
}

/** Open one authenticated IMAP connection (the production connector). */
export const connectImap: ImapConnect = async (cfg) => {
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  // ImapFlow is an EventEmitter: once connect() resolves, a later socket error
  // on this pooled, long-lived client (idle Gmail/iCloud timeout, server BYE,
  // network drop) emits 'error'. With no listener that is an *uncaught*
  // exception that crashes the whole MCP server. Attach one before connect so
  // the error is swallowed; the pool's liveness probe reconnects on next use.
  // Same defect class as defaultIdleConnect in imapIdle.ts.
  client.on("error", () => {});
  await client.connect();
  return client as unknown as ImapClientLike;
};

/** Map common (Gmail) mailbox names to their IMAP paths. */
export function resolveMailboxPath(mailbox: string | undefined, mode: "search" | "list"): string {
  if (!mailbox) return mode === "search" ? "[Gmail]/All Mail" : "INBOX";
  const map: Record<string, string> = {
    "all mail": "[Gmail]/All Mail",
    "sent mail": "[Gmail]/Sent Mail",
    sent: "[Gmail]/Sent Mail",
    trash: "[Gmail]/Trash",
    drafts: "[Gmail]/Drafts",
    spam: "[Gmail]/Spam",
    junk: "[Gmail]/Spam",
    starred: "[Gmail]/Starred",
    important: "[Gmail]/Important",
  };
  return map[mailbox.trim().toLowerCase()] ?? mailbox;
}

function buildCriteria(a: ImapSearchArgs, listMode: boolean): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (a.query) c.or = [{ subject: a.query }, { from: a.query }];
  if (a.from) c.from = a.from;
  if (a.subject) c.subject = a.subject;
  if (a.isRead === true) c.seen = true;
  if (a.isRead === false) c.unseen = true;
  if (a.unreadOnly && listMode) c.unseen = true;
  if (a.isFlagged === true) c.flagged = true;
  if (a.isFlagged === false) c.unflagged = true;
  if (a.dateFrom) c.since = new Date(a.dateFrom);
  if (a.dateTo) c.before = new Date(a.dateTo);
  if (Object.keys(c).length === 0) c.all = true;
  return c;
}

function formatRow(m: ImapMessage, account: string, path: string): string {
  const env = m.envelope ?? {};
  const subject = env.subject || "(no subject)";
  const a = env.from?.[0];
  const from = a
    ? a.name
      ? `${a.name} <${a.address ?? ""}>`
      : (a.address ?? "(unknown)")
    : "(unknown)";
  const date = env.date ? new Date(env.date).toLocaleDateString() : "";
  const read = m.flags?.has("\\Seen") ? "read" : "unread";
  // Emit the self-describing IMAP id so get-message and the message mutations
  // can route this row back to IMAP (Phase 3).
  return `  - ID: ${encodeImapId(account, path, m.uid)} | ${date} | ${subject} (from: ${from}) [${read}]`;
}

/**
 * JSON-friendly summary of an IMAP message for `structuredContent`, mirroring the
 * AppleScript path's `messageSummary` shape so the search/list/thread tools emit
 * the same structured payload regardless of backend (A1).
 */
function structuredRow(m: ImapMessage, account: string, path: string): Record<string, unknown> {
  const env = m.envelope ?? {};
  return {
    id: encodeImapId(account, path, m.uid),
    subject: env.subject || "(no subject)",
    sender: senderName(env.from),
    dateReceived: env.date ? new Date(env.date).toISOString() : "",
    isRead: m.flags?.has("\\Seen") ?? false,
    isFlagged: m.flags?.has("\\Flagged") ?? false,
    mailbox: path,
    account,
    hasAttachments: false,
    // Message-ID (when the envelope carries it) is the strongest cross-/intra-
    // backend dedup key for the multi-account merge (imapMultiAccount.ts). The
    // AppleScript path does not expose it, so cross-backend dedup falls back to
    // the subject|sender|date composite key.
    ...(env.messageId ? { messageId: env.messageId } : {}),
  };
}

/**
 * Result of an IMAP search/list: the human text identical to before, plus the
 * structured payload (messages + count) so callers can pass it straight to
 * `successResponse(text, structured)` and emit `structuredContent` on the IMAP
 * path the same way the AppleScript path does.
 */
export interface ImapListResult {
  text: string;
  messages: Record<string, unknown>[];
  count: number;
  partial: boolean;
}

async function run(
  args: ImapSearchArgs,
  listMode: boolean,
  deps: ImapDeps
): Promise<ImapListResult> {
  // Reads are idempotent → safe to retry once if a pooled connection is dead.
  // Route to the account named in the search args (C2 multi-account).
  return useClient(
    { ...deps, account: deps.account ?? args.account },
    async (client, cfg) => {
      const path = resolveMailboxPath(args.mailbox, listMode ? "list" : "search");
      const lock = await client.getMailboxLock(path);
      try {
        const found = await client.search(buildCriteria(args, listMode), { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (uids.length === 0) {
          return {
            text: `No messages found via IMAP in "${path}" (account ${cfg.accountLabel}).`,
            messages: [],
            count: 0,
            partial: false,
          };
        }
        const limit = args.limit ?? 50;
        const offset = args.offset ?? 0;
        // UIDs are ascending → newest are the highest. Apply offset+limit from the newest end.
        const newest = uids
          .slice()
          .reverse()
          .slice(offset, offset + limit);
        const byUid = new Map<number, ImapMessage>();
        for await (const msg of client.fetch(
          newest.join(","),
          { envelope: true, flags: true },
          { uid: true }
        )) {
          byUid.set(msg.uid, msg);
        }
        const ordered = newest
          .map((u) => byUid.get(u))
          .filter((m): m is ImapMessage => m !== undefined);
        const rows = ordered.map((m) => formatRow(m, cfg.accountLabel, path));
        const messages = ordered.map((m) => structuredRow(m, cfg.accountLabel, path));
        const verb = listMode ? "listed" : "matched";
        const text =
          `Found ${rows.length} message(s) via IMAP (server-side, account ${cfg.accountLabel}, mailbox "${path}"; ${uids.length} total ${verb}):\n` +
          rows.join("\n") +
          `\n\nNote: these IMAP IDs (imap:…) work with get-message and the message mutations (mark/flag/move/delete-message), which route back to IMAP.`;
        return { text, messages, count: messages.length, partial: false };
      } finally {
        lock.release();
      }
    },
    true
  );
}

export function imapSearchMessages(
  args: ImapSearchArgs,
  deps: ImapDeps = {}
): Promise<ImapListResult> {
  return run(args, false, deps);
}

export function imapListMessages(
  args: ImapSearchArgs,
  deps: ImapDeps = {}
): Promise<ImapListResult> {
  return run(args, true, deps);
}

// ===========================================================================
// Counts & stats via IMAP STATUS (2.1 optimizations I3/I4/I6)
//
// STATUS is a single server round-trip that returns authoritative message/unseen
// counts without enumerating messages — far faster and more reliable than
// AppleScript on large mailboxes (where the per-message walk times out, #8/#24).
// ===========================================================================

/**
 * Unread count via IMAP STATUS (UNSEEN). No mailbox → INBOX.
 *
 * This used to sum UNSEEN across every mailbox, which was both slow — a STATUS
 * per label on a cold pooled connection, dozens of serial round-trips that
 * overran the MCP client's tool-call timeout — and WRONG on Gmail, where one
 * unread message simultaneously lives in INBOX, [Gmail]/All Mail, and each of
 * its labels and so got counted several times over. INBOX is the meaningful
 * "unread messages" figure; pass `mailbox` for any other scope.
 */
export function imapUnreadCount(mailbox: string | undefined, deps: ImapDeps = {}): Promise<number> {
  return useClient(
    deps,
    async (client) => {
      const s = await client.status(resolveMailboxPath(mailbox, "list"), { unseen: true });
      return s.unseen ?? 0;
    },
    true
  );
}

export interface ImapMailboxInfo {
  path: string;
  name: string;
  messages: number;
  unseen: number;
}

/** List mailboxes with per-mailbox message/unseen counts via LIST + STATUS (I6). */
export function imapListMailboxes(deps: ImapDeps = {}): Promise<ImapMailboxInfo[]> {
  return useClient(
    deps,
    async (client) => {
      const out: ImapMailboxInfo[] = [];
      for (const b of await client.list()) {
        let messages = 0;
        let unseen = 0;
        try {
          const s = await client.status(b.path, { messages: true, unseen: true });
          messages = s.messages ?? 0;
          unseen = s.unseen ?? 0;
        } catch {
          // \Noselect or otherwise un-status-able mailbox → report zeros
        }
        out.push({ path: b.path, name: b.name, messages, unseen });
      }
      return out;
    },
    true
  );
}

export interface ImapStats {
  totalMessages: number;
  totalUnread: number;
  perMailbox: { mailbox: string; messages: number; unseen: number }[];
  recent: { last24h: number; last7d: number; last30d: number };
}

/** Aggregate stats via STATUS (counts) + INBOX SEARCH SINCE (recent) (I3). */
export function imapMailStats(deps: ImapDeps = {}): Promise<ImapStats> {
  return useClient(
    deps,
    async (client) => {
      const perMailbox: ImapStats["perMailbox"] = [];
      let totalMessages = 0;
      let totalUnread = 0;
      for (const b of await client.list()) {
        try {
          const s = await client.status(b.path, { messages: true, unseen: true });
          const messages = s.messages ?? 0;
          const unseen = s.unseen ?? 0;
          totalMessages += messages;
          totalUnread += unseen;
          perMailbox.push({ mailbox: b.path, messages, unseen });
        } catch {
          // skip un-status-able mailbox
        }
      }
      // Recent counts against INBOX (the meaningful "received" surface).
      const since = (days: number): Date => new Date(Date.now() - days * 86_400_000);
      const countSince = async (days: number): Promise<number> => {
        try {
          const lock = await client.getMailboxLock("INBOX");
          try {
            const found = await client.search({ since: since(days) }, { uid: true });
            return Array.isArray(found) ? found.length : 0;
          } finally {
            lock.release();
          }
        } catch {
          return 0;
        }
      };
      const [last24h, last7d, last30d] = await Promise.all([
        countSince(1),
        countSince(7),
        countSince(30),
      ]);
      return { totalMessages, totalUnread, perMailbox, recent: { last24h, last7d, last30d } };
    },
    true
  );
}

// ===========================================================================
// Phase 2 — mailbox/folder operations (issue #43)
//
// IMAP's CREATE / RENAME / DELETE work on the real server-side folder
// hierarchy, so they succeed on exactly the server-side mailboxes (iCloud /
// Gmail / Workspace / Exchange) where Mail.app's AppleScript bridge throws
// "AppleEvent handler failed" (#42). Routed only when the account is IMAP-
// configured; AppleScript remains the path for everything else.
// ===========================================================================

export interface ImapOpResult {
  success: boolean;
  error?: string;
  info?: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Connection pool (issue #50 / A3)
//
// The MCP server is long-lived and every tool call is serialized through the
// AppleScript gate, so instead of connecting + logging out (~seconds) on every
// IMAP call, one connection is kept alive and reused. A NOOP verifies liveness
// before reuse; an idle timer closes it after inactivity. An injected
// `deps.connect` (tests) bypasses the pool and connects per call.
// ---------------------------------------------------------------------------
let poolConnect: ImapConnect = connectImap;
interface PoolEntry {
  client: ImapClientLike;
  idle?: NodeJS.Timeout;
}
// One kept-alive connection per account (C2): keyed by host:port:user so each
// configured IMAP account keeps its own pooled connection instead of thrashing
// a single slot when calls alternate between accounts.
const pools = new Map<string, PoolEntry>();

function poolKey(cfg: ImapConfig): string {
  return `${cfg.host}:${cfg.port}:${cfg.user}`;
}

function imapIdleMs(): number {
  const raw = process.env.APPLE_MAIL_MCP_IMAP_IDLE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Default 30s (v2.6.1): close the pooled connection sooner so this instance
  // gives its IMAP slot back quickly — important when several instances coexist
  // against Gmail's ~15-per-account cap and Apple Mail also needs slots. Tune
  // with APPLE_MAIL_MCP_IMAP_IDLE_MS (0 = never close).
  return 30_000;
}

async function dropPool(key: string): Promise<void> {
  const e = pools.get(key);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  pools.delete(key);
  // Graceful logout, THEN a hard close. When Gmail has already half-closed the
  // socket (its idle timeout / a server BYE → the FD sits in CLOSE_WAIT),
  // logout() cannot complete and throws; without the force-close that socket
  // leaked and accumulated against Gmail's ~15-per-account cap (observed: 10
  // ESTABLISHED + 12 CLOSE_WAIT to Gmail per instance). close() destroys it
  // unconditionally so the FD/slot is always released.
  await e.client.logout().catch(() => undefined);
  e.client.close?.();
}

/**
 * Close and log out every pooled IMAP connection. Exported so the server can
 * call it on shutdown (SIGINT/SIGTERM/stdin-EOF) — otherwise a killed or
 * orphaned instance leaves its pooled sockets occupying slots against the
 * server's per-account connection limit until they're reaped by a TCP timeout.
 */
export async function dropAllPools(): Promise<void> {
  await Promise.all([...pools.keys()].map((k) => dropPool(k)));
}

function scheduleIdleClose(key: string): void {
  const e = pools.get(key);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  const ms = imapIdleMs();
  if (ms <= 0) return;
  e.idle = setTimeout(() => void dropPool(key), ms);
  e.idle.unref?.();
}

// Single-flight connect guard: concurrent acquisitions of the same account
// await ONE in-flight connect instead of each opening (and orphaning) its own
// socket — the race that can leak connections past the per-account limit.
const connecting = new Map<string, Promise<ImapClientLike>>();

async function acquirePooled(cfg: ImapConfig): Promise<ImapClientLike> {
  const key = poolKey(cfg);
  const existing = pools.get(key);
  if (existing) {
    if (existing.idle) clearTimeout(existing.idle);
    try {
      await existing.client.noop(); // verify the kept-alive connection is still usable
      return existing.client;
    } catch {
      await dropPool(key);
    }
  }
  const inFlight = connecting.get(key);
  if (inFlight) return inFlight;
  const p = (async () => {
    const client = await poolConnect(cfg);
    pools.set(key, { client });
    return client;
  })();
  connecting.set(key, p);
  try {
    return await p;
  } finally {
    connecting.delete(key);
  }
}

/** Test seam: override the pool's connect factory; pass null to restore. */
export function __setPoolConnect(fn: ImapConnect | null): void {
  poolConnect = fn ?? connectImap;
}
/** Test seam: close and clear all pooled connections. */
export async function __resetPool(): Promise<void> {
  await dropAllPools();
}

/**
 * Run `fn` with an IMAP client. Default (production) path reuses the pooled,
 * kept-alive connection; an injected `deps.connect` connects fresh and logs out
 * per call. `retryOnDrop` reconnects once if a pooled connection dies mid-op —
 * only safe for idempotent reads, so mutations leave it false.
 */
async function useClient<T>(
  deps: ImapDeps,
  fn: (client: ImapClientLike, cfg: ImapConfig) => Promise<T>,
  retryOnDrop = false
): Promise<T> {
  const cfg = deps.config ?? resolveImapConfig(process.env, deps.account);
  if (deps.connect) {
    const client = await deps.connect(cfg);
    try {
      return await fn(client, cfg);
    } finally {
      await client.logout().catch(() => undefined);
      client.close?.();
    }
  }
  const key = poolKey(cfg);
  try {
    const client = await acquirePooled(cfg);
    const r = await fn(client, cfg);
    scheduleIdleClose(key);
    return r;
  } catch (e) {
    await dropPool(key);
    if (retryOnDrop) {
      const client = await acquirePooled(cfg);
      try {
        const r = await fn(client, cfg);
        scheduleIdleClose(key);
        return r;
      } catch (e2) {
        await dropPool(key);
        throw e2;
      }
    }
    throw e;
  }
}

/** Connect, run `fn`, manage the connection (pooled in production). */
function withClient<T>(
  deps: ImapDeps,
  fn: (client: ImapClientLike, cfg: ImapConfig) => Promise<T>
): Promise<T> {
  return useClient(deps, fn);
}

/**
 * Resolve a user-supplied mailbox name to an actual server path by listing the
 * mailboxes and matching on full path, then leaf name (case-insensitive).
 * Returns null when no such mailbox exists.
 */
async function findMailboxPath(client: ImapClientLike, name: string): Promise<string | null> {
  const wanted = name.trim().toLowerCase();
  const boxes = await client.list();
  const byPath = boxes.find((b) => b.path.toLowerCase() === wanted);
  if (byPath) return byPath.path;
  const byName = boxes.find((b) => b.name.toLowerCase() === wanted);
  return byName ? byName.path : null;
}

export function imapCreateMailbox(name: string, deps: ImapDeps = {}): Promise<ImapOpResult> {
  return withClient(deps, async (client) => {
    try {
      const res = await client.mailboxCreate(name);
      return res.created
        ? { success: true, info: `Created mailbox "${res.path}".` }
        : { success: true, info: `Mailbox "${res.path}" already existed.` };
    } catch (e) {
      return { success: false, error: `IMAP create failed for "${name}": ${errText(e)}` };
    }
  });
}

export function imapDeleteMailbox(name: string, deps: ImapDeps = {}): Promise<ImapOpResult> {
  return withClient(deps, async (client, cfg) => {
    const path = await findMailboxPath(client, name);
    if (!path) {
      return {
        success: false,
        error: `Mailbox "${name}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    try {
      await client.mailboxDelete(path);
      return {
        success: true,
        info: `Deleted mailbox "${path}" via IMAP (account ${cfg.accountLabel}).`,
      };
    } catch (e) {
      return { success: false, error: `IMAP delete failed for "${path}": ${errText(e)}` };
    }
  });
}

export function imapRenameMailbox(
  oldName: string,
  newName: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  return withClient(deps, async (client, cfg) => {
    const path = await findMailboxPath(client, oldName);
    if (!path) {
      return {
        success: false,
        error: `Mailbox "${oldName}" not found on IMAP account ${cfg.accountLabel}.`,
      };
    }
    try {
      const res = await client.mailboxRename(path, newName);
      return { success: true, info: `Renamed "${res.path}" to "${res.newPath}" via IMAP.` };
    } catch (e) {
      return {
        success: false,
        error: `IMAP rename failed for "${path}" -> "${newName}": ${errText(e)}`,
      };
    }
  });
}

// ===========================================================================
// Phase 3 — message-level operations by composite IMAP id (issue #43)
//
// get-message / mark / flag / move / delete-message route here when the message
// id is an `imap:` token (emitted by the IMAP read path). The token carries the
// mailbox path + UID, so the op opens that mailbox and acts on the UID.
// ===========================================================================

/** Connect, open the message's mailbox, run `fn`, release + log out. */
async function withMailbox<T>(
  path: string,
  deps: ImapDeps,
  fn: (client: ImapClientLike) => Promise<T>
): Promise<T> {
  return withClient(deps, async (client) => {
    const lock = await client.getMailboxLock(path);
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

export type ImapSpecialMailbox = "drafts" | "sent";

export interface ImapRawMessage {
  id: string;
  account: string;
  path: string;
  uid: number;
  uidValidity?: string;
  raw: Buffer;
  /** Server flags and keywords, when fetched. */
  flags?: string[];
}

/** One message that carries a given header, without its body. */
export interface ImapHeaderMatch {
  id: string;
  uid: number;
  value: string;
  flags: string[];
}

function sourceBuffer(source: Buffer | string): Buffer {
  return Buffer.isBuffer(source) ? source : Buffer.from(source, "utf8");
}

/** Read one unfolded header value from a fetched header block. */
function headerValue(block: Buffer | string | undefined, name: string): string | null {
  if (!block) return null;
  const text = sourceBuffer(block)
    .toString("utf8")
    .replace(/\r?\n[ \t]+/g, " ");
  const prefix = `${name.toLowerCase()}:`;
  const line = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function specialUseFlag(kind: ImapSpecialMailbox): string {
  return kind === "drafts" ? "\\drafts" : "\\sent";
}

function specialMailboxFallbacks(kind: ImapSpecialMailbox): string[] {
  return kind === "drafts"
    ? ["Drafts", "[Gmail]/Drafts"]
    : ["Sent", "Sent Messages", "Sent Mail", "[Gmail]/Sent Mail"];
}

async function resolveSpecialMailboxPath(
  client: ImapClientLike,
  kind: ImapSpecialMailbox
): Promise<string> {
  const boxes = await client.list();
  const flag = specialUseFlag(kind);
  const special = boxes.find((box) => box.specialUse?.toLowerCase() === flag);
  if (special) return special.path;
  for (const fallback of specialMailboxFallbacks(kind)) {
    const match = boxes.find(
      (box) =>
        box.path.toLowerCase() === fallback.toLowerCase() ||
        box.name.toLowerCase() === fallback.toLowerCase()
    );
    if (match) return match.path;
  }
  throw new Error(
    `IMAP account does not expose a ${kind === "drafts" ? "Drafts" : "Sent"} mailbox.`
  );
}

/** The server path of the account's Drafts or Sent mailbox. */
export function imapSpecialMailboxPath(
  kind: ImapSpecialMailbox,
  deps: ImapDeps = {}
): Promise<string> {
  return withClient(deps, (client) => resolveSpecialMailboxPath(client, kind));
}

/**
 * Append one exact RFC 5322 message to the provider's special-use mailbox.
 * lookupHeader is used to recover the UID on servers without UIDPLUS.
 */
export async function imapAppendRawMessage(
  raw: Buffer,
  kind: ImapSpecialMailbox,
  lookupHeader: { name: string; value: string },
  deps: ImapDeps = {}
): Promise<ImapRawMessage> {
  return withClient(deps, async (client, cfg) => {
    if (!client.append) throw new Error("The configured IMAP client does not support APPEND.");
    const path = await resolveSpecialMailboxPath(client, kind);
    const flags = kind === "drafts" ? ["\\Draft", "\\Seen"] : ["\\Seen"];
    const appended = await client.append(path, raw, flags, new Date());
    if (!appended) throw new Error(`IMAP APPEND to "${path}" returned no result.`);
    let uid = appended.uid;
    if (!uid) {
      const lock = await client.getMailboxLock(path);
      try {
        uid = await findUidByHeader(client, cfg, path, lookupHeader);
      } finally {
        lock.release();
      }
    }
    if (!uid) {
      throw new Error(
        `IMAP APPEND succeeded in "${path}", but the server did not return or expose its UID.`
      );
    }
    return {
      id: encodeImapId(cfg.accountLabel, path, uid),
      account: cfg.accountLabel,
      path,
      uid,
      uidValidity: appended.uidValidity?.toString(),
      raw,
    };
  });
}

export async function imapFetchRawMessage(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapRawMessage | null> {
  const ref = decodeImapId(id);
  if (!ref) throw new Error(`Not an IMAP message id: "${id}".`);
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const message = await client.fetchOne(
      String(ref.uid),
      { source: true, flags: true },
      { uid: true }
    );
    if (!message || !message.source) return null;
    return {
      id,
      account: ref.account,
      path: ref.path,
      uid: ref.uid,
      raw: sourceBuffer(message.source),
      flags: [...(message.flags ?? [])],
    };
  });
}

export async function imapFindRawMessageByHeader(
  kind: ImapSpecialMailbox,
  header: { name: string; value: string },
  deps: ImapDeps = {}
): Promise<ImapRawMessage | null> {
  return withClient(deps, async (client, cfg) => {
    const path = await resolveSpecialMailboxPath(client, kind);
    const lock = await client.getMailboxLock(path);
    try {
      const uid = await findUidByHeader(client, cfg, path, header);
      if (!uid) return null;
      const message = await client.fetchOne(
        String(uid),
        { source: true, flags: true },
        { uid: true }
      );
      if (!message || !message.source) return null;
      return {
        id: encodeImapId(cfg.accountLabel, path, uid),
        account: cfg.accountLabel,
        path,
        uid,
        raw: sourceBuffer(message.source),
        flags: [...(message.flags ?? [])],
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * List the newest messages in a special-use mailbox that carry `headerName`.
 * Fetches only that header and the flags; servers differ on whether a HEADER
 * search with an empty value matches, so filtering happens locally.
 */
export async function imapListMessagesWithHeader(
  kind: ImapSpecialMailbox,
  headerName: string,
  deps: ImapDeps = {},
  scanLimit = 500
): Promise<ImapHeaderMatch[]> {
  return withClient(deps, async (client, cfg) => {
    const path = await resolveSpecialMailboxPath(client, kind);
    const lock = await client.getMailboxLock(path);
    try {
      return await scanHeader(client, cfg, path, headerName, scanLimit);
    } finally {
      lock.release();
    }
  });
}

/** The newest UID in the locked mailbox whose `header` has exactly this value. */
async function findUidByHeader(
  client: ImapClientLike,
  cfg: ImapConfig,
  path: string,
  header: { name: string; value: string }
): Promise<number | undefined> {
  const found = await client.search({ header: { [header.name]: header.value } }, { uid: true });
  if (Array.isArray(found)) return found.at(-1);
  // iCloud refuses HEADER searches on custom fields such as the draft ID
  // (imapflow returns false), so match those locally instead.
  const matches = await scanHeader(client, cfg, path, header.name);
  return matches.filter((match) => match.value === header.value).at(-1)?.uid;
}

/** Read `headerName` from the newest messages of the locked mailbox, oldest first. */
async function scanHeader(
  client: ImapClientLike,
  cfg: ImapConfig,
  path: string,
  headerName: string,
  scanLimit = 500
): Promise<ImapHeaderMatch[]> {
  const found = await client.search({ all: true }, { uid: true });
  const uids = (Array.isArray(found) ? found : []).slice(-scanLimit);
  const matches: ImapHeaderMatch[] = [];
  if (!uids.length) return matches;
  for await (const message of client.fetch(
    uids.join(","),
    { headers: [headerName], flags: true },
    { uid: true }
  )) {
    const value = headerValue(message.headers, headerName);
    if (!value) continue;
    matches.push({
      id: encodeImapId(cfg.accountLabel, path, message.uid),
      uid: message.uid,
      value,
      flags: [...(message.flags ?? [])],
    });
  }
  return matches.sort((a, b) => a.uid - b.uid);
}

/** Permanently remove one exact IMAP message. Intended for replaced/sent drafts. */
export async function imapDeleteExactMessage(id: string, deps: ImapDeps = {}): Promise<boolean> {
  const ref = decodeImapId(id);
  if (!ref) throw new Error(`Not an IMAP message id: "${id}".`);
  return withMailbox(ref.path, depsForMessageRef(ref, deps), (client) =>
    client.messageDelete([ref.uid], { uid: true })
  );
}

/** Read a message by composite IMAP id; returns "Subject: …\n\n<body>". */
export async function imapGetMessage(
  id: string,
  preferHtml: boolean,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const msg = await client.fetchOne(
      String(ref.uid),
      { envelope: true, source: true },
      { uid: true }
    );
    if (!msg)
      return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
    const subject = msg.envelope?.subject || "(no subject)";
    // The fetched bytes, not a UTF-8 string, so bodies decode in their own charset.
    const src = msg.source ?? "";
    const body =
      (preferHtml ? extractHtmlBody(src) : extractTextBody(src)) ??
      extractTextBody(src) ??
      extractHtmlBody(src) ??
      "(no readable body)";
    return { success: true, info: `Subject: ${subject}\n\n${body}` };
  });
}

function formatAddresses(addresses?: ImapAddress[]): string[] {
  return (addresses ?? [])
    .filter((address) => Boolean(address.address))
    .map((address) =>
      address.name ? `${address.name} <${address.address}>` : (address.address as string)
    );
}

/**
 * Fetch a complete provider-neutral message resource in one IMAP operation.
 * Source is always fetched because bodies require MIME decoding, but it is only
 * exposed to the caller when `includeRawMime` is explicitly requested.
 */
export async function imapReadMessage(
  id: string,
  includeRawMime = false,
  deps: ImapDeps = {}
): Promise<{ success: boolean; message?: MessageResource; error?: string }> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const msg = await client.fetchOne(
      String(ref.uid),
      { envelope: true, source: true, flags: true, bodyStructure: true },
      { uid: true }
    );
    if (!msg) {
      return {
        success: false,
        error: `IMAP message UID ${ref.uid} not found in "${ref.path}".`,
      };
    }
    const attachments = msg.bodyStructure
      ? collectAttachments(msg.bodyStructure).map((attachment, index) => ({
          id: `${id}#${attachment.part || index}`,
          name: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
        }))
      : [];
    const message: MessageResource = {
      messageId: id,
      rfcMessageId: msg.envelope?.messageId
        ? normalizeMessageId(msg.envelope.messageId)
        : undefined,
      account: ref.account,
      mailbox: ref.path,
      from: formatAddresses(msg.envelope?.from),
      replyTo: formatAddresses(msg.envelope?.replyTo),
      to: formatAddresses(msg.envelope?.to),
      cc: formatAddresses(msg.envelope?.cc),
      bcc: formatAddresses(msg.envelope?.bcc),
      subject: msg.envelope?.subject || "(no subject)",
      date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : undefined,
      textBody: extractTextBody(msg.source ?? "") ?? "",
      htmlBody: extractHtmlBody(msg.source ?? "") ?? undefined,
      attachments,
      flags: {
        isRead: msg.flags?.has("\\Seen") ?? false,
        isFlagged: msg.flags?.has("\\Flagged") ?? false,
      },
      ...(includeRawMime ? { rawMime: msg.source ? msg.source.toString() : "" } : {}),
    };
    return { success: true, message };
  });
}

/** Normalize an RFC822 Message-ID for backend-independent matching: trim and
 *  drop any surrounding angle brackets (IMAP envelopes carry `<id>`, Mail.app's
 *  AppleScript `message id` property returns it bracketless). */
export function normalizeMessageId(mid: string): string {
  return mid.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Fetch the RFC822 Message-ID for an `imap:` id. This is the join key that lets
 * the AppleScript backend locate the *same* message and return its numeric
 * Mail.app id — needed because flag **colors** only apply on the AppleScript
 * numeric-id path (IMAP `\Flagged` is colorless). Returns the normalized
 * Message-ID (no angle brackets), or null if `id` isn't an imap: token, the
 * message/envelope can't be fetched, or it carries no Message-ID.
 */
export async function imapFetchMessageId(id: string, deps: ImapDeps = {}): Promise<string | null> {
  const ref = decodeImapId(id);
  if (!ref) return null;
  try {
    return await withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
      const msg = await client.fetchOne(String(ref.uid), { envelope: true }, { uid: true });
      const mid = msg && msg.envelope?.messageId;
      return mid ? normalizeMessageId(mid) : null;
    });
  } catch {
    return null;
  }
}

function flagOp(id: string, flag: string, add: boolean, deps: ImapDeps): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return Promise.resolve({ success: false, error: `Not an IMAP message id: "${id}".` });
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    try {
      const ok = add
        ? await client.messageFlagsAdd([ref.uid], [flag], { uid: true })
        : await client.messageFlagsRemove([ref.uid], [flag], { uid: true });
      if (!ok)
        return { success: false, error: `IMAP flag update returned false for UID ${ref.uid}.` };
      return { success: true };
    } catch (e) {
      return {
        success: false,
        error: `IMAP flag update failed for UID ${ref.uid}: ${errText(e)}`,
      };
    }
  });
}

/** Header values of the newest messages in a mailbox, without their bodies. */
export async function imapScanHeaders(
  target: ImapSpecialMailbox | "inbox",
  names: string[],
  deps: ImapDeps = {},
  scanLimit = 300
): Promise<Array<Record<string, string>>> {
  return withClient(deps, async (client) => {
    const path = target === "inbox" ? "INBOX" : await resolveSpecialMailboxPath(client, target);
    const lock = await client.getMailboxLock(path);
    try {
      const found = await client.search({ all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-scanLimit);
      const rows: Array<Record<string, string>> = [];
      if (!uids.length) return rows;
      for await (const message of client.fetch(uids.join(","), { headers: names }, { uid: true })) {
        const row: Record<string, string> = {};
        for (const name of names) {
          const value = headerValue(message.headers, name);
          if (value) row[name] = value;
        }
        rows.push(row);
      }
      return rows;
    } finally {
      lock.release();
    }
  });
}

/** Add or remove one IMAP keyword (for example a connector state marker). */
export const imapSetKeyword = (
  id: string,
  keyword: string,
  enabled: boolean,
  deps: ImapDeps = {}
): Promise<ImapOpResult> => flagOp(id, keyword, enabled, deps);
export const imapMarkRead = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", true, deps);
export const imapMarkUnread = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Seen", false, deps);
export const imapFlagMessage = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Flagged", true, deps);
export const imapUnflagMessage = (id: string, deps = {}): Promise<ImapOpResult> =>
  flagOp(id, "\\Flagged", false, deps);

export async function imapMoveMessageById(
  id: string,
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withClient(depsForMessageRef(ref, deps), async (client) => {
    const destPath =
      (await findMailboxPath(client, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
    const lock = await client.getMailboxLock(ref.path);
    try {
      await client.messageMove([ref.uid], destPath, { uid: true });
      return { success: true, info: `Moved UID ${ref.uid} to "${destPath}" via IMAP.` };
    } catch (e) {
      return {
        success: false,
        error: `IMAP move failed for UID ${ref.uid} -> "${destPath}": ${errText(e)}`,
      };
    } finally {
      lock.release();
    }
  });
}

/**
 * Resolve the account's Trash mailbox path: prefer the server's `\Trash`
 * special-use folder, then a common name/path, then the Gmail default.
 *
 * Deleting moves messages here (recoverable) rather than flagging `\Deleted` +
 * EXPUNGE, because on Gmail expunging a message from `[Gmail]/All Mail` is a
 * silent no-op — so the old flag+expunge path *reported success but never
 * actually trashed Gmail mail*. A move to `[Gmail]/Trash` is what Gmail treats
 * as "trash" (and matches the tools' documented "moves to Trash" contract).
 */
async function resolveTrashPath(client: ImapClientLike): Promise<string> {
  try {
    const boxes = await client.list();
    const special = boxes.find((b) => b.specialUse === "\\Trash");
    if (special) return special.path;
    const named = boxes.find(
      (b) =>
        /^(trash|deleted messages|deleted items|bin)$/i.test(b.name) || /(^|\/)trash$/i.test(b.path)
    );
    if (named) return named.path;
  } catch {
    // Fall through to the Gmail default if LIST fails.
  }
  return resolveMailboxPath("trash", "list");
}

/**
 * Trash a set of UIDs from the currently-selected `srcPath`: move them to the
 * account's Trash mailbox (recoverable). If the messages are *already* in Trash,
 * expunge them instead (the "empty from Trash" case). Returns the resolved
 * destination and whether it expunged.
 */
async function trashUids(
  client: ImapClientLike,
  uids: number[],
  srcPath: string
): Promise<{ dest: string; expunged: boolean }> {
  const dest = await resolveTrashPath(client);
  if (srcPath.trim().toLowerCase() === dest.trim().toLowerCase()) {
    await client.messageDelete(uids, { uid: true });
    return { dest, expunged: true };
  }
  await client.messageMove(uids, dest, { uid: true });
  return { dest, expunged: false };
}

export async function imapDeleteMessageById(
  id: string,
  deps: ImapDeps = {}
): Promise<ImapOpResult> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    try {
      const { dest, expunged } = await trashUids(client, [ref.uid], ref.path);
      return {
        success: true,
        info: expunged
          ? `Permanently deleted UID ${ref.uid} from Trash ("${ref.path}") via IMAP.`
          : `Moved UID ${ref.uid} to Trash ("${dest}") via IMAP.`,
      };
    } catch (e) {
      return { success: false, error: `IMAP delete failed for UID ${ref.uid}: ${errText(e)}` };
    }
  });
}

// ===========================================================================
// Attachments via BODYSTRUCTURE (2.1 optimization I1)
//
// AppleScript's `mail attachments` can't see MIME-embedded attachments, forcing
// a full raw-source scan. IMAP BODYSTRUCTURE enumerates parts without
// downloading the message, and FETCH BODY[part] pulls a single part — faster
// and it sees the attachments AppleScript misses. Routed for `imap:` ids.
// ===========================================================================

interface AttachmentPart {
  part: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ImapAttachmentInfo {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

/**
 * Walk a BODYSTRUCTURE tree collecting attachment parts (disposition or filename).
 *
 * A single-part message (e.g. Google's DMARC reports, whose entire body is one
 * application/zip) has a root node with no part number. IMAP addresses that
 * body as part "1" (imapflow's download maps it to BODY[TEXT]), and since there
 * is no other body to read, a non-text root is always exposed as an attachment.
 */
function collectAttachments(
  node: ImapBodyStructure,
  out: AttachmentPart[] = [],
  isRoot = true
): AttachmentPart[] {
  if (!node) return out;
  const singlePartRoot = isRoot && !node.childNodes;
  const part = node.part || (singlePartRoot ? "1" : undefined);
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const disposition = node.disposition?.toLowerCase();
  const isAttachment =
    !!part &&
    (disposition === "attachment" ||
      (!!filename && disposition !== "inline") ||
      (singlePartRoot && !/^text\//i.test(node.type || "text/plain")));
  if (isAttachment) {
    out.push({
      part,
      filename: filename || `part-${part}`,
      mimeType: node.type || "application/octet-stream",
      size: node.size ?? 0,
    });
  }
  for (const child of node.childNodes ?? []) collectAttachments(child, out, false);
  return out;
}

async function streamToBuffer(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** List a message's attachments via IMAP BODYSTRUCTURE (no full download). */
export async function imapListAttachments(
  id: string,
  deps: ImapDeps = {}
): Promise<{ success: boolean; attachments?: ImapAttachmentInfo[]; error?: string }> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
    if (!msg || !msg.bodyStructure) {
      return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
    }
    const attachments = collectAttachments(msg.bodyStructure).map((a) => ({
      id: `${id}#${a.part}`,
      name: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    }));
    return { success: true, attachments };
  });
}

/** Fetch one attachment's bytes (base64) via IMAP, matched by filename. */
export async function imapFetchAttachment(
  id: string,
  attachmentName: string,
  deps: ImapDeps = {}
): Promise<{
  success: boolean;
  base64?: string;
  bytes?: number;
  mimeType?: string;
  error?: string;
}> {
  const ref = decodeImapId(id);
  if (!ref) return { success: false, error: `Not an IMAP message id: "${id}".` };
  return withMailbox(ref.path, depsForMessageRef(ref, deps), async (client) => {
    const msg = await client.fetchOne(String(ref.uid), { bodyStructure: true }, { uid: true });
    if (!msg || !msg.bodyStructure) {
      return { success: false, error: `IMAP message UID ${ref.uid} not found in "${ref.path}".` };
    }
    const atts = collectAttachments(msg.bodyStructure);
    const match = atts.find((a) => a.filename === attachmentName);
    if (!match) {
      const names = atts.map((a) => a.filename).join(", ") || "none";
      return {
        success: false,
        error: `Attachment "${attachmentName}" not found on UID ${ref.uid}. Available: ${names}.`,
      };
    }
    const dl = await client.download(String(ref.uid), match.part, { uid: true });
    const buf = await streamToBuffer(dl.content);
    return {
      success: true,
      base64: buf.toString("base64"),
      bytes: buf.length,
      mimeType: match.mimeType,
    };
  });
}

// ===========================================================================
// Batch message operations via UID STORE / MOVE (2.1 optimization I2)
//
// AppleScript applies batch mark/flag/move/delete one message at a time. For
// imap: ids we group by mailbox and apply the whole UID set in a single IMAP
// command — dramatically fewer round-trips on large batches.
// ===========================================================================

export interface ImapBatchResult {
  success: number;
  failed: number;
  errors: string[];
}

async function imapBatch(
  ids: string[],
  deps: ImapDeps,
  op: (client: ImapClientLike, uids: number[], path: string) => Promise<void>
): Promise<ImapBatchResult> {
  const groups = new Map<string, { account: string; path: string; uids: number[] }>();
  const errors: string[] = [];
  let failed = 0;
  for (const id of ids) {
    const ref = decodeImapId(id);
    if (!ref) {
      failed++;
      errors.push(`Not an IMAP id: "${id}"`);
      continue;
    }
    const key = `${ref.account}\0${ref.path}`;
    const g = groups.get(key) ?? { account: ref.account, path: ref.path, uids: [] };
    g.uids.push(ref.uid);
    groups.set(key, g);
  }
  let success = 0;
  for (const g of groups.values()) {
    try {
      await useClient(depsForAccount(g.account, deps), async (client) => {
        const lock = await client.getMailboxLock(g.path);
        try {
          await op(client, g.uids, g.path);
        } finally {
          lock.release();
        }
      });
      success += g.uids.length;
    } catch (e) {
      failed += g.uids.length;
      errors.push(`${g.path}: ${errText(e)}`);
    }
  }
  return { success, failed, errors };
}

export const imapBatchMarkRead = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
  });
export const imapBatchMarkUnread = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
  });
export const imapBatchFlag = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
  });
export const imapBatchUnflag = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids) => {
    await c.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
  });
export const imapBatchDelete = (ids: string[], deps: ImapDeps = {}): Promise<ImapBatchResult> =>
  imapBatch(ids, deps, async (c, uids, path) => {
    await trashUids(c, uids, path);
  });
export function imapBatchMove(
  ids: string[],
  destMailbox: string,
  deps: ImapDeps = {}
): Promise<ImapBatchResult> {
  return imapBatch(ids, deps, async (c, uids) => {
    const dest = (await findMailboxPath(c, destMailbox)) ?? resolveMailboxPath(destMailbox, "list");
    await c.messageMove(uids, dest, { uid: true });
  });
}

// ===========================================================================
// True threading via References / Message-ID (2.1 optimization I5)
//
// For an imap: seed id, assemble the conversation from RFC 5322 References /
// In-Reply-To headers (descendants reference the seed; ancestors are the seed's
// References) using IMAP HEADER SEARCH — more accurate than subject grouping.
// Returns null when nothing beyond the seed is found, so get-thread falls back
// to subject grouping (and for servers without HEADER search support).
// ===========================================================================

export interface ImapThreadMessage {
  id: string;
  subject: string;
  sender: string;
  date: string;
  isRead: boolean;
}
export interface ImapThreadResult {
  count: number;
  text: string;
  structured: { subject: string; messages: ImapThreadMessage[]; count: number };
}

function senderName(from?: ImapAddress[]): string {
  const a = from?.[0];
  if (!a) return "(unknown)";
  return a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "(unknown)");
}
function dateMs(m: ImapMessage): number {
  return m.envelope?.date ? new Date(m.envelope.date).getTime() : 0;
}

export async function imapThread(
  id: string,
  deps: ImapDeps = {},
  limit = 50
): Promise<ImapThreadResult | null> {
  const ref = decodeImapId(id);
  if (!ref) return null;
  return useClient(
    depsForMessageRef(ref, deps),
    async (client) => {
      const lock = await client.getMailboxLock(ref.path);
      try {
        const seed = await client.fetchOne(
          String(ref.uid),
          { envelope: true, headers: ["references", "in-reply-to", "message-id"] },
          { uid: true }
        );
        if (!seed) return null;
        const seedMsgId = seed.envelope?.messageId;
        const refIds = new Set<string>();
        const hdr = seed.headers ? seed.headers.toString() : "";
        for (const m of hdr.matchAll(/<[^>]+>/g)) refIds.add(m[0]);
        if (seed.envelope?.inReplyTo) refIds.add(seed.envelope.inReplyTo);

        const uidSet = new Set<number>([ref.uid]);
        const addFound = (found: number[] | false): void => {
          if (Array.isArray(found)) found.forEach((u) => uidSet.add(u));
        };
        // Descendants: anything referencing the seed.
        if (seedMsgId) {
          addFound(await client.search({ header: { references: seedMsgId } }, { uid: true }));
          addFound(await client.search({ header: { "in-reply-to": seedMsgId } }, { uid: true }));
        }
        // Ancestors: messages whose Message-ID is in the seed's References (bounded).
        for (const mid of [...refIds].slice(0, 20)) {
          addFound(await client.search({ header: { "message-id": mid } }, { uid: true }));
        }
        if (uidSet.size <= 1) return null; // only the seed → caller falls back to subject

        const uids = [...uidSet].slice(0, limit);
        const msgs: ImapMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(","),
          { envelope: true, flags: true },
          { uid: true }
        )) {
          msgs.push(msg);
        }
        msgs.sort((a, b) => dateMs(a) - dateMs(b)); // oldest first
        const subject = seed.envelope?.subject || "(no subject)";
        const structured = {
          subject,
          count: msgs.length,
          messages: msgs.map((m) => ({
            id: encodeImapId(ref.account, ref.path, m.uid),
            subject: m.envelope?.subject || "(no subject)",
            sender: senderName(m.envelope?.from),
            date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : "",
            isRead: m.flags?.has("\\Seen") ?? false,
          })),
        };
        const text =
          `Thread "${subject}" — ${msgs.length} message(s) via IMAP (References-linked, oldest first):\n` +
          msgs.map((m) => formatRow(m, ref.account, ref.path)).join("\n");
        return { count: msgs.length, text, structured };
      } finally {
        lock.release();
      }
    },
    true
  );
}
