import nodemailer from "nodemailer";
import type { ImapFlow } from "../services/imapFlow.js";
import { resolveImapConfig, decodeImapId, type ImapDeps } from "../services/imapClient.js";
import { resolveSmtpConfig, sendRawViaSmtp, smtpSession } from "../services/smtpMailer.js";
import { ImapDraftManager } from "../services/imapDraftManager.js";
import type { SendingIdentity } from "../types.js";
import {
  displayNameFor,
  formatSender,
  sameAddress,
  seedSettings,
  type Settings,
  type SettingsStore,
} from "./settings.js";

export type Preferences = {
  primaryAddress?: string;
  signatures?: Record<string, string>;
};

/** Everything the iCloud tools share. */
export interface ConnectorContext {
  account: string;
  /** The current settings; reload with refresh() before relying on them. */
  settings: Settings;
  /** Reload settings from the store, seeding it on first use. */
  refresh(): Promise<Settings>;
  /** Persist new settings and use them for the rest of this context. */
  saveSettings(next: Settings): Promise<void>;
  drafts: ImapDraftManager;
  /** Passed to every pooled IMAP operation. */
  imapDeps: ImapDeps;
  tlsTransport: typeof nodemailer.createTransport;
  withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T>;
  checkId(id: string): void;
  /** Serialize every mail operation, across all sessions of this process. */
  serialize<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ContextOptions {
  /** Seeds the settings on first use. */
  preferences: Preferences;
  /** Where settings live once seeded. */
  settingsStore: SettingsStore;
  /** Supplies IMAP connections; the supplier owns their lifetime. */
  connect: NonNullable<ImapDeps["connect"]>;
}

export function loadContext(env: NodeJS.ProcessEnv, options: ContextOptions): ConnectorContext {
  const account = env.APPLE_MAIL_MCP_IMAP_ACCOUNT || env.APPLE_MAIL_MCP_IMAP_USER;
  if (
    env.APPLE_MAIL_MCP_IMAP_HOST !== "imap.mail.me.com" ||
    env.APPLE_MAIL_MCP_SMTP_HOST !== "smtp.mail.me.com" ||
    !account
  ) {
    throw new Error("Expected the existing iCloud IMAP/SMTP configuration.");
  }
  const seed = seedSettings(env, options.preferences);
  const store = options.settingsStore;
  let settings = seed;
  function senderFor(selector?: string): string | undefined {
    return settings.addresses.find((x) => sameAddress(x, selector ?? settings.primaryAddress));
  }
  function identity(selector?: string): SendingIdentity | null {
    const email = senderFor(selector);
    return email
      ? {
          identityId: email,
          email,
          sender: formatSender(settings, email),
          fullName: displayNameFor(settings, email) ?? "",
          accountId: account!,
          accountName: account!,
          enabled: true,
          isDefault: sameAddress(email, settings.primaryAddress),
        }
      : null;
  }
  const tlsTransport = ((options: any) =>
    nodemailer.createTransport({
      ...options,
      requireTLS: true,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
      logger: false,
      debug: false,
    })) as typeof nodemailer.createTransport;
  const imapDeps: ImapDeps = { account, connect: options.connect };
  const drafts = new ImapDraftManager({
    imapDeps: () => imapDeps,
    resolveIdentity: identity,
    imapAccount: () => account,
    selfAddresses: () => settings.addresses,
    smtpConfig: (id) => {
      // Re-checked at send time: a draft may predate the sender's removal.
      const from = senderFor(id.email);
      if (!from) throw new Error(`"${id.email}" is no longer a sending address.`);
      return { ...resolveSmtpConfig(env), from, allowedFrom: [...settings.addresses] };
    },
    smtpSend: (raw, envelope, config) => sendRawViaSmtp(raw, envelope, config, tlsTransport),
    smtpSession: () => smtpSession(tlsTransport),
  });
  async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const cfg = resolveImapConfig(env, account);
    return fn((await options.connect(cfg)) as unknown as ImapFlow);
  }
  function checkId(id: string) {
    const ref = decodeImapId(id);
    if (!ref || ref.account !== account || !Number.isSafeInteger(ref.uid) || ref.uid < 1) {
      throw new Error("Use a message ID returned by this iCloud connector.");
    }
  }
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  const ctx: ConnectorContext = {
    account,
    get settings() {
      return settings;
    },
    async refresh() {
      const stored = await store.load();
      if (stored) settings = stored;
      else await store.save((settings = seed));
      return settings;
    },
    async saveSettings(next) {
      await store.save(next);
      settings = next;
    },
    drafts,
    imapDeps,
    tlsTransport,
    withImap,
    checkId,
    serialize,
  };
  return ctx;
}
