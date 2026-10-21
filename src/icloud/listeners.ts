/**
 * New-mail webhooks for the iCloud account: mail_listen_set, mail_listen_list
 * and mail_listen_remove, shaped like the LINE connector's line_listen_* tools.
 *
 * A Worker cannot hold an IMAP IDLE connection open, so the MailSession
 * Durable Object polls instead: an alarm every POLL_INTERVAL_MS while at least
 * one listener exists. Each run opens a short-lived connection, EXAMINEs each
 * watched mailbox (read-only, so no flag can change), fetches envelopes only
 * (never a body) for UIDs above the last one delivered, and POSTs one JSON
 * event per message. The last UID and UIDVALIDITY are stored per listener and
 * mailbox, so restarts never replay mail; a new listener starts from the
 * newest message without backfilling.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { encodeImapId } from "../services/imapClient.js";
import { registerTool, toolResult } from "../mcp/tooling.js";

/** How often the Durable Object alarm polls while listeners exist. */
export const POLL_INTERVAL_MS = 60_000;
/** Deliveries of one message before it is skipped. */
export const MAX_ATTEMPTS = 8;
export const MAX_BACKOFF_MS = 30 * 60_000;
/** Messages delivered to one listener per mailbox per run. */
export const MAX_PER_RUN = 25;
/** UIDs fetched per mailbox per run. */
export const MAX_FETCH_UIDS = 200;
const TIMEOUT_MS = 10_000;
const MAX_LISTENERS = 20;

export const WATCHABLE_MAILBOXES = ["INBOX", "Junk"] as const;
export type WatchableMailbox = (typeof WATCHABLE_MAILBOXES)[number];

export interface MailListener {
  name: string;
  url: string;
  headers: Record<string, string>;
  account: string;
  mailboxes: WatchableMailbox[];
  createdAt: string;
}

export interface MailboxState {
  uidValidity: string;
  lastUid: number;
  /** The oldest undelivered message, retried with backoff. */
  retry?: { uid: number; attempts: number; nextAt: number; error: string };
}

/** The subset of Durable Object storage the watcher uses. */
export interface WatchStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface Address {
  name?: string;
  address?: string;
}

interface Envelope {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  from?: Address[];
  to?: Address[];
}

export interface WatchMessage {
  uid: number;
  envelope?: Envelope;
}

