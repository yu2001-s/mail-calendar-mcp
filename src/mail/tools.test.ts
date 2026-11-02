import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { GoogleAccounts } from "@/google/accounts.js";
import type { ConnectorContext } from "@/icloud/context.js";
import { registerMailTools } from "@/mail/tools.js";
import { encodeImapId } from "@/services/imapClient.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const ME = "me@gmail.com";
const WORK = "work@gmail.com";

function gmailMessage(id: string, account: string, day: number) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX", "UNREAD", "Label_1"],
    snippet: "Can we meet?",
    internalDate: String(Date.UTC(2026, 9, day, 9)),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Amy <amy@example.com>" },
        { name: "To", value: account },
        { name: "Subject", value: "Lunch" },
        { name: "Message-ID", value: `<${id}@mail.example.com>` },
        { name: "Date", value: "Wed, 21 Oct 2026 09:00:00 +0000" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64("Can we meet Thursday?") } },
        {
          mimeType: "application/pdf",
          filename: "menu.pdf",
          body: { attachmentId: "att1", size: 1234 },
        },
      ],
    },
  };
}

interface Call {
  account: string;
  method: string;
  url: string;
  body?: any;
  raw?: string;
}

/** Linked Google accounts that answer from a small fake Gmail. */
function fakeGoogle() {
  const calls: Call[] = [];
  const emails = [ME, WORK];
  let draftMessage = "dm1";
  const route = (account: string, method: string, url: string): any => {
    if (url.startsWith(`${API}/messages?`)) {
      return account === ME
        ? { messages: [{ id: "m1" }], nextPageToken: "p2" }
        : { messages: [{ id: "w1" }] };
    }
    const message = url.match(/\/messages\/(\w+)\?format=/)?.[1];
    if (method === "GET" && message) {
      return gmailMessage(message, account, message === "w1" ? 22 : 21);
    }
    const thread = url.match(/\/threads\/([\w-]+)\?format=/)?.[1];
    if (method === "GET" && thread) {
      return { id: thread, messages: [gmailMessage("m1", account, 21), gmailMessage("m2", account, 23)] }; // prettier-ignore
    }
    if (url === `${API}/labels`) {
      return {
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_1", name: "Projects", type: "user" },
        ],
      };
    }
    if (url === `${API}/settings/sendAs`) {
      return { sendAs: [{ sendAsEmail: account, isPrimary: true, isDefault: true }] };
    }
    if (url.includes("/upload/gmail/v1/users/me/drafts")) {
      return { id: "d1", message: { id: draftMessage, threadId: "t-m1" } };
    }
    if (url.startsWith(`${API}/drafts/d1?format=minimal`)) {
      return { id: "d1", message: { id: draftMessage } };
    }
    if (url.startsWith(`${API}/drafts/d1?format=`)) {
      return {
        id: "d1",
        message: {
          id: draftMessage,
          threadId: "t-m1",
          labelIds: ["DRAFT"],
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: account },
              { name: "To", value: "amy@example.com" },
              { name: "Subject", value: "Re: Lunch" },
            ],
            body: { data: b64("Thursday works.") },
          },
        },
      };
    }
    if (url === `${API}/drafts/send`) return { id: "s1", threadId: "t-m1", labelIds: ["SENT"] };
    if (url.endsWith("/modify")) return { id: "m1", threadId: "t-m1", labelIds: [] };
    if (url.endsWith("/trash")) return { id: "m1", threadId: "t-m1", labelIds: ["TRASH"] };
    throw new Error(`Unexpected ${method} ${url}`);
  };
  const accounts = {
    manageUrl: "https://worker.example/accounts",
    async request(account: string, url: string, init: any = {}) {
      const method =
        init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST");
      const raw = init.raw ? Buffer.from(init.raw).toString("utf8") : undefined;
      calls.push({ account, method, url, body: init.body, raw });
      return route(account, method, url);
    },
    async batch(account: string, _endpoint: string, requests: any[]) {
      return requests.map((request) => {
        const url = `https://gmail.googleapis.com${request.path}`;
        calls.push({ account, method: request.method, url });
        return { status: 200, body: route(account, request.method, url) };
      });
    },
    async resolve(account: string) {
      const found = emails.find((email) => email === account || email.split("@")[0] === account);
      if (!found) throw new Error(`"${account}" is not a linked Google account.`);
      return found;
    },
    async resolveAll(account?: string) {
      return account ? [await accounts.resolve(account)] : emails;
    },
    async summaries() {
      return emails.map((email) => ({ email, services: ["gmail"], addedAt: "" }));
    },
  };
  return {
    google: accounts as unknown as GoogleAccounts,
    calls,
    replaceDraft: (id: string) => (draftMessage = id),
  };
}

