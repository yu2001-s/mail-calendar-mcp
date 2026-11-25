/**
 * The owner's iCloud Contacts, written over CardDAV, so the iPhone shows who is
 * calling: contacts_sync mirrors a directory (comms' people who have a phone
 * number) into cards of one group, "comms".
 *
 * The cards are the directory's: each sync makes them match the list it is
 * given, overwriting a card edited on the phone and deleting the cards of
 * people no longer in the list. Contacts the owner made are never read or
 * touched. A card's UID comes from the directory id, so syncing the same
 * person twice, even concurrently or after the stored state is lost, writes
 * the same card. The state kept in KV (each card's ETag and the hash of what
 * was written) lets a sync skip the cards nobody changed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, toolResult } from "../mcp/tooling.js";

const ROOT = "https://contacts.icloud.com/";
const STATE_KEY = "contacts:v1";
const GROUP_NAME = "comms";
/** Cards written per call, within a Worker's subrequests; the rest wait for the next call. */
export const MAX_WRITES = 200;
const TIMEOUT_MS = 20_000;

export type PhoneLabel = "mobile" | "work" | "home" | "other";

export interface ContactPhone {
  /** E.164, e.g. +886979307742. */
  number: string;
  /** Dialled after a pause. */
  ext?: string;
  label?: PhoneLabel;
}

export interface ContactInput {
  /** The directory's id for the person; the card's UID is derived from it. */
  id: string;
  name: string;
  organization?: string;
  phones: ContactPhone[];
  emails?: string[];
  note?: string;
}

export interface SyncResult {
  contacts: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  /** Cards still to write; call again with the same list. */
  pending: number;
}

interface SyncedCard {
  uid: string;
  /** The card's URL path in the address book. */
  path: string;
  etag?: string;
  hash: string;
}

