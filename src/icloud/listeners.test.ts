import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeImapId } from "@/services/imapClient.js";
import {
  MAX_ATTEMPTS,
  MAX_PER_RUN,
  POLL_INTERVAL_MS,
  MailWatcher,
  backoffMs,
  registerMailListenTools,
  type WatchClient,
  type WatchMessage,
  type WatchStorage,
} from "@/icloud/listeners.js";

const PRIMARY = "peter@poieti.com";
const HOOK = "https://hooks.example.com/mail";

function memoryStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: WatchStorage & { data: Map<string, unknown>; alarm: () => number | null } = {
    data,
    alarm: () => alarm,
    async get<T>(key: string) {
      return structuredClone(data.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async getAlarm() {
      return alarm;
    },
    async setAlarm(time: number) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
  return storage;
}

interface Box {
  path: string;
  uidValidity: number;
  messages: WatchMessage[];
  specialUse?: string;
}

function mail(uid: number, subject = `Subject ${uid}`): WatchMessage {
  return {
    uid,
    envelope: {
      subject,
      messageId: `<m${uid}@example.com>`,
      inReplyTo: uid > 1 ? `<m${uid - 1}@example.com>` : undefined,
      date: new Date(Date.UTC(2026, 9, 21, 9, 0, uid)),
      from: [{ name: "Ann", address: "ann@example.com" }],
      to: [{ name: "", address: PRIMARY }],
    },
  };
}

/** A fake IMAP server; records every call so tests can prove it stayed read-only. */
function imapServer(boxes: Record<string, Box>) {
  const calls: string[] = [];
  const connect = vi.fn(async (): Promise<WatchClient> => {
    let selected: Box | undefined;
    return {
      async list() {
        calls.push("LIST");
        return Object.values(boxes).map((b) => ({
          path: b.path,
          name: b.path,
          specialUse: b.specialUse,
        }));
      },
      async mailboxOpen(path, options) {
        calls.push(`${options.readOnly ? "EXAMINE" : "SELECT"} ${path}`);
        selected = Object.values(boxes).find((b) => b.path === path);
        if (!selected) throw new Error(`no mailbox ${path}`);
        const top = Math.max(0, ...selected.messages.map((m) => m.uid));
        return { path, uidValidity: BigInt(selected.uidValidity), uidNext: top + 1 };
      },
      async *fetch(range, query, options) {
        calls.push(`FETCH ${range} ${Object.keys(query).sort().join(",")} uid=${options.uid}`);
        const [lo, hi] = range.split(":").map((x) => (x === "*" ? Infinity : Number(x)));
        const inRange = selected!.messages.filter((m) => m.uid >= lo && m.uid <= hi);
        // Real servers return the newest message for "n:*" even when its UID is below n.
        const out = inRange.length ? inRange : selected!.messages.slice(-1);
        for (const m of out) yield m;
      },
      async logout() {
        calls.push("LOGOUT");
      },
    };
  });
  return { connect, calls, boxes };
}

function setup(options: { status?: () => number; junk?: boolean } = {}) {
  const storage = memoryStorage();
  const boxes: Record<string, Box> = {
    INBOX: { path: "INBOX", uidValidity: 1, messages: [mail(1), mail(2)] },
  };
  if (options.junk !== false) {
    boxes.Junk = { path: "Junk", uidValidity: 7, messages: [mail(10)], specialUse: "\\Junk" };
  }
  const server = imapServer(boxes);
  let now = Date.UTC(2026, 9, 21, 10);
  const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    posts.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(null, { status: options.status?.() ?? 204 });
  });
  const log = vi.fn();
  const watcher = new MailWatcher({
    storage,
    imapAccount: "iCloud",
    primaryAddress: async () => PRIMARY,
    connect: server.connect,
    fetch: fetchImpl,
    now: () => now,
    log,
  });
  return {
    watcher,
    storage,
    server,
    boxes,
    posts,
    fetchImpl,
    log,
    advance: (ms: number) => (now += ms),
    newWatcher: () =>
      new MailWatcher({
        storage,
        imapAccount: "iCloud",
        primaryAddress: async () => PRIMARY,
        connect: server.connect,
        fetch: fetchImpl,
        now: () => now,
        log,
      }),
  };
}

