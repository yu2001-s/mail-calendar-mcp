/**
 * An iCloud conversation, found in every folder. IMAP has no thread IDs, and
 * the replies you send are in Sent, apart from the mail they answer, so a
 * keyword search sees only the messages that happen to contain the keyword.
 * A conversation is the messages its reply headers (Message-ID, In-Reply-To,
 * References) link together, and, for mail whose headers were dropped, the
 * messages with the same subject to or from the same people.
 */
import type { FetchMessageObject, ImapFlow, SearchObject } from "imapflow";
import { imapFolderPaths, type Mailbox } from "./query.js";

/** Messages returned from one conversation at most: the newest. */
export const CONVERSATION_LIMIT = 50;
/** Message-IDs searched for in one round, and rounds that follow newly found ones. */
const IDS_PER_ROUND = 20;
const ROUNDS = 3;

const REPLY_PREFIX =
  /^\s*(?:(?:re|fwd?|aw|sv|antw|回覆|回复|答覆|答复|轉寄|转发)\s*(?:\[\d+\])?\s*[:：]\s*)+/i;

/** A subject without its Re:, Fwd: and similar prefixes. */
export function baseSubject(subject: string | undefined): string {
  return (subject ?? "").replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim();
}

function messageIds(text: string | undefined): string[] {
  return text?.match(/<[^<>\s]+>/g) ?? [];
}

type Client = Pick<ImapFlow, "list" | "getMailboxLock" | "search" | "fetch">;

interface Found {
  path: string;
  uid: number;
  date: number;
  messageId?: string;
  /** The Message-IDs this one answers: In-Reply-To and References. */
  answers: string[];
  subject: string;
  people: string[];
}

function found(path: string, message: FetchMessageObject): Found {
  const envelope = message.envelope;
  const people = [...(envelope?.from ?? []), ...(envelope?.to ?? []), ...(envelope?.cc ?? [])];
  return {
    path,
    uid: message.uid,
    date: envelope?.date ? new Date(envelope.date).getTime() : 0,
    messageId: messageIds(envelope?.messageId)[0],
    answers: messageIds(`${message.headers?.toString() ?? ""} ${envelope?.inReplyTo ?? ""}`),
    subject: baseSubject(envelope?.subject),
    people: people.flatMap((item) => (item.address ? [item.address.toLowerCase()] : [])),
  };
}

async function fetchFound(client: Client, path: string, uids: number[]): Promise<Found[]> {
  if (!uids.length) return [];
  const lock = await client.getMailboxLock(path);
  try {
    const list: Found[] = [];
    for await (const message of client.fetch(
      uids.join(","),
      { envelope: true, headers: ["references", "in-reply-to"] },
      { uid: true }
    )) {
      list.push(found(path, message));
    }
    return list;
  } finally {
    lock.release();
  }
}

async function searchUids(client: Client, path: string, query: SearchObject): Promise<number[]> {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = await client.search(query, { uid: true });
    return Array.isArray(uids) ? uids : [];
  } finally {
    lock.release();
  }
}

/**
 * The conversation of the message at `seed`, oldest first, from every folder
 * but Drafts, Junk and Trash (and the seed's own). `isOwn` tells the
 * account's own addresses from the people it corresponds with.
 */
export async function findConversation(
  client: Client,
  seed: { path: string; uid: number },
  isOwn: (address: string) => boolean
): Promise<{ messages: Array<{ path: string; uid: number }>; omitted: number }> {
  const paths = imapFolderPaths((await client.list()) as Mailbox[], "all");
  if (!paths.includes(seed.path)) paths.push(seed.path);
  const [first] = await fetchFound(client, seed.path, [seed.uid]);
  if (!first) throw new Error(`The message is no longer in "${seed.path}".`);

  const key = (item: { path: string; uid: number }) => `${item.uid}\n${item.path}`;
  const members = new Map<string, Found>([[key(first), first]]);
  const known = new Set([...(first.messageId ? [first.messageId] : []), ...first.answers]);
  const searched = new Set<string>();
  const people = first.people.filter((address) => !isOwn(address));
  const linked = (item: Found) =>
    (item.messageId !== undefined && known.has(item.messageId)) ||
    item.answers.some((id) => known.has(id));
  const sameTopic = (item: Found) =>
    first.subject !== "" &&
    item.subject === first.subject &&
    item.people.some((address) => people.includes(address));

  for (let round = 0; round < ROUNDS; round++) {
    const ids = [...known].filter((id) => !searched.has(id)).slice(0, IDS_PER_ROUND);
    ids.forEach((id) => searched.add(id));
    const terms = ids.flatMap((id): SearchObject[] => [
      { header: { "message-id": id } },
      { header: { references: id } },
      { header: { "in-reply-to": id } },
    ]);
    if (round === 0 && first.subject && people.length) {
      terms.push({
        subject: first.subject,
        or: people.flatMap((address) => [{ from: address }, { to: address }, { cc: address }]),
      });
    }
    if (!terms.length) break;
    let grew = false;
    for (const path of paths) {
      const uids = (await searchUids(client, path, { or: terms })).filter(
        (uid) => !members.has(key({ path, uid }))
      );
      // IMAP matches substrings, so each candidate is checked in full.
      for (const item of await fetchFound(client, path, uids)) {
        if (!linked(item) && !sameTopic(item)) continue;
        members.set(key(item), item);
        for (const id of [item.messageId, ...item.answers]) {
          if (id && !known.has(id)) {
            known.add(id);
            grew = true;
          }
        }
      }
    }
    if (!grew) break;
  }

  // A message in two folders, such as mail to yourself, counts once.
  const unique = new Map<string, Found>();
  for (const item of members.values()) {
    const id = item.messageId ?? key(item);
    if (!unique.has(id)) unique.set(id, item);
  }
  const sorted = [...unique.values()].sort((a, b) => a.date - b.date);
  const kept = sorted.slice(-CONVERSATION_LIMIT);
  return {
    messages: kept.map(({ path, uid }) => ({ path, uid })),
    omitted: sorted.length - kept.length,
  };
}
