/**
 * Connector settings the user can change from chat: the primary address,
 * the addresses mail may be sent from, and per-address signatures.
 *
 * iCloud exposes no API for its alias or custom-domain configuration, so the
 * address list is kept here: seeded from the account configuration, extended
 * automatically with addresses found in Sent (proof iCloud accepted them as
 * senders), and edited on request. Addresses the user removes are remembered
 * so discovery does not add them back.
 */
export interface Settings {
  version: 1;
  primaryAddress: string;
  addresses: string[];
  signatures: Record<string, string>;
  /** Removed by the user; discovery never re-adds them. */
  excluded: string[];
  /** When Sent and the inbox were last scanned for addresses. */
  discoveredAt?: string;
  /** Name shown with every sending address, e.g. "Shao Yu Huang". */
  displayName?: string;
  /** Per-address names that replace displayName. */
  displayNames?: Record<string, string>;
}

export interface SettingsStore {
  load(): Promise<Settings | null>;
  save(settings: Settings): Promise<void>;
}

export interface SettingsUpdate {
  primaryAddress?: string;
  addAddresses?: string[];
  removeAddresses?: string[];
}

/** Mail providers whose domains are shared, so they never suggest aliases. */
const SHARED_DOMAINS = new Set(["icloud.com", "me.com", "mac.com"]);
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;

export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function includes(list: string[], address: string): boolean {
  return list.some((item) => sameAddress(item, address));
}

function unique(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const address = raw.trim();
    if (address && !includes(out, address)) out.push(address);
  }
  return out;
}

/** Every address that appears in a header value such as `Name <a@b.c>, d@e.f`. */
export function addressesIn(header: string): string[] {
  return unique(header.match(EMAIL) ?? []);
}

/** Build first-run settings from the account configuration and saved preferences. */
export function seedSettings(
  env: NodeJS.ProcessEnv,
  preferences: { primaryAddress?: string; signatures?: Record<string, string> } = {}
): Settings {
  const addresses = unique(
    [
      env.APPLE_MAIL_MCP_SMTP_USER,
      env.APPLE_MAIL_MCP_SMTP_FROM,
      ...(env.APPLE_MAIL_MCP_SMTP_ALLOWED_FROM || "").split(","),
    ].filter((value): value is string => Boolean(value))
  );
  if (!addresses.length) throw new Error("No sending address is configured.");
  const primaryAddress =
    addresses.find((address) => sameAddress(address, preferences.primaryAddress ?? "")) ??
    addresses[0];
  return {
    version: 1,
    primaryAddress,
    addresses,
    signatures: { ...(preferences.signatures ?? {}) },
    excluded: [],
  };
}

/** Validate a stored document, so a corrupt store fails loudly instead of sending as anyone. */
export function parseSettings(value: unknown): Settings {
  const s = value as Partial<Settings> | null;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.primaryAddress !== "string" ||
    !Array.isArray(s.addresses) ||
    !s.addresses.every((a) => typeof a === "string") ||
    !includes(s.addresses, s.primaryAddress)
  ) {
    throw new Error("Stored connector settings are invalid.");
  }
  return {
    version: 1,
    primaryAddress: s.primaryAddress,
    addresses: unique(s.addresses),
    signatures: Object.fromEntries(
      Object.entries(s.signatures ?? {}).filter(([, text]) => typeof text === "string")
    ),
    excluded: Array.isArray(s.excluded) ? unique(s.excluded.map(String)) : [],
    discoveredAt: typeof s.discoveredAt === "string" ? s.discoveredAt : undefined,
    ...(typeof s.displayName === "string" && s.displayName && { displayName: s.displayName }),
    ...(s.displayNames && {
      displayNames: Object.fromEntries(
        Object.entries(s.displayNames).filter(([, name]) => typeof name === "string" && name)
      ),
    }),
  };
}

/** The name shown with `address`: its own, else the default, else none. */
export function displayNameFor(settings: Settings, address: string): string | undefined {
  const own = Object.entries(settings.displayNames ?? {}).find(([key]) =>
    sameAddress(key, address)
  )?.[1];
  return own || settings.displayName || undefined;
}

/** `"Name" <address>`, or the bare address when it has no name. */
export function formatSender(settings: Settings, address: string): string {
  const name = displayNameFor(settings, address);
  return name ? `"${name.replace(/["\\]/g, "")}" <${address}>` : address;
}

/**
 * Set or, with an empty name, clear a display name: the default for every
 * address when `from` is omitted, otherwise one address's own name.
 */