/** The ImapFlow calls the watcher makes; none of them can change flags. */
export interface WatchClient {
  list(): Promise<Array<{ path: string; name: string; specialUse?: string }>>;
  mailboxOpen(
    path: string,
    options: { readOnly: true }
  ): Promise<{ path: string; uidValidity: bigint | number | string; uidNext: number }>;
  fetch(
    range: string,
    query: { uid: true; envelope: true },
    options: { uid: true }
  ): AsyncIterable<WatchMessage>;
  logout(): Promise<void>;
  close?(): void;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface WatcherDeps {
  storage: WatchStorage;
  /** The IMAP account label message IDs carry, as read_message expects. */
  imapAccount: string;
  /** The iCloud primary address: the only account that can be watched. */
  primaryAddress: () => Promise<string>;
  /** Opens a dedicated IMAP connection; the watcher logs it out. */
  connect: () => Promise<WatchClient>;
  fetch?: Fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export interface MailListenInput {
  name: string;
  url: string;
  account?: string;
  mailboxes?: WatchableMailbox[];
  headers?: Record<string, string>;
}

const LISTENERS_KEY = "mail-listeners";
const stateKey = (name: string, mailbox: string) =>
  `mail-listen-state:${JSON.stringify([name, mailbox])}`;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function backoffMs(attempts: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Header names only: values often hold webhook secrets. */
function redact(listener: MailListener) {
  return {
    ...listener,
    headers: Object.fromEntries(Object.keys(listener.headers).map((k) => [k, "(set)"])),
  };
}

function address(a?: Address) {
  return a ? { name: a.name || null, address: a.address || null } : null;
}

async function mailboxPath(client: WatchClient, mailbox: WatchableMailbox): Promise<string> {
  if (mailbox === "INBOX") return "INBOX";
  const boxes = await client.list();
  const junk =
    boxes.find((b) => b.specialUse?.toLowerCase() === "\\junk") ??
    boxes.find((b) => ["junk", "spam", "junk e-mail"].includes(b.path.toLowerCase()));
  if (!junk) throw new Error("This iCloud account has no Junk mailbox.");
  return junk.path;
}

export class MailWatcher {
  constructor(private readonly deps: WatcherDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(message: string): void {
    (this.deps.log ?? console.error)(`[mail-listen] ${message}`);
  }

  async listeners(): Promise<MailListener[]> {
    return (await this.deps.storage.get<MailListener[]>(LISTENERS_KEY)) ?? [];
  }

  /** The stored account for a selector; anything but the iCloud account is refused. */
  async resolveAccount(selector?: string): Promise<string> {
    const primary = await this.deps.primaryAddress();
    const wanted = selector?.trim();
    if (
      !wanted ||
      wanted.toLowerCase() === primary.toLowerCase() ||
      wanted === this.deps.imapAccount
    ) {
      return primary;
    }
    throw new Error(
      `Only the iCloud account ${primary} can be watched; "${wanted}" cannot. Gmail and other linked accounts are not supported.`
    );
  }

  async set(input: MailListenInput) {
    const name = input.name.trim();
    if (!name) throw new Error("Give the listener a name.");
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new Error("url must be an absolute https URL.");
    }
    if (url.protocol !== "https:") throw new Error("url must be an absolute https URL.");
    const headers = input.headers ?? {};
    for (const key of Object.keys(headers)) {
      if (!HEADER_NAME.test(key)) throw new Error(`"${key}" is not a valid header name.`);
    }
    const account = await this.resolveAccount(input.account);
    const mailboxes = [...new Set(input.mailboxes?.length ? input.mailboxes : ["INBOX" as const])];
    const listener: MailListener = {
      name,
      url: url.toString(),
      headers,
      account,
      mailboxes,
      createdAt: new Date(this.now()).toISOString(),
    };
    const others = (await this.listeners()).filter((l) => l.name !== name);
    if (others.length >= MAX_LISTENERS) throw new Error(`At most ${MAX_LISTENERS} listeners.`);
    // A replacement starts over from the newest message.
    await this.clearState(name);
    await this.deps.storage.put(LISTENERS_KEY, [...others, listener]);
    let baseline: string;
    try {
      const marks = await this.baseline(listener);
      baseline = `Starting after the newest message: ${marks.join(", ")}.`;
    } catch (e) {
      // The first poll sets the baseline instead.
      baseline = `Could not read the mailbox yet (${errorText(e)}); the first poll starts from the newest message.`;
    }
    await this.schedule();
    return { listener: redact(listener), baseline, pollEverySeconds: POLL_INTERVAL_MS / 1000 };
  }

  async list() {
    const all = await this.listeners();
    return Promise.all(
      all.map(async (l) => ({
        ...redact(l),
        state: Object.fromEntries(
          await Promise.all(
            l.mailboxes.map(async (m) => {
              const s = await this.deps.storage.get<MailboxState>(stateKey(l.name, m));
              return [m, s ? { lastUid: s.lastUid, pendingRetry: s.retry ?? null } : null];
            })
          )
        ),
      }))
    );
  }

  async remove(name: string) {
    const all = await this.listeners();
    const removed = all.find((l) => l.name === name);
    if (!removed) throw new Error(`No listener named "${name}".`);
    await this.deps.storage.put(
      LISTENERS_KEY,
      all.filter((l) => l !== removed)
    );
    await this.clearState(name);
    await this.schedule();
    return { removed: removed.name };
  }

  /** Keeps one alarm pending while listeners exist. */
  async schedule(): Promise<void> {
    const storage = this.deps.storage;
    if ((await this.listeners()).length === 0) {
      await storage.deleteAlarm();
      return;
    }
    if ((await storage.getAlarm()) == null) await storage.setAlarm(this.now() + POLL_INTERVAL_MS);
  }

  /** One poll of every watched mailbox; run from the Durable Object alarm. */
  async poll(): Promise<void> {
    try {
      const listeners = await this.listeners();
      if (listeners.length === 0) return;
      await this.withClient(async (client) => {
        for (const mailbox of WATCHABLE_MAILBOXES) {
          const watching = listeners.filter((l) => l.mailboxes.includes(mailbox));
          if (watching.length === 0) continue;
          try {
            await this.pollMailbox(client, mailbox, watching);
          } catch (e) {
            this.log(`${mailbox}: ${errorText(e)}`);
          }
        }
      });
    } catch (e) {
      this.log(`poll failed: ${errorText(e)}`);
    } finally {
      await this.schedule();
    }
  }

  private async clearState(name: string): Promise<void> {
    for (const m of WATCHABLE_MAILBOXES) await this.deps.storage.delete(stateKey(name, m));
  }

  private async withClient<T>(fn: (client: WatchClient) => Promise<T>): Promise<T> {
    const client = await this.deps.connect();
    try {
      return await fn(client);
    } finally {
      await client.logout().catch(() => client.close?.());
    }
  }

  private async open(client: WatchClient, mailbox: WatchableMailbox) {
    // readOnly makes ImapFlow send EXAMINE: no flag, \Seen included, can change.
    const box = await client.mailboxOpen(await mailboxPath(client, mailbox), { readOnly: true });
    if (!Number.isSafeInteger(box.uidNext) || box.uidNext < 1) {
      throw new Error(`${mailbox} reported no UIDNEXT.`);
    }
    return { path: box.path, uidValidity: String(box.uidValidity), top: box.uidNext - 1 };
  }

  private async baseline(listener: MailListener): Promise<string[]> {
    return this.withClient(async (client) => {
      const marks: string[] = [];
      for (const mailbox of listener.mailboxes) {
        const box = await this.open(client, mailbox);
        await this.deps.storage.put<MailboxState>(stateKey(listener.name, mailbox), {
          uidValidity: box.uidValidity,
          lastUid: box.top,
        });
        marks.push(`${mailbox} UID ${box.top}`);
      }
      return marks;
    });
  }

  private async pollMailbox(
    client: WatchClient,
    mailbox: WatchableMailbox,
    listeners: MailListener[]
  ): Promise<void> {
    const box = await this.open(client, mailbox);
    const active: Array<[MailListener, MailboxState]> = [];
    for (const l of listeners) {
      const key = stateKey(l.name, mailbox);
      const state = await this.deps.storage.get<MailboxState>(key);
      if (!state || state.uidValidity !== box.uidValidity) {
        // New listener, or UIDs were renumbered: start from the newest message.
        await this.deps.storage.put<MailboxState>(key, {
          uidValidity: box.uidValidity,
          lastUid: box.top,
        });
        continue;
      }
      active.push([l, state]);
    }
    if (active.length === 0) return;
    const from = Math.min(...active.map(([, s]) => s.lastUid)) + 1;
    // Checked first: "n:*" returns the newest message even when its UID is below n.
    if (from > box.top) return;
    const to = Math.min(box.top, from + MAX_FETCH_UIDS - 1);
    const messages: WatchMessage[] = [];
    for await (const m of client.fetch(
      `${from}:${to}`,
      { uid: true, envelope: true },
      { uid: true }
    )) {
      if (m.uid >= from && m.uid <= to) messages.push(m);
    }
    messages.sort((a, b) => a.uid - b.uid);
    for (const [l, state] of active) await this.deliver(l, mailbox, box.path, state, messages, to);
  }

  private async deliver(
    l: MailListener,
    mailbox: WatchableMailbox,
    path: string,
    initial: MailboxState,
    messages: WatchMessage[],
    fetchedTo: number
  ): Promise<void> {
    const key = stateKey(l.name, mailbox);
    let state = initial;
    let sent = 0;
    let blocked = false;
    for (const m of messages) {
      if (m.uid <= state.lastUid) continue;
      if (sent >= MAX_PER_RUN) {
        blocked = true;
        break;
      }
      const retry = state.retry?.uid === m.uid ? state.retry : undefined;
      // Half an interval of slack, so a retry due just after this alarm is not pushed to the next.
      if (retry && retry.nextAt - this.now() > POLL_INTERVAL_MS / 2) {
        blocked = true;
        break;
      }
      const error = await this.post(l, mailbox, path, m);
      if (error) {
        const attempts = (retry?.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          this.log(
            `"${l.name}" gave up on ${mailbox} UID ${m.uid} after ${attempts} attempts: ${error}`
          );
          state = { uidValidity: state.uidValidity, lastUid: m.uid };
          await this.deps.storage.put(key, state);
          continue;
        }
        this.log(`"${l.name}" ${mailbox} UID ${m.uid} attempt ${attempts} failed: ${error}`);
        state = {
          ...state,
          retry: { uid: m.uid, attempts, nextAt: this.now() + backoffMs(attempts), error },
        };
        blocked = true;
        break;
      }
      sent++;
      // Saved after each delivery so a crash never sends a message twice.
      state = { uidValidity: state.uidValidity, lastUid: m.uid };
      await this.deps.storage.put(key, state);
    }
    // Skip UIDs with no message (expunged) once everything fetched went out.
    if (!blocked && state.lastUid < fetchedTo) state = { ...state, lastUid: fetchedTo };
    await this.deps.storage.put(key, state);
  }

  /** POSTs one event; returns an error description, or undefined on 2xx. */
  private async post(
    l: MailListener,
    mailbox: WatchableMailbox,
    path: string,
    m: WatchMessage
  ): Promise<string | undefined> {
    const env = m.envelope ?? {};
    const from = address(env.from?.[0]);
    const subject = env.subject ?? "";
    const date = env.date ? new Date(env.date) : undefined;
    const body = {
      text: `New mail in ${mailbox} from ${from?.name || from?.address || "(unknown)"}: ${subject || "(no subject)"}`,
      listener: l.name,
      account: l.account,
      mailbox,
      message: {
        id: encodeImapId(this.deps.imapAccount, path, m.uid),
        rfcMessageId: env.messageId ?? null,
        inReplyTo: env.inReplyTo ?? null,
        from,
        to: (env.to ?? []).map((a) => address(a)),
        subject,
        date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      },
    };
    const send = this.deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    try {
      const res = await send(l.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...l.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => undefined);
      return res.ok ? undefined : `HTTP ${res.status}`;
    } catch (e) {
      return errorText(e);
    }
  }
}

export const MAIL_LISTEN_INSTRUCTIONS =
  "mail_listen_set registers a webhook for new iCloud mail (INBOX, optionally Junk for bounces): each new message's headers are POSTed to it, never its body, and nothing is marked read.";

/** Register mail_listen_set, mail_listen_list and mail_listen_remove. */
export function registerMailListenTools(server: McpServer, watcher: MailWatcher): void {
  registerTool(
    server,
    "mail_listen_set",
    {
      description:
        "Registers a webhook for new iCloud mail. About once a minute, every new message in the chosen mailboxes is POSTed to url as JSON {text, listener, account, mailbox, message: {id, rfcMessageId, inReplyTo, from, to, subject, date}}; message.id works with read_message and create_reply_draft. Headers only, never the body, and nothing is marked read. Each message is sent once; a new listener starts with mail that arrives after it is set. Failed deliveries are retried with backoff. Setting an existing name replaces that listener. Only the iCloud account can be watched, not Gmail accounts.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Name for this listener, e.g. your agent's name"),
        url: z.string().url().describe("https webhook to POST each new message to"),
        account: z
          .string()
          .max(320)
          .optional()
          .describe(
            "The iCloud account's primary address. Defaults to it; no other account is allowed."
          ),
        mailboxes: z
          .array(z.enum(WATCHABLE_MAILBOXES))
          .min(1)
          .max(2)
          .optional()
          .describe('Mailboxes to watch. Defaults to ["INBOX"]; add "Junk" to catch bounces.'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Request headers the webhook needs, e.g. Authorization"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (args: MailListenInput) => toolResult(() => watcher.set(args))
  );
  registerTool(
    server,
    "mail_listen_list",
    {
      description:
        "Lists the new-mail webhooks: name, url, account, mailboxes, header names (values hidden), and the last delivered UID and any pending retry per mailbox.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () => toolResult(() => watcher.list())
  );
  registerTool(
    server,
    "mail_listen_remove",
    {
      description: "Removes a new-mail webhook so it stops getting messages.",
      inputSchema: { name: z.string().min(1).max(100) },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ name }: { name: string }) => toolResult(() => watcher.remove(name))
  );
}