describe("mail_listen_set validation", () => {
  it("defaults to the iCloud primary address and INBOX, and schedules a poll", async () => {
    const t = setup();
    const result = await t.watcher.set({ name: "courier", url: HOOK });
    expect(result.listener).toMatchObject({
      name: "courier",
      account: PRIMARY,
      mailboxes: ["INBOX"],
    });
    expect(result.baseline).toContain("INBOX UID 2");
    expect(t.storage.alarm()).toBe(Date.UTC(2026, 9, 21, 10) + POLL_INTERVAL_MS);
  });

  it("accepts the primary address in any case and the iCloud account label", async () => {
    const t = setup();
    expect(await t.watcher.resolveAccount("Peter@Poieti.com")).toBe(PRIMARY);
    expect(await t.watcher.resolveAccount("iCloud")).toBe(PRIMARY);
  });

  it.each(["girlfriend", "someone@gmail.com", "hello@poieti.com"])(
    "refuses to watch %s",
    async (account) => {
      const t = setup();
      await expect(t.watcher.set({ name: "x", url: HOOK, account })).rejects.toThrow(
        /Only the iCloud account peter@poieti\.com/
      );
      expect(await t.watcher.listeners()).toEqual([]);
      expect(t.server.connect).not.toHaveBeenCalled();
    }
  );

  it("requires an https url and valid header names", async () => {
    const t = setup();
    await expect(t.watcher.set({ name: "x", url: "http://hooks.example.com" })).rejects.toThrow(
      /https/
    );
    await expect(t.watcher.set({ name: "x", url: "not a url" })).rejects.toThrow(/https/);
    await expect(
      t.watcher.set({ name: "x", url: HOOK, headers: { "bad header": "1" } })
    ).rejects.toThrow(/header name/);
  });

  it("replaces a listener with the same name and re-baselines it", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    t.boxes.INBOX.messages.push(mail(3));
    await t.watcher.set({ name: "courier", url: `${HOOK}/v2`, mailboxes: ["INBOX", "Junk"] });
    const all = await t.watcher.listeners();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ url: `${HOOK}/v2`, mailboxes: ["INBOX", "Junk"] });
    await t.watcher.poll();
    // UID 3 arrived before the replacement, so the new listener starts after it.
    expect(t.posts).toEqual([]);
  });

  it("lists listeners with header values hidden, and removes them", async () => {
    const t = setup();
    await t.watcher.set({
      name: "courier",
      url: HOOK,
      headers: { Authorization: "Bearer s3cret" },
    });
    const listed = await t.watcher.list();
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    expect(listed[0]).toMatchObject({
      headers: { Authorization: "(set)" },
      state: { INBOX: { lastUid: 2, pendingRetry: null } },
    });
    expect(await t.watcher.remove("courier")).toEqual({ removed: "courier" });
    expect(await t.watcher.listeners()).toEqual([]);
    expect(t.storage.alarm()).toBeNull();
    expect([...t.storage.data.keys()].filter((k) => k.startsWith("mail-listen-state"))).toEqual([]);
    await expect(t.watcher.remove("courier")).rejects.toThrow(/No listener named "courier"/);
  });

  it("keeps the listener when the mailbox cannot be read yet", async () => {
    const t = setup();
    t.server.connect.mockRejectedValueOnce(new Error("offline"));
    const result = await t.watcher.set({ name: "courier", url: HOOK });
    expect(result.baseline).toMatch(/offline/);
    expect(await t.watcher.listeners()).toHaveLength(1);
    await t.watcher.poll(); // sets the baseline
    t.boxes.INBOX.messages.push(mail(3));
    await t.watcher.poll();
    expect(t.posts.map((p) => p.body.message.subject)).toEqual(["Subject 3"]);
  });
});