export function applyDisplayName(settings: Settings, name: string, from?: string): Settings {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length > 100 || /[<>"\\]/.test(clean)) {
    throw new Error('A display name is up to 100 characters without < > " or \\.');
  }
  if (!from) {
    const next: Settings = { ...settings, displayName: clean };
    if (!clean) delete next.displayName;
    return next;
  }
  const address = settings.addresses.find((item) => sameAddress(item, from));
  if (!address) throw new Error(`"${from}" is not a sending address.`);
  const displayNames = Object.fromEntries(
    Object.entries(settings.displayNames ?? {}).filter(([key]) => !sameAddress(key, address))
  );
  if (clean) displayNames[address] = clean;
  return { ...settings, displayNames };
}

/** Apply an explicit user change. Throws on anything that would leave no valid sender. */
export function applySettingsUpdate(settings: Settings, update: SettingsUpdate): Settings {
  const added = unique(update.addAddresses ?? []);
  const removed = unique(update.removeAddresses ?? []);
  for (const address of [...added, ...removed, update.primaryAddress ?? ""]) {
    if (address && addressesIn(address)[0] !== address.trim()) {
      throw new Error(`"${address}" is not a valid email address.`);
    }
  }
  const overlap = added.find((address) => includes(removed, address));
  if (overlap) throw new Error(`"${overlap}" cannot be both added and removed.`);
  const addresses = unique([...settings.addresses, ...added]).filter(
    (address) => !includes(removed, address)
  );
  if (!addresses.length) throw new Error("At least one sending address must remain.");
  const primaryAddress = update.primaryAddress?.trim() || settings.primaryAddress;
  if (!includes(addresses, primaryAddress)) {
    throw new Error(
      update.primaryAddress
        ? `"${primaryAddress}" is not a sending address; add it first.`
        : `"${primaryAddress}" is the primary address; choose another primary before removing it.`
    );
  }
  return {
    ...settings,
    primaryAddress: addresses.find((address) => sameAddress(address, primaryAddress))!,
    addresses,
    excluded: unique([...settings.excluded, ...removed]).filter(
      (address) => !includes(added, address)
    ),
  };
}

/** Set or, with an empty signature, clear the signature of one sending address. */
/** `others`: sending addresses outside iCloud, such as linked Gmail accounts, that may have one too. */
export function applySignature(
  settings: Settings,
  from: string,
  signature: string,
  others: string[] = []
): Settings {
  const address = [...settings.addresses, ...others].find((item) => sameAddress(item, from));
  if (!address) throw new Error(`"${from}" is not a sending address.`);
  const signatures = Object.fromEntries(
    Object.entries(settings.signatures).filter(([key]) => !sameAddress(key, address))
  );
  if (signature.trim()) signatures[address] = signature.replace(/\r\n?/g, "\n").trimEnd();
  return { ...settings, signatures };
}

export interface DiscoveryResult {
  settings: Settings;
  /** Sent-from addresses newly added as senders. */
  added: string[];
  /** Custom-domain recipients that look like the user's own, for confirmation. */
  suggested: string[];
}

/**
 * Merge addresses found on the server. Senders seen in Sent are trusted: iCloud
 * only sends as addresses the account owns. Inbox recipients are only
 * suggested, and only on custom domains the user already sends from.
 */
export function mergeDiscovered(
  settings: Settings,
  sentFrom: string[],
  inboxRecipients: string[],
  now = new Date()
): DiscoveryResult {
  const blocked = (address: string) =>
    includes(settings.addresses, address) || includes(settings.excluded, address);
  const added = unique(sentFrom).filter((address) => !blocked(address));
  const addresses = [...settings.addresses, ...added];
  const domains = new Set(
    addresses
      .map((address) => address.split("@")[1]?.toLowerCase())
      .filter((domain): domain is string => Boolean(domain) && !SHARED_DOMAINS.has(domain!))
  );
  const suggested = unique(inboxRecipients).filter(
    (address) =>
      domains.has(address.split("@")[1]?.toLowerCase() ?? "") &&
      !includes(addresses, address) &&
      !includes(settings.excluded, address)
  );
  return {
    settings: { ...settings, addresses, discoveredAt: now.toISOString() },
    added,
    suggested,
  };
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** Settings kept in Workers KV. */
export function kvSettingsStore(kv: KvLike, key = "settings:v1"): SettingsStore {
  return {
    async load() {
      const raw = await kv.get(key);
      return raw === null ? null : parseSettings(JSON.parse(raw));
    },
    async save(settings) {
      await kv.put(key, JSON.stringify(settings));
    },
  };
}