/** An iCloud context with one inbox message and a draft manager that records its calls. */
function fakeIcloud() {
  const recorded: Array<[string, unknown]> = [];
  const draft = (input: any) => ({
    draftId: "apple-draft:new",
    revision: "r1",
    nativeId: "n",
    from: input.from,
    to: input.to ?? [],
    cc: [],
    bcc: [],
    subject: input.subject ?? "",
    body: input.body ?? "",
    visible: true,
    sourceKind: "imap" as const,
    hasAttachments: false,
  });
  const drafts = {
    async createDraft(input: any) {
      recorded.push(["createDraft", input]);
      return { success: true, draft: draft(input) };
    },
    async sendDraft(id: string, revision: string) {
      recorded.push(["sendDraft", [id, revision]]);
      return { success: true, sentMessageId: "imap:sent" };
    },
  };
  const searches: Array<[string, unknown]> = [];
  let open = "";
  const client = {
    async list() {
      return [
        { path: "INBOX", name: "INBOX" },
        { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
      ];
    },
    async getMailboxLock(path: string) {
      open = path;
      return { release() {} };
    },
    async search(criteria: unknown) {
      searches.push([open, criteria]);
      return [7];
    },
    async *fetch() {
      yield {
        uid: 7,
        envelope: {
          date: new Date(Date.UTC(2026, 9, 20, 9)),
          subject: "Invoice",
          from: [{ name: "Bob", address: "bob@example.com" }],
          to: [{ address: "peter@poieti.com" }],
        },
        flags: new Set(["\\Seen"]),
      };
    },
  };
  const ctx = {
    account: "iCloud",
    settings: {
      version: 1 as const,
      primaryAddress: "peter@poieti.com",
      addresses: ["peter@poieti.com"],
      signatures: { "peter@poieti.com": "Peter", [ME]: "Me via Gmail" },
      excluded: [],
    },
    async refresh() {
      return ctx.settings;
    },
    async saveSettings(next: any) {
      ctx.settings = next;
    },
    drafts,
    imapDeps: {},
    withImap: (fn: (client: any) => Promise<unknown>) => fn(client),
    checkId() {},
    serialize: <T>(fn: () => Promise<T>) => fn(),
  };
  return { icloud: ctx as unknown as ConnectorContext, recorded, searches };
}

describe("mail tools", () => {
  let gmail: ReturnType<typeof fakeGoogle>;
  let icloud: ReturnType<typeof fakeIcloud>;
  let call: (name: string, args?: Record<string, unknown>) => Promise<any>;

  beforeEach(async () => {
    gmail = fakeGoogle();
    icloud = fakeIcloud();
    const server = new McpServer({ name: "test", version: "1" });
    registerMailTools(server, { icloud: icloud.icloud, google: gmail.google });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    };
  });

  it("searches every account at once, newest first, with IDs that name their account", async () => {
    const found = await call("mail_search", { unread: true });
    expect(found.messages.map((m: any) => [m.account, m.subject])).toEqual([
      [WORK, "Lunch"],
      [ME, "Lunch"],
      ["iCloud", "Invoice"],
    ]);
    expect(found.messages[1]).toMatchObject({
      id: `gmail:m:${ME}:m1`,
      threadId: `gmail:t:${ME}:t-m1`,
      labels: ["INBOX", "Projects"],
      unread: true,
    });
    expect(found.messages[2].id).toBe(encodeImapId("iCloud", "INBOX", 7));
    const query = gmail.calls.find((c) => c.url.startsWith(`${API}/messages?`))!;
    expect(new URL(query.url).searchParams.get("q")).toBe("in:inbox is:unread -in:draft");

    // Only the account with more results is searched again.
    gmail.calls.length = 0;
    const more = await call("mail_search", { unread: true, cursor: found.nextCursor });
    expect(more.messages.map((m: any) => m.account)).toEqual([ME]);
    const next = gmail.calls.find((c) => c.url.startsWith(`${API}/messages?`))!;
    expect(new URL(next.url).searchParams.get("pageToken")).toBe("p2");
  });

  it("searches one person's mail both ways, in every folder unless given one", async () => {
    await call("mail_search", { with: "Amy Chen" });
    const query = gmail.calls.find((c) => c.url.startsWith(`${API}/messages?`))!;
    expect(new URL(query.url).searchParams.get("q")).toBe(
      '{from:"Amy Chen" to:"Amy Chen" cc:"Amy Chen"} -in:draft'
    );
    const both = [{ from: "Amy Chen" }, { to: "Amy Chen" }, { cc: "Amy Chen" }];
    expect(icloud.searches).toEqual([
      ["INBOX", { or: both }],
      ["Sent Messages", { or: both }],
    ]);

    icloud.searches.length = 0;
    await call("mail_search", { with: "Amy Chen", folder: "inbox", accounts: ["iCloud"] });
    expect(icloud.searches.map(([path]) => path)).toEqual(["INBOX"]);
  });

  it("reads the whole conversation a Gmail message is in", async () => {
    const thread = await call("mail_read", { id: `gmail:m:${ME}:m1`, thread: true });
    expect(thread.threadId).toBe(`gmail:t:${ME}:t-m1`);
    expect(thread.messages.map((m: any) => [m.id, m.body])).toEqual([
      [`gmail:m:${ME}:m1`, "Can we meet Thursday?"],
      [`gmail:m:${ME}:m2`, "Can we meet Thursday?"],
    ]);
    expect(gmail.calls.map((c) => c.url.replace(/\?.*/, ""))).toContain(`${API}/threads/t-m1`);
  });

  it("reads a Gmail message with attachment IDs for mail_get_attachment", async () => {
    const message = await call("mail_read", { id: `gmail:m:${ME}:m1` });
    expect(message).toMatchObject({
      account: ME,
      from: "Amy <amy@example.com>",
      body: "Can we meet Thursday?",
      attachments: [{ id: `gmail:a:${ME}:m1:att1`, name: "menu.pdf" }],
    });
  });

  it("replies from the account the original is in, signed, and sends with the revision", async () => {
    const draft = await call("mail_create_draft", {
      replyTo: `gmail:m:${ME}:m1`,
      body: "Thursday works.",
    });
    expect(draft).toMatchObject({ draftId: `gmail:d:${ME}:d1`, revision: "dm1", account: ME });
    const upload = gmail.calls.find((c) => c.url.includes("/upload/gmail/v1/users/me/drafts"))!;
    expect(upload.account).toBe(ME);
    expect(upload.raw).toMatch(/Thursday works\.\r\n\r\nMe via Gmail/);
    expect(upload.raw).toMatch(/In-Reply-To: <m1@mail\.example\.com>/);

    gmail.replaceDraft("dm2");
    await expect(
      call("mail_send", { draftId: draft.draftId, revision: draft.revision })
    ).rejects.toThrow(/current revision is dm2/);
    const sent = await call("mail_send", { draftId: draft.draftId, revision: "dm2" });
    expect(sent).toMatchObject({ sent: true, account: ME, id: `gmail:m:${ME}:s1` });
    expect(gmail.calls.find((c) => c.url === `${API}/drafts/send`)!.body).toEqual({ id: "d1" });
  });

  it("lets the from address pick the account of a new draft", async () => {
    const icloudDraft = await call("mail_create_draft", { to: ["amy@example.com"], body: "Hi" });
    expect(icloudDraft).toMatchObject({ draftId: "apple-draft:new", account: "iCloud" });
    expect(icloud.recorded[0]).toEqual([
      "createDraft",
      expect.objectContaining({ from: "peter@poieti.com", body: "Hi\n\nPeter" }),
    ]);

    const workDraft = await call("mail_create_draft", {
      from: WORK,
      to: ["amy@example.com"],
      subject: "Hello",
    });
    expect(workDraft.account).toBe(WORK);
    await expect(
      call("mail_create_draft", { from: "stranger@example.com", to: ["amy@example.com"] })
    ).rejects.toThrow(/not a sending address of any account/);

    await call("mail_send", { draftId: "apple-draft:new", revision: "r1" });
    expect(icloud.recorded.at(-1)).toEqual(["sendDraft", ["apple-draft:new", "r1"]]);
  });

  it("labels, marks and moves messages in their own accounts", async () => {
    const result = await call("mail_update", {
      ids: [`gmail:m:${ME}:m1`, encodeImapId("iCloud", "INBOX", 7)],
      read: true,
      moveTo: "Projects",
      addLabels: ["projects"],
    });
    expect(result.results[0]).toEqual({ id: `gmail:m:${ME}:m1`, updated: true });
    expect(result.results[1].error).toMatch(/folders, not labels/);
    const modify = gmail.calls.find((c) => c.url.endsWith("/messages/m1/modify"))!;
    expect(modify.body).toEqual({
      addLabelIds: ["Label_1"],
      removeLabelIds: ["UNREAD", "INBOX"],
    });

    await call("mail_update", { ids: [`gmail:t:${ME}:t-m1`], moveTo: "trash" });
    expect(gmail.calls.at(-1)!.url).toBe(`${API}/threads/t-m1/trash`);
  });
});