interface SyncState {
  addressBook?: string;
  cards: Record<string, SyncedCard>;
  group?: SyncedCard;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export interface ContactsOptions {
  /** The Apple ID; iCloud's IMAP login is it. */
  user: string;
  /** An app-specific password. */
  password: string;
  store: KvLike;
  fetch?: typeof fetch;
}

export class ICloudContacts {
  readonly #fetch: typeof fetch;
  /** One sync at a time: two would race on the stored state. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ContactsOptions) {
    // Called bare, the Workers runtime refuses fetch with another this ("Illegal invocation").
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  sync(contacts: ContactInput[]): Promise<SyncResult> {
    const run = this.#queue.then(
      () => this.#sync(contacts),
      () => this.#sync(contacts)
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #sync(contacts: ContactInput[]): Promise<SyncResult> {
    const ids = new Set<string>();
    for (const contact of contacts) {
      if (ids.has(contact.id)) throw new Error(`${contact.id} is in the list twice.`);
      ids.add(contact.id);
    }
    const raw = await this.options.store.get(STATE_KEY);
    const state: SyncState = raw ? JSON.parse(raw) : { cards: {} };
    const before = JSON.stringify(state);
    const book = state.addressBook ?? (await this.#discover());
    state.addressBook = book;
    const result: SyncResult = {
      contacts: contacts.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      pending: 0,
    };
    try {
      const live = await this.#etags(book);
      let writes = 0;
      const write = async (previous: SyncedCard | undefined, uid: string, text: string) => {
        const path = previous?.path ?? new URL(`${uid}.vcf`, book).pathname;
        const hash = await sha256(text);
        const etag = live.get(path);
        if (previous && etag && previous.etag === etag && previous.hash === hash) {
          result.unchanged++;
          return previous;
        }
        if (writes >= MAX_WRITES) {
          result.pending++;
          return previous;
        }
        writes++;
        const written = await this.#put(new URL(path, book).href, text);
        if (etag) result.updated++;
        else result.created++;
        return { uid, path, hash, ...(written && { etag: written }) };
      };

      for (const contact of contacts) {
        const uid = state.cards[contact.id]?.uid ?? (await uidFor(contact.id));
        const card = await write(state.cards[contact.id], uid, vcard(uid, contact));
        if (card) state.cards[contact.id] = card;
      }
      for (const [id, card] of Object.entries(state.cards)) {
        if (ids.has(id)) continue;
        if (writes >= MAX_WRITES) {
          result.pending++;
          continue;
        }
        writes++;
        await this.#delete(new URL(card.path, book).href);
        delete state.cards[id];
        result.deleted++;
      }
      const members = contacts.flatMap((c) => state.cards[c.id]?.uid ?? []);
      const groupUid = state.group?.uid ?? (await uidFor(`group:${GROUP_NAME}`));
      const group = await write(state.group, groupUid, groupCard(groupUid, GROUP_NAME, members));
      if (group) state.group = group;

      // iCloud answers some writes without an ETag; read them back so the next sync can skip them.
      const cards = [...Object.values(state.cards), ...(state.group ? [state.group] : [])];
      if (cards.some((card) => !card.etag)) {
        const after = await this.#etags(book);
        for (const card of cards) card.etag ??= after.get(card.path);
      }
    } finally {
      // What was written stays known even when the sync stopped partway.
      if (JSON.stringify(state) !== before) {
        await this.options.store.put(STATE_KEY, JSON.stringify(state));
      }
    }
    return result;
  }

  /** The URL of the owner's address book: principal, then its home, then the collection in it. */
  async #discover(): Promise<string> {
    const principalXml = await this.#dav(
      "PROPFIND",
      ROOT,
      "0",
      PROPS("<d:current-user-principal/>")
    );
    const principal = hrefIn(principalXml.text, "current-user-principal");
    if (!principal) throw new Error("iCloud Contacts named no principal for this Apple ID.");
    const principalUrl = new URL(principal, principalXml.url).href;
    const homeXml = await this.#dav(
      "PROPFIND",
      principalUrl,
      "0",
      PROPS("<card:addressbook-home-set/>")
    );
    const home = hrefIn(homeXml.text, "addressbook-home-set");
    if (!home) throw new Error("iCloud Contacts named no address book home for this Apple ID.");
    const homeUrl = new URL(home, homeXml.url).href;
    const listing = await this.#dav("PROPFIND", homeUrl, "1", PROPS("<d:resourcetype/>"));
    const book = responses(listing.text).find((r) =>
      /<(?:[\w-]+:)?addressbook[\s/>]/.test(tag(r.body, "resourcetype") ?? "")
    );
    if (!book) throw new Error("iCloud Contacts has no address book for this Apple ID.");
    return new URL(book.href, listing.url).href;
  }

  /** Each card's ETag, by URL path. */
  async #etags(book: string): Promise<Map<string, string>> {
    const listing = await this.#dav("PROPFIND", book, "1", PROPS("<d:getetag/>"));
    const etags = new Map<string, string>();
    for (const r of responses(listing.text)) {
      const etag = tag(r.body, "getetag");
      if (etag) etags.set(new URL(r.href, listing.url).pathname, etag);
    }
    return etags;
  }

  async #put(url: string, text: string): Promise<string | undefined> {
    const { response } = await this.#request("PUT", url, {
      body: text,
      headers: { "content-type": "text/vcard; charset=utf-8" },
    });
    return response.headers.get("etag") ?? undefined;
  }

  async #delete(url: string): Promise<void> {
    await this.#request("DELETE", url, { allow: [404] });
  }

  async #dav(method: string, url: string, depth: string, body: string) {
    const answer = await this.#request(method, url, {
      body,
      headers: { depth, "content-type": "application/xml; charset=utf-8" },
    });
    return { url: answer.url, text: await answer.response.text() };
  }

  /**
   * One request, following redirects by hand: fetch drops the Authorization
   * header when a redirect leaves the origin, and iCloud sends clients on to
   * the partition that holds their data.
   */
  async #request(
    method: string,
    url: string,
    init: { body?: string; headers?: Record<string, string>; allow?: number[] }
  ): Promise<{ response: Response; url: string }> {
    const authorization = `Basic ${btoa(`${this.options.user}:${this.options.password}`)}`;
    let target = url;
    for (let hop = 0; hop < 5; hop++) {
      const response = await this.#fetch(target, {
        method,
        body: init.body,
        headers: { ...init.headers, authorization },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        target = new URL(location, target).href;
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          `iCloud Contacts refused the Apple ID ${this.options.user} with the mail app-specific password (${response.status}).`
        );
      }
      if (!response.ok && !init.allow?.includes(response.status)) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new Error(
          `iCloud Contacts answered ${method} ${new URL(target).pathname} with ${response.status}${detail ? `: ${detail}` : ""}`
        );
      }
      return { response, url: target };
    }
    throw new Error(`iCloud Contacts redirected ${method} ${url} too many times.`);
  }
}