describe("polling", () => {
  it("posts headers only, with an id read_message accepts", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK, headers: { Authorization: "Bearer k" } });
    t.boxes.INBOX.messages.push(mail(3, "Re: hello"));
    await t.watcher.poll();
    expect(t.posts).toHaveLength(1);
    const [post] = t.posts;
    expect(post.url).toBe(HOOK);
    expect(post.headers).toEqual({ "content-type": "application/json", Authorization: "Bearer k" });
    expect(post.body).toEqual({
      text: "New mail in INBOX from Ann: Re: hello",
      listener: "courier",
      account: PRIMARY,
      mailbox: "INBOX",
      message: {
        id: expect.stringMatching(/^imap:[A-Za-z0-9_-]+$/),
        rfcMessageId: "<m3@example.com>",
        inReplyTo: "<m2@example.com>",
        from: { name: "Ann", address: "ann@example.com" },
        to: [{ name: null, address: PRIMARY }],
        subject: "Re: hello",
        date: "2026-10-21T09:00:03.000Z",
      },
    });
    expect(decodeImapId(post.body.message.id)).toEqual({
      account: "iCloud",
      path: "INBOX",
      uid: 3,
    });
  });

  it("only EXAMINEs and fetches envelopes, never bodies or flags", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK, mailboxes: ["INBOX", "Junk"] });
    t.boxes.INBOX.messages.push(mail(3));
    t.boxes.Junk.messages.push(mail(11));
    await t.watcher.poll();
    expect(t.server.calls.filter((c) => /^(SELECT|STORE)/.test(c))).toEqual([]);
    expect(t.server.calls.filter((c) => c.startsWith("FETCH"))).toEqual([
      "FETCH 3:3 envelope,uid uid=true",
      "FETCH 11:11 envelope,uid uid=true",
    ]);
    expect(t.server.calls).toContain("EXAMINE Junk");
    expect(t.server.calls.at(-1)).toBe("LOGOUT");
    expect(t.posts.map((p) => [p.body.mailbox, p.body.message.subject])).toEqual([
      ["INBOX", "Subject 3"],
      ["Junk", "Subject 11"],
    ]);
  });

  it("does not backfill and does not replay after a restart", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    await t.watcher.poll();
    expect(t.posts).toEqual([]);
    t.boxes.INBOX.messages.push(mail(3), mail(4));
    await t.watcher.poll();
    expect(t.posts.map((p) => p.body.message.subject)).toEqual(["Subject 3", "Subject 4"]);
    // A fresh object (Durable Object restart) reads the stored UID.
    const restarted = t.newWatcher();
    await restarted.poll();
    await restarted.poll();
    expect(t.posts).toHaveLength(2);
  });

  it("ignores the newest message that n:* returns when nothing is new", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    await t.watcher.poll();
    expect(t.server.calls.filter((c) => c.startsWith("FETCH"))).toEqual([]);
    expect(t.posts).toEqual([]);
  });

  it("re-baselines without firing when UIDVALIDITY changes", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    t.boxes.INBOX.uidValidity = 2;
    t.boxes.INBOX.messages = [mail(1), mail(2), mail(3), mail(4), mail(5)];
    await t.watcher.poll();
    expect(t.posts).toEqual([]);
    t.boxes.INBOX.messages.push(mail(6));
    await t.watcher.poll();
    expect(t.posts.map((p) => p.body.message.subject)).toEqual(["Subject 6"]);
  });

  it("skips UIDs of expunged messages", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    t.boxes.INBOX.messages.push(mail(7));
    await t.watcher.poll();
    expect(t.posts.map((p) => p.body.message.subject)).toEqual(["Subject 7"]);
    expect((await t.watcher.list())[0].state.INBOX).toMatchObject({ lastUid: 7 });
  });

  it("delivers at most MAX_PER_RUN messages a run and continues next run", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    for (let uid = 3; uid < 3 + MAX_PER_RUN + 5; uid++) t.boxes.INBOX.messages.push(mail(uid));
    await t.watcher.poll();
    expect(t.posts).toHaveLength(MAX_PER_RUN);
    await t.watcher.poll();
    expect(t.posts).toHaveLength(MAX_PER_RUN + 5);
    expect(new Set(t.posts.map((p) => p.body.message.subject)).size).toBe(MAX_PER_RUN + 5);
  });

  it("keeps polling after an IMAP failure", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    t.server.connect.mockRejectedValueOnce(new Error("connection reset"));
    await t.storage.deleteAlarm(); // the alarm that is now running
    await t.watcher.poll();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
    expect(t.storage.alarm()).not.toBeNull();
    t.boxes.INBOX.messages.push(mail(3));
    await t.watcher.poll();
    expect(t.posts).toHaveLength(1);
  });

  it("stops scheduling once no listener is left", async () => {
    const t = setup();
    await t.watcher.poll();
    expect(t.storage.alarm()).toBeNull();
    expect(t.server.connect).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("backs off exponentially up to the cap", () => {
    expect(backoffMs(1)).toBe(POLL_INTERVAL_MS);
    expect(backoffMs(2)).toBe(2 * POLL_INTERVAL_MS);
    expect(backoffMs(3)).toBe(4 * POLL_INTERVAL_MS);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });

  it("retries a non-2xx delivery with backoff, in order, then sends once", async () => {
    let status = 500;
    const t = setup({ status: () => status });
    await t.watcher.set({ name: "courier", url: HOOK });
    t.boxes.INBOX.messages.push(mail(3), mail(4));

    await t.watcher.poll(); // attempt 1 fails; UID 4 waits behind UID 3
    expect(t.posts.map((p) => p.body.message.subject)).toEqual(["Subject 3"]);
    expect((await t.watcher.list())[0].state.INBOX).toMatchObject({
      lastUid: 2,
      pendingRetry: { uid: 3, attempts: 1, error: "HTTP 500" },
    });

    t.advance(POLL_INTERVAL_MS);
    await t.watcher.poll(); // attempt 2 fails; next one is due in 2 intervals
    expect(t.posts).toHaveLength(2);

    t.advance(POLL_INTERVAL_MS);
    await t.watcher.poll(); // still backing off
    expect(t.posts).toHaveLength(2);

    status = 200;
    t.advance(POLL_INTERVAL_MS);
    await t.watcher.poll();
    expect(t.posts.map((p) => p.body.message.subject)).toEqual([
      "Subject 3",
      "Subject 3",
      "Subject 3",
      "Subject 4",
    ]);
    expect((await t.watcher.list())[0].state.INBOX).toEqual({ lastUid: 4, pendingRetry: null });

    t.advance(POLL_INTERVAL_MS);
    await t.watcher.poll();
    expect(t.posts).toHaveLength(4);
  });

  it("treats network errors as failures", async () => {
    const t = setup();
    await t.watcher.set({ name: "courier", url: HOOK });
    t.fetchImpl.mockRejectedValueOnce(new Error("timeout"));
    t.boxes.INBOX.messages.push(mail(3));
    await t.watcher.poll();
    expect((await t.watcher.list())[0].state.INBOX).toMatchObject({
      pendingRetry: { uid: 3, attempts: 1, error: "timeout" },
    });
  });

  it("gives up on a message after MAX_ATTEMPTS and moves on", async () => {
    let status = 503;
    const t = setup({ status: () => status });
    await t.watcher.set({ name: "courier", url: HOOK });
    t.boxes.INBOX.messages.push(mail(3), mail(4));
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      await t.watcher.poll();
      t.advance(30 * 60_000);
    }
    expect(t.posts).toHaveLength(MAX_ATTEMPTS - 1);
    status = 200;
    // Pretend the final attempt fails too, then UID 4 goes out.
    t.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 502 }));
    await t.watcher.poll();
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining("gave up on INBOX UID 3"));
    expect(t.posts.at(-1)?.body.message.subject).toBe("Subject 4");
    expect((await t.watcher.list())[0].state.INBOX).toEqual({ lastUid: 4, pendingRetry: null });
  });

  it("keeps one listener's failures from blocking another", async () => {
    const t = setup();
    await t.watcher.set({ name: "a", url: "https://a.example.com/hook" });
    await t.watcher.set({ name: "b", url: "https://b.example.com/hook" });
    t.fetchImpl.mockImplementation(async (url: string, init: RequestInit) => {
      t.posts.push({ url, headers: {}, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: url.includes("a.example") ? 500 : 200 });
    });
    t.boxes.INBOX.messages.push(mail(3));
    await t.watcher.poll();
    const listed = await t.watcher.list();
    expect(listed.find((l) => l.name === "a")?.state.INBOX).toMatchObject({ lastUid: 2 });
    expect(listed.find((l) => l.name === "b")?.state.INBOX).toEqual({
      lastUid: 3,
      pendingRetry: null,
    });
  });
});

