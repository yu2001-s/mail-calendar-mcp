import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoogleAccounts } from "@/google/accounts.js";
import type { ConnectorContext } from "@/icloud/context.js";
import { registerMailTools } from "@/mail/tools.js";
import type { Uploads } from "@/mcp/uploads.js";
import { encodeImapId } from "@/services/imapClient.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const b64 = (text: string) => Buffer.from(text).toString("base64url");
const ME = "me@gmail.com";
const WORK = "work@gmail.com";

function gmailMessage(id: string, account: string, day: number) {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ["INBOX", "UNREAD", "Label_1", "CATEGORY_PERSONAL"],
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
          { id: "CATEGORY_UPDATES", name: "CATEGORY_UPDATES", type: "system" },
        ],
      };
    }
    if (url === `${API}/labels/INBOX`) return { id: "INBOX", messagesTotal: 12, messagesUnread: 3 };
    if (url === `${API}/labels/Label_1`) return { id: "Label_1", messagesTotal: 4 };
    if (url.startsWith(`${API}/drafts?`)) return { drafts: [{ id: "d1" }] };
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
    if (url.includes("/attachments/")) return { data: b64("%PDF-1.7") };
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
  const saved = [
    {
      ...draft({ from: "peter@poieti.com", subject: "Budget", body: "Numbers for Q4" }),
      updatedAt: "2026-11-01T09:00:00Z",
    },
    {
      ...draft({ from: "peter@poieti.com", subject: "Trip", body: "Flights and the budget" }),
      updatedAt: "2026-11-02T09:00:00Z",
    },
    {
      ...draft({ from: "peter@poieti.com", subject: "Party", body: "Bring snacks" }),
      updatedAt: "2026-11-03T09:00:00Z",
    },
  ];
  const drafts = {
    async listDrafts() {
      return { success: true, drafts: saved };
    },
    async createDraft(input: any) {
      recorded.push(["createDraft", input]);
      return { success: true, draft: draft(input) };
    },
    async sendDraft(id: string, revision: string, send?: unknown) {
      recorded.push(["sendDraft", [id, revision]]);
      if (send) sessionSends.push(id);
      if (id === "apple-draft:refused") return { success: false, error: "550 rejected" };
      if (id === "apple-draft:lost") {
        return { success: false, error: "socket closed", uncertain: true };
      }
      const to = id === "apple-draft:bad" ? "nobody@gone.example" : `${id.slice(12)}@example.com`;
      return {
        success: true,
        sentMessageId: "imap:sent",
        messageId: `<${id.slice(12)}@poieti.com>`,
        sentAt: "2026-11-24T03:27:23.000Z",
        draft: { ...draft({ from: "peter@poieti.com", to: [to], subject: `To ${to}` }) },
      };
    },
    openSmtpSession() {
      sessions.opened++;
      return { send: async () => ({ success: true }), close: () => sessions.closed++ };
    },
  };
  const sessionSends: string[] = [];
  const sessions = { opened: 0, closed: 0 };
  // Delivery reports in the inbox, by UID.
  const reports = new Map<number, string>();
  const searches: Array<[string, unknown]> = [];
  const previews: string[] = [];
  let open = "";
  const client = {
    async list(options?: { statusQuery?: object }) {
      const counts = (messages: number, unseen: number) =>
        options?.statusQuery && { status: { messages, unseen } };
      return [
        { path: "INBOX", name: "INBOX", ...counts(10, 2) },
        { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent", ...counts(5, 0) },
      ];
    },
    async getMailboxLock(path: string) {
      open = path;
      return { release() {} };
    },
    async search(criteria: any) {
      searches.push([open, criteria]);
      if (criteria.or?.some((c: any) => c.from === "mailer-daemon")) return [...reports.keys()];
      return [7];
    },
    async *fetch(range: string, query: { bodyParts?: Array<{ key: string }>; source?: object }) {
      if (query.source) {
        for (const uid of range.split(",").map(Number)) {
          yield { uid, internalDate: new Date(), source: Buffer.from(reports.get(uid)!) };
        }
        return;
      }
      if (query.bodyParts) {
        previews.push(open);
        // The first bytes of the text part, cut mid-escape.
        const text = "Hi Peter,\r\nYour invoice for Octo=\r\nber is attached. Caf=C3=A9 =C3";
        yield { uid: 7, bodyParts: new Map([[query.bodyParts[0].key, Buffer.from(text)]]) };
        return;
      }
      yield {
        uid: 7,
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              part: "1",
              type: "text/plain",
              encoding: "quoted-printable",
              parameters: { charset: "utf-8" },
            },
            { part: "2", type: "application/pdf", disposition: "attachment" },
          ],
        },
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
  return {
    icloud: ctx as unknown as ConnectorContext,
    recorded,
    searches,
    previews,
    sessionSends,
    sessions,
    reports,
  };
}