const PROPS = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop>${props}</d:prop></d:propfind>`;

/** The <response> elements of a multistatus answer, with their href. */
export function responses(xml: string): Array<{ href: string; body: string }> {
  const out: Array<{ href: string; body: string }> = [];
  const re = /<((?:[\w-]+:)?)response(?:\s[^>]*)?>([\s\S]*?)<\/\1response>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const href = tag(m[2], "href");
    if (href) out.push({ href, body: m[2] });
  }
  return out;
}

/** The text in the first <name> element, entities decoded; undefined when it is empty or absent. */
export function tag(xml: string, name: string): string | undefined {
  const re = new RegExp(`<((?:[\\w-]+:)?)${name}(?:\\s[^>]*[^/>])?>([\\s\\S]*?)</\\1${name}>`);
  const inner = re.exec(xml)?.[2].trim();
  return inner ? decodeEntities(inner) : undefined;
}

function hrefIn(xml: string, property: string): string | undefined {
  const re = new RegExp(
    `<((?:[\\w-]+:)?)${property}(?:\\s[^>]*[^/>])?>([\\s\\S]*?)</\\1${property}>`
  );
  const inner = re.exec(xml)?.[2];
  return inner ? tag(inner, "href") : undefined;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A UUID derived from the directory id, upper case as Apple writes them. */
export async function uidFor(id: string): Promise<string> {
  const hex = (await sha256(`comms:${id}`)).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
}

const TEL_TYPES: Record<PhoneLabel, string> = {
  mobile: "type=CELL;type=VOICE",
  work: "type=WORK;type=VOICE",
  home: "type=HOME;type=VOICE",
  other: "type=VOICE",
};

/** A vCard 3.0, as iCloud keeps them. */
export function vcard(uid: string, contact: ContactInput): string {
  const [family, given] = nameParts(contact.name);
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//comms//contacts_sync//EN",
    `N:${escape(family)};${escape(given)};;;`,
    `FN:${escape(contact.name)}`,
    ...(contact.organization ? [`ORG:${escape(contact.organization)};`] : []),
    ...contact.phones.map(
      (phone, i) =>
        `TEL;${TEL_TYPES[phone.label ?? "other"]}${i === 0 ? ";type=pref" : ""}:${phone.number}${phone.ext ? `,${phone.ext}` : ""}`
    ),
    ...(contact.emails ?? []).map((email) => `EMAIL;type=INTERNET:${escape(email)}`),
    ...(contact.note ? [`NOTE:${escape(contact.note)}`] : []),
    `X-COMMS-ID:${escape(contact.id)}`,
    `UID:${uid}`,
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** A group card: iCloud keeps groups as cards that list their members' UIDs. */
export function groupCard(uid: string, name: string, members: string[]): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "PRODID:-//comms//contacts_sync//EN",
    `N:${escape(name)}`,
    `FN:${escape(name)}`,
    "X-ADDRESSBOOKSERVER-KIND:group",
    ...members.map((member) => `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${member}`),
    `UID:${uid}`,
    "END:VCARD",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/**
 * Family and given name. A Chinese name of two to four characters is its
 * surname (the first character) and given name; otherwise the last word is
 * the family name.
 */
export function nameParts(name: string): [string, string] {
  const trimmed = name.trim();
  if (/^\p{Script=Han}{2,4}$/u.test(trimmed)) {
    const chars = [...trimmed];
    return [chars[0], chars.slice(1).join("")];
  }
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return [trimmed, ""];
  return [words.at(-1)!, words.slice(0, -1).join(" ")];
}

function escape(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Lines longer than 75 octets continue on the next, after a space (RFC 6350 3.2). */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length ? 74 : 75;
    if (size + bytes > limit) {
      parts.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

const phoneSchema = z.object({
  number: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/)
    .describe("E.164, e.g. +886979307742."),
  ext: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional()
    .describe("An extension, dialled after a pause."),
  label: z.enum(["mobile", "work", "home", "other"]).optional(),
});

const contactSchema = z.object({
  id: z.string().min(1).max(100).describe("The directory's id for the person, e.g. p_…"),
  name: z.string().min(1).max(200),
  organization: z.string().max(200).optional().describe("Shown under the name."),
  phones: z.array(phoneSchema).min(1).max(10),
  emails: z.array(z.string().email()).max(10).optional(),
  note: z.string().max(2000).optional(),
});

export function registerContactsTools(server: McpServer, contacts: ICloudContacts): void {
  registerTool(
    server,
    "contacts_sync",
    {
      description: `Make the owner's iCloud Contacts show a directory, so the iPhone shows who is calling. contacts is the whole directory: each person becomes a card in the "${GROUP_NAME}" group, changed when they change, and the cards of people left out are deleted. These cards belong to the directory: an edit made on the phone is overwritten at the next sync. Contacts the owner made are never read or changed. At most ${MAX_WRITES} cards are written per call; when pending is above 0, call again with the same list.`,
      inputSchema: {
        contacts: z.array(contactSchema).max(5000).describe("Everyone the cards should show."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (args: { contacts: ContactInput[] }) => toolResult(() => contacts.sync(args.contacts))
  );
}