describe("MCP tools", () => {
  async function connected() {
    const t = setup();
    const server = new McpServer({ name: "test", version: "0" });
    registerMailListenTools(server, t.watcher);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { t, client };
  }

  it("publishes mail_listen_set, mail_listen_list and mail_listen_remove", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      "mail_listen_list",
      "mail_listen_remove",
      "mail_listen_set",
    ]);
  });

  it("round-trips through the tools, accepting null optionals", async () => {
    const { client } = await connected();
    const set = await client.callTool({
      name: "mail_listen_set",
      arguments: { name: "courier", url: HOOK, account: null, mailboxes: null, headers: null },
    });
    expect(set.isError).toBe(false);
    const listed = await client.callTool({ name: "mail_listen_list", arguments: {} });
    expect(JSON.parse((listed.content as any)[0].text)[0]).toMatchObject({
      name: "courier",
      mailboxes: ["INBOX"],
    });
    const refused = await client.callTool({
      name: "mail_listen_set",
      arguments: { name: "gf", url: HOOK, account: "girlfriend" },
    });
    expect(refused.isError).toBe(true);
    const removed = await client.callTool({
      name: "mail_listen_remove",
      arguments: { name: "courier" },
    });
    expect(JSON.parse((removed.content as any)[0].text)).toEqual({ removed: "courier" });
  });

  it("rejects mailboxes other than INBOX and Junk", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "mail_listen_set",
      arguments: { name: "x", url: HOOK, mailboxes: ["Sent"] },
    });
    expect(result.isError).toBe(true);
  });
});