describe("mail tools", () => {
  let gmail: ReturnType<typeof fakeGoogle>;
  let icloud: ReturnType<typeof fakeIcloud>;
  let uploads: Uploads & { share: ReturnType<typeof vi.fn> };
  let call: (name: string, args?: Record<string, unknown>) => Promise<any>;

  /** A client of mail tools that wait `bounceWaitMs` before looking for bounces. */
  async function connect(bounceWaitMs: number) {
    const server = new McpServer({ name: "test", version: "1" });
    registerMailTools(server, {
      icloud: icloud.icloud,
      google: gmail.google,
      uploads,
      bounceWaitMs,
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    return async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    };
  }

  beforeEach(async () => {
    gmail = fakeGoogle();
    icloud = fakeIcloud();
    uploads = {
      create: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      share: vi.fn(async () => ({
        downloadUrl: "https://worker.example/downloads/dl_x",
        expiresAt: "2026-11-04T00:15:00.000Z",
      })),
    };
    call = await connect(0);
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

  it("gives iCloud rows a snippet and Gmail rows their inbox tab", async () => {
    const found = await call("mail_search", { unread: true });
    const icloudRow = found.messages.find((m: any) => m.account === "iCloud");
    expect(icloudRow.snippet).toBe("Hi Peter, Your invoice for October is attached. Café");
    const gmailRow = found.messages.find((m: any) => m.account === ME);
    expect(gmailRow).toMatchObject({ category: "primary", labels: ["INBOX", "Projects"] });
  });

  it("reads previews only for the rows a search returns", async () => {
    // The same message UID in INBOX and Sent: two candidates, one returned.
    const found = await call("mail_search", { with: "bob", accounts: ["iCloud"], limit: 1 });
    expect(found.messages).toHaveLength(1);
    expect(found.messages[0].snippet).toMatch(/^Hi Peter/);
    expect(icloud.previews).toEqual([found.messages[0].folder]);
  });

  it("gives a Gmail attachment's download link its file name", async () => {
    const link = await call("mail_get_attachment", { id: `gmail:a:${ME}:m1:att1`, link: true });
    expect(link).toEqual({
      id: `gmail:a:${ME}:m1:att1`,
      size: 8,
      filename: "menu.pdf",
      mimeType: "application/pdf",
      downloadUrl: "https://worker.example/downloads/dl_x",
      expiresAt: "2026-11-04T00:15:00.000Z",
    });
    const [file] = uploads.share.mock.calls[0];
    expect(file.filename).toBe("menu.pdf");
    expect(file.content.toString()).toBe("%PDF-1.7");

    const inline = await call("mail_get_attachment", { id: `gmail:a:${ME}:m1:att1` });
    expect(inline.contentBase64).toBe(Buffer.from("%PDF-1.7").toString("base64"));
    expect(uploads.share).toHaveBeenCalledTimes(1);
  });

  it("saves a display name for a Gmail address and sends with it", async () => {
    const settings = await call("mail_settings", {
      displayName: "Work Me",
      displayNameFrom: WORK,
    });
    expect(settings.gmailDisplayNames).toEqual({ [WORK]: "Work Me" });
    await call("mail_create_draft", { from: WORK, to: ["amy@example.com"], body: "Hi" });
    const upload = gmail.calls.findLast((c) => c.url.includes("/upload/gmail/v1/users/me/drafts"))!;
    expect(upload.raw).toMatch(/^From: Work Me <work@gmail\.com>\r$/m);
  });

  it("lists folders with how many messages each holds and how many are unread", async () => {
    const { folders } = await call("mail_list_folders");
    expect(folders).toEqual([
      { account: "iCloud", name: "INBOX", special: "inbox", total: 10, unread: 2 },
      { account: "iCloud", name: "Sent Messages", special: "sent", total: 5, unread: 0 },
      { account: ME, name: "INBOX", special: "inbox", total: 12, unread: 3 },
      { account: ME, name: "Projects", total: 4, unread: 0 },
      { account: WORK, name: "INBOX", special: "inbox", total: 12, unread: 3 },
      { account: WORK, name: "Projects", total: 4, unread: 0 },
    ]);
  });

  it("lists drafts newest first, only those with the words asked for", async () => {
    const { drafts } = await call("mail_list_drafts", { text: "BUDGET", accounts: ["iCloud", ME] });
    expect(drafts.map((d: any) => [d.account, d.subject, d.date ?? null])).toEqual([
      ["iCloud", "Trip", "2026-11-02T09:00:00Z"],
      ["iCloud", "Budget", "2026-11-01T09:00:00Z"],
      [ME, "Re: Lunch", null],
    ]);
    expect(drafts[0].snippet).toBe("Flights and the budget");
    const query = gmail.calls.find((c) => c.url.startsWith(`${API}/drafts?`))!;
    expect(new URL(query.url).searchParams.get("q")).toBe("BUDGET");
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

  it("saves several drafts in one call, without echoing their bodies", async () => {
    const result = await call("mail_create_draft", {
      messages: [
        // A strict host sends null for every field it leaves unset.
        { to: ["amy@example.com"], subject: "One", body: "First", cc: null, replyTo: null },
        { from: "stranger@example.com", to: ["bob@example.com"], body: "Nope" },
        { from: WORK, to: ["cat@example.com"], subject: "Two", body: "Second" },
      ],
    });
    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.drafts[0]).toMatchObject({
      draftId: "apple-draft:new",
      revision: "r1",
      account: "iCloud",
      to: ["amy@example.com"],
      subject: "One",
    });
    expect(result.drafts[0].body).toBeUndefined();
    expect(result.drafts[1]).toEqual({
      index: 1,
      error: expect.stringMatching(/not a sending address/),
    });
    expect(result.drafts[2]).toMatchObject({ draftId: `gmail:d:${WORK}:d1`, account: WORK });
    expect(result.drafts[2].body).toBeUndefined();
    // Each signature is shown once, not once per draft.
    expect(result.signatures).toEqual({ "peter@poieti.com": "Peter" });
    expect(icloud.recorded[0]).toEqual([
      "createDraft",
      expect.objectContaining({ body: "First\n\nPeter" }),
    ]);

    await expect(
      call("mail_create_draft", { to: ["amy@example.com"], messages: [{ to: ["b@example.com"] }] })
    ).rejects.toThrow(/not both/);
  });

  it("sends several drafts over one login, each with its own result and bounce", async () => {
    icloud.reports.set(
      9,
      [
        "From: Mail Delivery System <mailer-daemon@icloud.com>",
        "Subject: Undelivered Mail Returned to Sender",
        "Content-Type: multipart/report; report-type=delivery-status; boundary=b",
        "",
        "--b",
        "Content-Type: text/plain",
        "",
        "<nobody@gone.example>: host mx.gone.example said: 550 5.1.1 User unknown",
        "--b",
        "Content-Type: message/delivery-status",
        "",
        "Final-Recipient: rfc822; nobody@gone.example",
        "Action: failed",
        "Diagnostic-Code: smtp; 550 5.1.1 <nobody@gone.example>:",
        " Recipient address rejected: User unknown",
        "--b--",
      ].join("\r\n")
    );
    const result = await call("mail_send", {
      drafts: [
        { draftId: "apple-draft:amy", revision: "r1" },
        { draftId: "apple-draft:refused", revision: "r1" },
        { draftId: "apple-draft:bad", revision: "r1" },
        { draftId: `gmail:d:${ME}:d1`, revision: "dm1" },
      ],
    });
    expect(result.results[0]).toEqual({
      draftId: "apple-draft:amy",
      sent: true,
      account: "iCloud",
      id: "imap:sent",
      messageId: "<amy@poieti.com>",
      sentAt: "2026-11-24T03:27:23.000Z",
      to: ["amy@example.com"],
      subject: "To amy@example.com",
    });
    // A refusal does not stop the drafts after it.
    expect(result.results[1]).toEqual({
      draftId: "apple-draft:refused",
      sent: false,
      error: "550 rejected",
    });
    expect(result.results[2].bounced).toEqual({
      id: encodeImapId("iCloud", "INBOX", 9),
      reason: "550 5.1.1 <nobody@gone.example>: Recipient address rejected: User unknown",
    });
    expect(result.results[3]).toMatchObject({
      sent: true,
      account: ME,
      id: `gmail:m:${ME}:s1`,
      messageId: "<s1@mail.example.com>",
      subject: "Lunch",
    });
    expect(result).toMatchObject({ sent: 3, notSent: 1, bounced: 1 });
    expect(icloud.sessionSends).toEqual([
      "apple-draft:amy",
      "apple-draft:refused",
      "apple-draft:bad",
    ]);
    expect(icloud.sessions).toEqual({ opened: 1, closed: 1 });
  });

  it("stops a batch at an uncertain send, so nothing after it can go twice", async () => {
    const result = await call("mail_send", {
      drafts: [
        { draftId: "apple-draft:amy", revision: "r1" },
        { draftId: "apple-draft:lost", revision: "r1" },
        { draftId: "apple-draft:bob", revision: "r1" },
      ],
    });
    expect(result.results.map((row: any) => [row.sent, row.uncertain ?? false])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(result.results[2].notAttempted).toMatch(/apple-draft:lost is uncertain/);
    expect(icloud.recorded.filter(([name]) => name === "sendDraft")).toHaveLength(2);
    expect(icloud.sessions.closed).toBe(1);

    await expect(
      call("mail_send", {
        drafts: [
          { draftId: "apple-draft:amy", revision: "r1" },
          { draftId: "apple-draft:amy", revision: "r1" },
        ],
      })
    ).rejects.toThrow(/twice/);
    await expect(call("mail_send", { draftId: "apple-draft:amy" })).rejects.toThrow(/revision/);
  });

  it("waits after the last send, so a bounce that comes back after it is found", async () => {
    const late = await connect(80);
    const sentAt = Date.now();
    // The report reaches the inbox a moment after the batch's last send.
    setTimeout(
      () =>
        icloud.reports.set(
          11,
          "From: MAILER-DAEMON\r\n\r\n<nobody@gone.example>: 550 5.1.1 User unknown\r\n"
        ),
      20
    );
    const result = await late("mail_send", {
      drafts: [{ draftId: "apple-draft:bad", revision: "r1" }],
    });
    expect(result.results[0].bounced).toEqual({
      id: encodeImapId("iCloud", "INBOX", 11),
      reason: "<nobody@gone.example>: 550 5.1.1 User unknown",
    });
    expect(Date.parse(result.bouncesCheckedAt)).toBeGreaterThanOrEqual(sentAt + 80);
  });
});
