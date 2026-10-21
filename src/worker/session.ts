/**
 * The Durable Object that serves MCP for the Worker.
 *
 * A Worker request cannot keep an IMAP connection for the next request, so
 * every tool call paid for a fresh TLS handshake and login. A single Durable
 * Object instead keeps one connector context: an IMAP connection reused
 * across requests, the in-memory draft cache, and the queue that serializes
 * mail operations. The connection closes after a few idle minutes; an open
 * socket keeps the object in memory and is billed by duration.
 *
 * The object also runs the new-mail webhooks (src/icloud/listeners.ts): its
 * alarm polls the watched mailboxes about once a minute while any exist.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  connectImap,
  resolveImapConfig,
  type ImapClientLike,
  type ImapConnect,
} from "../services/imapClient.js";
import { loadContext, type ConnectorContext, type Preferences } from "../icloud/context.js";
import { kvSettingsStore } from "../icloud/settings.js";
import type { GoogleAccounts } from "../google/accounts.js";
import { createConnectorServer } from "../mcp/server.js";
import { MailWatcher, type WatchClient, type WatchStorage } from "../icloud/listeners.js";
import { googleAccountsFor } from "./accounts.js";
import { workerUploads } from "./uploads.js";
import type { Env } from "./index.js";

/** Close the IMAP connection after this long without a tool call. */
export const IMAP_IDLE_MS = 3 * 60 * 1000;

interface ImapLike extends ImapClientLike {
  usable?: boolean;
  on?(event: "close" | "error", listener: () => void): void;
}

/** Copy string bindings (vars and secrets) into process.env for the shared modules. */
export function syncProcessEnv(env: Env): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") process.env[key] = value;
  }
  return process.env;
}

/**
 * One IMAP connection shared by every operation until it idles out, drops,
 * or fails. Callers receive a view whose logout/close are no-ops, so the
 * shared IMAP helpers cannot end it early.
 */
export function persistentImap(idleMs = IMAP_IDLE_MS, connect: ImapConnect = connectImap) {
  let shared: Promise<ImapLike> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function close(): Promise<void> {
    clearTimeout(timer);
    const pending = shared;
    shared = undefined;
    const client = await pending?.catch(() => undefined);
    await client?.logout().catch(() => undefined);
    client?.close?.();
  }

  function view(client: ImapLike): ImapClientLike {
    return new Proxy(client, {
      get(target, property) {
        if (property === "logout") return async () => undefined;
        if (property === "close") return () => undefined;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  const open: ImapConnect = async (cfg) => {
    clearTimeout(timer);
    timer = setTimeout(() => void close(), idleMs);
    const current = await shared?.catch(() => undefined);
    if (current && current.usable !== false) return view(current);
    // A dead socket still keeps the object in memory; release it first.
    current?.close?.();
    const attempt = connect(cfg) as Promise<ImapLike>;
    shared = attempt;
    let client: ImapLike;
    try {
      client = await attempt;
    } catch (error) {
      if (shared === attempt) shared = undefined;
      throw error;
    }
    const forget = () => {
      if (shared === attempt) shared = undefined;
    };
    client.on?.("close", forget);
    client.on?.("error", forget);
    return view(client);
  };

  return { connect: open, close, isOpen: () => shared !== undefined };
}

/** The Durable Object state the session uses. */
export interface SessionState {
  storage: WatchStorage;
}

export class MailSession {
  private readonly imap = persistentImap();
  private context?: ConnectorContext;
  private watcher?: MailWatcher;
  /** Kept with the object so Google access tokens are reused across requests. */
  private google?: GoogleAccounts | null;

  constructor(
    private readonly state: SessionState,
    private readonly env: Env,
    private readonly connect: ImapConnect = connectImap
  ) {}

  /** New-mail webhooks; iCloud only. */
  private mailWatcher(): MailWatcher | undefined {
    if (!this.env.ICLOUD_MAIL_PREFERENCES || !this.state?.storage) return undefined;
    const ctx = this.connector();
    this.watcher ??= new MailWatcher({
      storage: this.state.storage,
      imapAccount: ctx.account,
      primaryAddress: async () => (await ctx.refresh()).primaryAddress,
      // Its own short-lived connection: polls never disturb the mailbox a tool
      // call has selected, and the object can sleep between alarms.
      connect: async () =>
        (await this.connect(resolveImapConfig(process.env, ctx.account))) as unknown as WatchClient,
    });
    return this.watcher;
  }

  /** Durable Object alarm: one poll of the new-mail webhooks. */
  async alarm(): Promise<void> {
    await this.mailWatcher()?.poll();
  }

  private connector(): ConnectorContext {
    this.context ??= loadContext(syncProcessEnv(this.env), {
      // Seeds the KV settings on first use; afterwards settings are edited from chat.
      preferences: JSON.parse(this.env.ICLOUD_MAIL_PREFERENCES ?? "{}") as Preferences,
      settingsStore: kvSettingsStore(this.env.OAUTH_KV),
      connect: this.imap.connect,
    });
    return this.context;
  }

  private googleAccounts(origin: string): GoogleAccounts | undefined {
    if (this.google === undefined) this.google = googleAccountsFor(this.env) ?? null;
    if (this.google) this.google.manageUrl = `${origin}/accounts`;
    return this.google ?? undefined;
  }

  async fetch(request: Request): Promise<Response> {
    const origin = new URL(this.env.ICLOUD_MAIL_PUBLIC_URL || request.url).origin;
    const icloud = this.env.ICLOUD_MAIL_PREFERENCES ? this.connector() : undefined;
    await icloud?.refresh();
    const server = await createConnectorServer(
      { icloud, google: this.googleAccounts(origin) },
      {
        websiteUrl: `${origin}/`,
        uploads: workerUploads(this.env, origin),
        mailListeners: this.mailWatcher(),
      }
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      return await transport.handleRequest(request);
    } finally {
      // Closes this request's MCP server only; the IMAP connection stays open.
      void server.close();
    }
  }
}
