import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import { GRANT_CHECK_INTERVAL_MS } from "@/icloud/listeners.js";
import { withGrantHeader } from "@/worker/grants.js";
import { MailSession, persistentImap } from "@/worker/session.js";

const cfg = {
  host: "imap.example.com",
  port: 993,
  secure: true,
  user: "u",
  pass: "p",
} as ImapConfig;

function fakeClient() {
  const events = new EventEmitter();
  const client = {
    usable: true,
    logout: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    noop: vi.fn(async () => undefined),
    on: (event: string, listener: () => void) => events.on(event, listener),
    emit: (event: string) => events.emit(event),
  };
  return client;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("persistent IMAP connection", () => {
  it("reuses one login across operations and hides logout from callers", async () => {
    const client = fakeClient();
    const connect = vi.fn(async () => client as unknown as ImapClientLike);
    const imap = persistentImap(60_000, connect);

    const first = await imap.connect(cfg);
    await first.logout();
    first.close?.();
    await first.noop();
    await imap.connect(cfg);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.logout).not.toHaveBeenCalled();
    expect(client.noop).toHaveBeenCalledTimes(1);
    await imap.close();
    expect(client.logout).toHaveBeenCalledTimes(1);
  });

  it("logs out after the idle window and reconnects on the next call", async () => {
    vi.useFakeTimers();
    const clients = [fakeClient(), fakeClient()];
    const connect = vi.fn(
      async () => clients[connect.mock.calls.length - 1] as unknown as ImapClientLike
    );
    const imap = persistentImap(1000, connect);

    await imap.connect(cfg);
    await vi.advanceTimersByTimeAsync(999);
    expect(imap.isOpen()).toBe(true);
    await imap.connect(cfg); // activity restarts the idle window
    await vi.advanceTimersByTimeAsync(999);
    expect(clients[0].logout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(clients[0].logout).toHaveBeenCalledTimes(1);
    expect(imap.isOpen()).toBe(false);

    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);
    await imap.close();
  });

  it("replaces a connection that dropped or became unusable", async () => {
    const clients = [fakeClient(), fakeClient(), fakeClient()];
    const connect = vi.fn(
      async () => clients[connect.mock.calls.length - 1] as unknown as ImapClientLike
    );
    const imap = persistentImap(60_000, connect);

    await imap.connect(cfg);
    clients[0].emit("close");
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);

    clients[1].usable = false;
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(3);
    // The dead socket is released rather than left holding the object in memory.
    expect(clients[1].close).toHaveBeenCalled();
    await imap.close();
  });

  it("does not cache a failed login", async () => {
    const client = fakeClient();
    const connect = vi
      .fn()
      .mockRejectedValueOnce(new Error("AUTHENTICATIONFAILED"))
      .mockResolvedValueOnce(client);
    const imap = persistentImap(60_000, connect);

    await expect(imap.connect(cfg)).rejects.toThrow("AUTHENTICATIONFAILED");
    expect(imap.isOpen()).toBe(false);
    await imap.connect(cfg);
    expect(connect).toHaveBeenCalledTimes(2);
    await imap.close();
  });
});

describe("new-mail webhooks after OAuth revocation", () => {
  // Runs the real session, MCP tool and OAuth library over synthetic storage.
  function harness() {
    const kv = new Map<string, string>();
    const OAUTH_KV = {
      async get(key: string, options?: { type?: string }) {
        const value = kv.get(key) ?? null;
        return value && options?.type === "json" ? JSON.parse(value) : value;
      },
      async put(key: string, value: string) {
        kv.set(key, value);
      },
      async delete(key: string) {
        kv.delete(key);
      },
      async list({ prefix }: { prefix: string }) {
        const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return { keys, list_complete: true };
      },
    };
    const data = new Map<string, unknown>();
    let alarm: number | null = null;
    const storage = {
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
    const messages = [{ uid: 1, envelope: { subject: "Before" } }];
    const connect = async () => ({
      list: async () => [],
      mailboxOpen: async (path: string) => ({
        path,
        uidValidity: 1,
        uidNext: messages[messages.length - 1].uid + 1,
      }),
      fetch: async function* () {
        yield* messages;
      },
      logout: async () => undefined,
    });
    const session = new MailSession(
      { storage },
      {
        OAUTH_KV,
        ICLOUD_MAIL_PREFERENCES: JSON.stringify({
          primaryAddress: "owner@example.com",
          signatures: {},
        }),
        ICLOUD_MAIL_ADDRESS_DISCOVERY: "off",
        APPLE_MAIL_MCP_IMAP_HOST: "imap.mail.me.com",
        APPLE_MAIL_MCP_IMAP_USER: "owner@example.com",
        APPLE_MAIL_MCP_IMAP_PASSWORD: "dummy",
        APPLE_MAIL_MCP_SMTP_HOST: "smtp.mail.me.com",
        APPLE_MAIL_MCP_SMTP_USER: "owner@example.com",
        APPLE_MAIL_MCP_SMTP_PASSWORD: "dummy",
        APPLE_MAIL_MCP_SMTP_FROM: "owner@example.com",
      } as never,
      connect as never
    );
    const posts: string[] = [];
    vi.stubGlobal("CONNECTOR_VERSION", "0.0.0"); // Defined by wrangler.jsonc when deployed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        posts.push(JSON.parse(String(init.body)).message.subject);
        return new Response(null, { status: 204 });
      })
    );
    let now = Date.UTC(2026, 10, 6);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    return {
      kv,
      data,
      session,
      posts,
      messages,
      alarm: () => alarm,
      advance: (ms: number) => (now += ms),
      setListener: (grantId: string) =>
        session.fetch(
          withGrantHeader(
            new Request("https://worker.example/mcp", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "mail_listen_set",
                  arguments: {
                    name: "hook",
                    url: "https://receiver.example/hook",
                    headers: { Authorization: "Bearer dummy" },
                  },
                },
              }),
            }),
            grantId
          )
        ),
    };
  }

  it("stops when the grant is deleted from OAUTH_KV, as docs/WORKER.md instructs", async () => {
    const t = harness();
    const grant = { id: "grant-1", clientId: "client", userId: "owner", scope: ["mail"] };
    t.kv.set("grant:owner:grant-1", JSON.stringify(grant));
    const response = await t.setListener("grant-1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("its connection is revoked or expires");

    t.messages.push({ uid: 2, envelope: { subject: "While approved" } });
    t.advance(60_000);
    await t.session.alarm();
    expect(t.posts).toEqual(["While approved"]);

    t.kv.delete("grant:owner:grant-1");
    // The last read of the grants stands for up to one check interval.
    t.advance(GRANT_CHECK_INTERVAL_MS);
    t.messages.push({ uid: 3, envelope: { subject: "After revocation" } });
    for (let i = 0; i < 6; i++) {
      t.advance(60_000);
      await t.session.alarm();
    }
    expect(t.posts).toEqual(["While approved"]);
    expect(t.alarm()).toBeNull();
    expect(JSON.stringify([...t.data])).not.toContain("Bearer dummy");
  });
});
