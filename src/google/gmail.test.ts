import { describe, expect, it } from "vitest";
import type { GoogleAccounts } from "./accounts.js";
import {
  collectParts,
  tidyText,
  composeMime,
  Gmail,
  messageView,
  nameAndAddress,
  uploadBody,
  type GmailMessage,
  type GmailOptions,
} from "./gmail.js";

const ME = "me@gmail.com";
const b64 = (text: string) => Buffer.from(text).toString("base64url");

interface Call {
  method: string;
  url: string;
  body?: any;
  raw?: string;
}

/** A GoogleAccounts stand-in that answers from `route` and records each call. */
function fake(route: (method: string, url: string, body?: any) => any, options?: GmailOptions) {
  const calls: Call[] = [];
  const accounts = {
    manageUrl: "https://worker.example/accounts",
    async request(_email: string, url: string, init: any = {}) {
      const method =
        init.method ?? (init.body === undefined && init.raw === undefined ? "GET" : "POST");
      const raw = init.raw ? Buffer.from(init.raw).toString("utf8") : undefined;
      calls.push({ method, url, body: init.body, raw });
      return route(method, url, init.body);
    },
    async batch(_email: string, _endpoint: string, requests: any[]) {
      return requests.map((request) => {
        const url = `https://gmail.googleapis.com${request.path}`;
        calls.push({ method: request.method, url });
        return { status: 200, body: route(request.method, url) };
      });
    },
  };
  return { gmail: new Gmail(accounts as unknown as GoogleAccounts, options), calls };
}

/** The message/rfc822 part of a multipart upload. */
function uploadedMime(call: Call): { metadata: any; mime: string } {
  const [, metadata] = call.raw!.split(/\r\n\r\n/);
  const start = call.raw!.indexOf("message/rfc822") + "message/rfc822\r\n\r\n".length;
  return { metadata: JSON.parse(metadata.split("\r\n")[0]), mime: call.raw!.slice(start) };
}

const original: GmailMessage = {
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
  snippet: "Can we meet &amp; talk?",
  internalDate: String(Date.UTC(2026, 9, 1, 9, 0)),
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Alice <alice@example.com>" },
      { name: "To", value: "Me <me@gmail.com>, bob@example.com" },
      { name: "Cc", value: "carol@example.com" },
      { name: "Subject", value: "=?UTF-8?B?5pyD6K2w?= plans" },
      { name: "Date", value: "Wed, 1 Oct 2026 09:00:00 +0000" },
      { name: "Message-ID", value: "<orig@example.com>" },
      { name: "References", value: "<root@example.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }],
            body: { data: b64("Can we meet?\nThursday works.") },
          },
          {
            mimeType: "text/html",
            headers: [{ name: "Content-Type", value: "text/html; charset=UTF-8" }],
            body: { data: b64("<html><body><p>Can we meet?</p></body></html>") },
          },
        ],
      },
      {
        partId: "2",
        mimeType: "application/pdf",
        filename: "agenda.pdf",
        headers: [{ name: "Content-Disposition", value: 'attachment; filename="agenda.pdf"' }],
        body: { attachmentId: "att-1", size: 4 },
      },
    ],
  },
};

describe("messageView", () => {
  it("returns the Gmail connector fields for each format", () => {
    const full = messageView(ME, original, "FULL_CONTENT");
    expect(full).toMatchObject({
      id: "m1",
      threadId: "t1",
      viewUrl: "https://mail.google.com/mail/u/me@gmail.com/#all/m1",
      sender: "Alice <alice@example.com>",
      toRecipients: ["Me <me@gmail.com>", "bob@example.com"],
      ccRecipients: ["carol@example.com"],
      subject: "會議 plans",
      snippet: "Can we meet & talk?",
      plaintextBody: "Can we meet?\nThursday works.",
      htmlBody: "<html><body><p>Can we meet?</p></body></html>",
      attachments: [
        {
          attachmentId: "att-1",
          filename: "agenda.pdf",
          mimeType: "application/pdf",
          size: 4,
          inline: false,
        },
      ],
    });
    const plain = messageView(ME, original, "PLAIN_TEXT");
    expect(plain.htmlBody).toBeUndefined();
    expect(plain.plaintextBody).toBe("Can we meet?\nThursday works.");
    const minimal = messageView(ME, original, "MINIMAL");
    expect(minimal.subject).toBe("會議 plans");
    expect(minimal.plaintextBody).toBeUndefined();
    const metadata = messageView(ME, original, "METADATA_ONLY");
    expect(metadata.subject).toBeUndefined();
    expect(metadata.snippet).toBeUndefined();
  });

  it("converts HTML-only bodies for PLAIN_TEXT and bounds long bodies", () => {
    const htmlOnly: GmailMessage = {
      id: "m2",
      threadId: "t2",
      payload: {
        mimeType: "text/html",
        headers: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: { data: b64(`<p>Hello</p><p>${"x".repeat(300)}</p>`) },
      },
    };
    const view = messageView(ME, htmlOnly, "PLAIN_TEXT", 100);
    expect(String(view.plaintextBody).startsWith("Hello\n")).toBe(true);
    expect(String(view.plaintextBody)).toHaveLength(100);
    expect(view.bodyTruncated).toBe(true);
  });

  it("decodes bodies in their declared charset", () => {
    const big5 = Buffer.from([0xa4, 0xa4, 0xa4, 0xe5]).toString("base64url");
    const { text } = collectParts({
      mimeType: "text/plain",
      headers: [{ name: "Content-Type", value: 'text/plain; charset="big5"' }],
      body: { data: big5 },
    });
    expect(text).toEqual(["中文"]);
  });

  it("treats a single-part attachment as an attachment, not a body", () => {
    const { text, attachments } = collectParts({
      mimeType: "application/zip",
      filename: "report.zip",
      body: { attachmentId: "z", size: 10 },
    });
    expect(text).toEqual([]);
    expect(attachments[0]).toMatchObject({ filename: "report.zip", attachmentId: "z" });
  });
});

describe("nameAndAddress", () => {
  it("splits a display name from its address", () => {
    expect(nameAndAddress('"Huang, Shao" <s@example.com>')).toEqual({
      name: "Huang, Shao",
      address: "s@example.com",
    });
    expect(nameAndAddress("Shao Yu <s@example.com>")).toEqual({
      name: "Shao Yu",
      address: "s@example.com",
    });
    expect(nameAndAddress('"A \\"B\\"" <s@example.com>')).toEqual({
      name: 'A "B"',
      address: "s@example.com",
    });
    expect(nameAndAddress("<s@example.com>")).toEqual({ address: "s@example.com" });
    expect(nameAndAddress("s@example.com <s@example.com>")).toEqual({ address: "s@example.com" });
    expect(nameAndAddress(" s@example.com ")).toEqual({ address: "s@example.com" });
  });
});

describe("composeMime and uploadBody", () => {
  it("keeps Bcc for Gmail and builds a multipart/related upload", async () => {
    const raw = await composeMime({
      from: '"Me" <me@gmail.com>',
      to: ["a@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Hi",
      text: "Hello",
      html: "<b>Hello</b>",
      attachments: [{ filename: "a.txt", content: Buffer.from("A"), contentType: "text/plain" }],
    });
    const text = raw.toString("utf8");
    expect(text).toMatch(/^Bcc: hidden@example.com\r$/m);
    expect(text).toContain("multipart/alternative");
    expect(text).toContain("filename=a.txt");
    const body = Buffer.from(uploadBody("b", { threadId: "t" }, raw)).toString("utf8");
    expect(
      body.startsWith(
        '--b\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"threadId":"t"}\r\n--b\r\nContent-Type: message/rfc822\r\n\r\n'
      )
    ).toBe(true);
    expect(body.endsWith("\r\n--b--\r\n")).toBe(true);
  });
});

describe("Gmail", () => {
  const sendAs = {
    sendAs: [
      { sendAsEmail: ME, displayName: "Me Myself", isPrimary: true, isDefault: true },
      { sendAsEmail: "alias@example.com", verificationStatus: "accepted" },
      { sendAsEmail: "pending@example.com", verificationStatus: "pending" },
    ],
  };

  function router(extra: (method: string, url: string, body?: any) => any = () => undefined) {
    return (method: string, url: string, body?: any) => {
      const handled = extra(method, url, body);
      if (handled !== undefined) return handled;
      if (url.includes("/settings/sendAs")) return sendAs;
      if (url.includes("/messages/m1")) return original;
      if (url.includes("/upload/"))
        return {
          id: "new",
          threadId: "t1",
          labelIds: ["SENT"],
          message: { id: "dm", threadId: "t1" },
        };
      throw new Error(`unexpected ${method} ${url}`);
    };
  }

  it("searches threads in one batch, excluding drafts", async () => {
    const { gmail, calls } = fake(
      router((_method, url) => {
        if (url.includes("/threads?"))
          return { threads: [{ id: "t1" }, { id: "t2" }], nextPageToken: "n" };
        if (url.includes("/threads/")) {
          const id = url.includes("/threads/t1") ? "t1" : "t2";
          return {
            id,
            messages: [
              { ...original, threadId: id },
              { id: "d", threadId: id, labelIds: ["DRAFT"] },
            ],
          };
        }
      })
    );
    const result = await gmail.searchThreads(ME, { query: "from:alice", pageSize: 2 });
    const list = new URL(calls[0].url);
    expect(list.searchParams.get("q")).toBe("from:alice -in:draft");
    expect(list.searchParams.get("maxResults")).toBe("2");
    expect(result.nextPageToken).toBe("n");
    expect(result.threads).toHaveLength(2);
    expect((result.threads[0] as any).messages).toHaveLength(1);
    expect((result.threads[0] as any).messages[0].plaintextBody).toBeUndefined();
    const searched = await gmail.searchThreads(ME, { query: "in:draft subject:x" });
    expect(new URL(calls.at(-3)!.url).searchParams.get("q")).toBe("in:draft subject:x");
    expect(searched.account).toBe(ME);
  });

  it("replies to the sender in the thread, from the address the mail was sent to", async () => {
    const { gmail, calls } = fake(router());
    const sent = await gmail.reply(ME, { messageId: "m1", body: "Thursday is good." });
    expect(sent).toMatchObject({ id: "new", threadId: "t1" });
    const upload = calls.find((call) =>
      call.url.includes("/upload/gmail/v1/users/me/messages/send")
    )!;
    expect(upload.url).toContain("uploadType=multipart");
    const { metadata, mime } = uploadedMime(upload);
    expect(metadata).toEqual({ threadId: "t1" });
    expect(mime).toMatch(/^From: Me Myself <me@gmail.com>\r$/m);
    expect(mime).toMatch(/^To: alice@example.com\r$/m);
    expect(mime).not.toMatch(/^Cc:/m);
    expect(mime).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(mime).toMatch(/^In-Reply-To: <orig@example.com>\r$/m);
    expect(mime).toMatch(/^References: <root@example.com> <orig@example.com>\r$/m);
    expect(mime).toContain("Thursday is good.");
    expect(mime).toContain("Alice <alice@example.com> wrote:");
    expect(mime).toContain("> Can we meet?");
  });

  it("replies to all except our own addresses", async () => {
    const { gmail, calls } = fake(router());
    await gmail.reply(ME, { messageId: "m1", body: "Yes", replyAll: true });
    const { mime } = uploadedMime(calls.find((call) => call.url.includes("/upload/"))!);
    expect(mime).toMatch(/^Cc: bob@example.com, carol@example.com\r$/m);
  });

  it("replies to the recipients of our own sent message", async () => {
    const mine: GmailMessage = {
      ...original,
      id: "m9",
      payload: {
        ...original.payload,
        headers: [
          { name: "From", value: "Me <me@gmail.com>" },
          { name: "To", value: "dave@example.com" },
          { name: "Subject", value: "Re: plans" },
          { name: "Message-ID", value: "<mine@gmail.com>" },
        ],
      },
    };
    const { gmail, calls } = fake(
      router((_m, url) => (url.includes("/messages/m9") ? mine : undefined))
    );
    await gmail.reply(ME, { messageId: "m9", body: "Following up" });
    const { mime } = uploadedMime(calls.find((call) => call.url.includes("/upload/"))!);
    expect(mime).toMatch(/^To: dave@example.com\r$/m);
    expect(mime).toMatch(/^Subject: Re: plans\r$/m);
  });

  it("replies to all on our own message from the alias it was sent from", async () => {
    const mine: GmailMessage = {
      ...original,
      id: "m8",
      payload: {
        ...original.payload,
        headers: [
          { name: "From", value: "alias@example.com" },
          { name: "To", value: "dave@example.com, erin@example.com" },
          { name: "Cc", value: "frank@example.com, me@gmail.com" },
          { name: "Subject", value: "Plans" },
          { name: "Message-ID", value: "<mine2@example.com>" },
        ],
      },
    };
    const { gmail, calls } = fake(
      router((_m, url) => (url.includes("/messages/m8") ? mine : undefined))
    );
    await gmail.reply(ME, { messageId: "m8", body: "Update", replyAll: true });
    const { mime } = uploadedMime(calls.find((call) => call.url.includes("/upload/"))!);
    expect(mime).toMatch(/^From: alias@example.com\r$/m);
    expect(mime).toMatch(/^To: dave@example.com, erin@example.com\r$/m);
    expect(mime).toMatch(/^Cc: frank@example.com\r$/m);
  });

  it("names a sender from saved names, then send-as, then the latest sent mail", async () => {
    const sentMail = (_method: string, url: string) => {
      if (url.includes("/messages?") && url.includes("in%3Asent")) {
        return { messages: [{ id: "s1" }, { id: "s2" }] };
      }
      const from = url.includes("/messages/s1?")
        ? "<alias@example.com>"
        : url.includes("/messages/s2?")
          ? '"Alias Person" <alias@example.com>'
          : undefined;
      return from && { payload: { headers: [{ name: "From", value: from }] } };
    };
    const draftFrom = async (gmail: Gmail, from: string, calls: Call[]) => {
      await gmail.createDraft(ME, { from, to: ["x@example.com"], body: "Hi" });
      const { mime } = uploadedMime(calls.findLast((call) => call.url.includes("/upload/"))!);
      // Nodemailer quotes a name only when it needs quoting.
      return /^From: (.*)\r$/m.exec(mime)![1].replace(/"/g, "");
    };

    const plain = fake(router(sentMail));
    expect(await draftFrom(plain.gmail, "alias@example.com", plain.calls)).toBe(
      "Alias Person <alias@example.com>"
    );
    expect(await draftFrom(plain.gmail, ME, plain.calls)).toBe("Me Myself <me@gmail.com>");
    // Cached: the sent mail is looked up once.
    await draftFrom(plain.gmail, "alias@example.com", plain.calls);
    expect(plain.calls.filter((call) => call.url.includes("in%3Asent"))).toHaveLength(1);

    const saved = fake(router(sentMail), {
      displayName: (address) => (address === ME ? "Saved Name" : undefined),
    });
    expect(await draftFrom(saved.gmail, ME, saved.calls)).toBe("Saved Name <me@gmail.com>");
  });

  it("keeps a forwarded message when a draft's body is edited", async () => {
    const forwarded = await composeMime({
      from: "me@gmail.com",
      to: ["a@example.com"],
      subject: "Fwd: Plans",
      text: "Old note\n\n---------- Forwarded message ---------\nFrom: Alice\n\nThe plan.",
      html: "<p>Old note</p><br><div>---------- Forwarded message ---------<br>The plan.</div>",
    });
    const { gmail, calls } = fake(
      router((method, url) => {
        if (method === "GET" && url.includes("/drafts/d1")) {
          return {
            id: "d1",
            message: { id: "dm", threadId: "t7", raw: forwarded.toString("base64url") },
          };
        }
      })
    );
    await gmail.updateDraft(ME, "d1", { body: "New note" });
    const kept = uploadedMime(calls.at(-1)!).mime;
    expect(kept).toContain("New note");
    expect(kept).toContain("The plan.");
    expect(kept).not.toContain("Old note");
    expect(kept.match(/Forwarded message/g)).toHaveLength(2);
    await gmail.updateDraft(ME, "d1", { body: "Only this", keepQuoted: false });
    const replaced = uploadedMime(calls.at(-1)!).mime;
    expect(replaced).toContain("Only this");
    expect(replaced).not.toContain("Forwarded message");
  });

  it("keeps a reply's quoted original, text and HTML, when its body is edited", async () => {
    const reply = await composeMime({
      from: "me@gmail.com",
      to: ["alice@example.com"],
      subject: "Re: Plans",
      text: "Old reply\n\nOn Wed, Alice <alice@example.com> wrote:\n> Can we meet?",
      html: '<p>Old reply</p><div class="gmail_quote">On Wed, Alice wrote:<blockquote>Can we meet?</blockquote></div>',
      inReplyTo: "<orig@example.com>",
    });
    const { gmail, calls } = fake(
      router((method, url) => {
        if (method === "GET" && url.includes("/drafts/d2")) {
          return {
            id: "d2",
            message: { id: "dm", threadId: "t1", raw: reply.toString("base64url") },
          };
        }
      })
    );
    await gmail.updateDraft(ME, "d2", { body: "New reply" });
    const { mime } = uploadedMime(calls.at(-1)!);
    expect(mime).not.toContain("Old reply");
    expect(mime.match(/New reply/g)).toHaveLength(2);
    expect(mime).toContain("gmail_quote");
    expect(mime).toContain("> Can we meet?");
    expect(mime).toMatch(/^In-Reply-To: <orig@example.com>\r$/m);
  });

  it("names an attachment from its part, or the one part of its size", async () => {
    const { gmail } = fake(router());
    // original's agenda.pdf part has attachmentId att-1.
    expect(await gmail.attachmentInfo(ME, "m1", "att-1", 0)).toMatchObject({
      filename: "agenda.pdf",
    });
    const part = collectParts(original.payload).attachments[0];
    expect(await gmail.attachmentInfo(ME, "m1", "renamed-id", part.size)).toMatchObject({
      filename: "agenda.pdf",
    });
    expect(await gmail.attachmentInfo(ME, "m1", "renamed-id", part.size + 1)).toEqual({});

    // A calendar invite: two parts of one size and name, but different types.
    const invite = (mimeType: string, attachmentId: string) => ({
      mimeType,
      filename: "invite.ics",
      body: { attachmentId, size: 1131 },
    });
    const { gmail: inviteGmail } = fake(
      router((_m, url) =>
        url.includes("/messages/m5")
          ? {
              id: "m5",
              payload: {
                mimeType: "multipart/mixed",
                parts: [invite("text/calendar", "a1"), invite("application/ics", "a2")],
              },
            }
          : undefined
      )
    );
    expect(await inviteGmail.attachmentInfo(ME, "m5", "renamed-id", 1131)).toEqual({
      filename: "invite.ics",
    });
    expect(await inviteGmail.attachmentInfo(ME, "m5", "a2", 1131)).toEqual({
      filename: "invite.ics",
      mimeType: "application/ics",
    });
  });

  it("counts each label's messages in one batch", async () => {
    const { gmail, calls } = fake(
      router((_m, url) =>
        url.includes("/labels/INBOX")
          ? { id: "INBOX", messagesTotal: 12, messagesUnread: 3 }
          : url.includes("/labels/Label_1")
            ? { id: "Label_1", messagesTotal: 4 }
            : undefined
      )
    );
    const counts = await gmail.labelCounts(ME, ["INBOX", "Label_1"]);
    expect(Object.fromEntries(counts)).toEqual({
      INBOX: { total: 12, unread: 3 },
      Label_1: { total: 4, unread: 0 },
    });
    expect(calls).toHaveLength(2);
  });

  it("creates a reply draft that quotes the original HTML", async () => {
    const { gmail, calls } = fake(router());
    const draft = await gmail.createDraft(ME, {
      replyToMessageId: "m1",
      htmlBody: "<p>Sounds good</p>",
    });
    expect(draft).toMatchObject({ id: "new", messageId: "dm", threadId: "t1" });
    expect(draft.viewUrl).toBe("https://mail.google.com/mail/u/me@gmail.com/#drafts?compose=dm");
    const upload = calls.find((call) => call.url.includes("/upload/gmail/v1/users/me/drafts"))!;
    const { metadata, mime } = uploadedMime(upload);
    expect(metadata).toEqual({ message: { threadId: "t1" } });
    expect(mime).toMatch(/^To: alice@example.com\r$/m);
    expect(mime).toContain("gmail_quote");
    expect(mime).toContain("Sounds good");
  });

  it("merges a draft update and keeps attachments unless replaced", async () => {
    const existing = await composeMime({
      from: "me@gmail.com",
      to: ["a@example.com"],
      subject: "Old",
      text: "Old body",
      attachments: [{ filename: "keep.txt", content: Buffer.from("K"), contentType: "text/plain" }],
      inReplyTo: "<x@example.com>",
    });
    const { gmail, calls } = fake(
      router((method, url) => {
        if (method === "GET" && url.includes("/drafts/d1")) {
          return {
            id: "d1",
            message: { id: "dm", threadId: "t7", raw: existing.toString("base64url") },
          };
        }
      })
    );
    await gmail.updateDraft(ME, "d1", { subject: "New", to: [] });
    const first = uploadedMime(calls.at(-1)!);
    expect(calls.at(-1)!.method).toBe("PUT");
    expect(first.metadata).toEqual({ id: "d1", message: { threadId: "t7" } });
    expect(first.mime).toMatch(/^Subject: New\r$/m);
    expect(first.mime).toMatch(/^To: a@example.com\r$/m);
    expect(first.mime).toMatch(/^In-Reply-To: <x@example.com>\r$/m);
    expect(first.mime).toContain("Old body");
    expect(first.mime).toContain("keep.txt");
    await gmail.updateDraft(ME, "d1", { htmlBody: "<p>New body</p>", attachments: [] });
    const { mime } = uploadedMime(calls.at(-1)!);
    expect(mime).not.toContain("keep.txt");
    expect(mime).not.toContain("Old body");
    expect(mime).toContain("New body");
  });

  it("sends a draft unchanged, or threads a new message", async () => {
    const { gmail, calls } = fake(
      router((method, url, body) => {
        if (url.endsWith("/drafts/send"))
          return { id: "s1", threadId: "t3", labelIds: ["SENT"], body };
        if (url.includes("/threads/t1?"))
          return {
            messages: [
              { id: "m1", labelIds: [] },
              { id: "dx", labelIds: ["DRAFT"] },
            ],
          };
      })
    );
    expect(
      await gmail.sendMessage(ME, { draftId: "d9", to: ["ignored@example.com"] })
    ).toMatchObject({ id: "s1" });
    expect(calls.at(-1)!.body).toEqual({ id: "d9" });
    await expect(gmail.sendMessage(ME, { subject: "x" })).rejects.toThrow(/recipient/);
    await gmail.sendMessage(ME, { to: ["z@example.com"], body: "Ping", replyThreadId: "t1" });
    const { metadata, mime } = uploadedMime(calls.at(-1)!);
    expect(metadata).toEqual({ threadId: "t1" });
    expect(mime).toMatch(/^In-Reply-To: <orig@example.com>\r$/m);
    expect(mime).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(mime).not.toContain("> Can we meet?");
  });

  it("forwards with the original's attachments", async () => {
    const { gmail, calls } = fake(
      router((_m, url) => (url.includes("/attachments/att-1") ? { data: b64("%PDF") } : undefined))
    );
    await gmail.forward(ME, { messageId: "m1", to: ["eve@example.com"], forwardText: "FYI" });
    const { metadata, mime } = uploadedMime(calls.at(-1)!);
    expect(metadata).toEqual({});
    expect(mime).toMatch(/^Subject: =\?UTF-8\?Q\?Fwd=3A_=E6=9C=83/m);
    expect(mime).toContain("---------- Forwarded message ---------");
    expect(mime).toContain("FYI");
    expect(mime).toContain("agenda.pdf");
    expect(mime).toContain(Buffer.from("%PDF").toString("base64"));
    await expect(gmail.forward(ME, { messageId: "m1" })).rejects.toThrow(/recipient/);
  });

  it("creates missing parent labels and maps presets", async () => {
    const { gmail, calls } = fake(
      router((method, url, body) => {
        if (method === "GET" && url.endsWith("/labels")) return { labels: [{ name: "Projects" }] };
        if (method === "POST" && url.endsWith("/labels")) return { id: `L-${body.name}`, ...body };
      })
    );
    const result = await gmail.createLabel(ME, {
      displayName: "Projects/Alpha/Sprint",
      colorPreset: "LABEL_COLOR_PRESET_RED",
      labelListVisibility: "LABEL_SHOW_IF_UNREAD",
    });
    expect(result.createdParents).toEqual(["Projects/Alpha"]);
    expect(calls.at(-1)!.body).toEqual({
      name: "Projects/Alpha/Sprint",
      color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
      labelListVisibility: "labelShowIfUnread",
      messageListVisibility: "show",
    });
  });

  it("returns only received mail to the inbox when unmarking spam or untrashing", async () => {
    const thread = {
      id: "t1",
      messages: [
        { id: "in1", labelIds: ["CATEGORY_PERSONAL"] },
        { id: "out1", labelIds: ["SENT"] },
        { id: "in2", labelIds: ["INBOX", "UNREAD"] },
      ],
    };
    const { gmail, calls } = fake(
      router((_m, url) => {
        if (url.endsWith("/threads/t1/modify") || url.endsWith("/threads/t1/untrash")) {
          return structuredClone(thread);
        }
        if (url.endsWith("/messages/batchModify")) return {};
        if (url.endsWith("/messages/m5/modify"))
          return { id: "m5", threadId: "t5", labelIds: ["SENT"] };
      })
    );
    const unspammed = await gmail.notSpam(ME, "threads", "t1");
    expect(calls[0].body).toEqual({ removeLabelIds: ["SPAM"] });
    expect(calls[1].body).toEqual({ ids: ["in1"], addLabelIds: ["INBOX"] });
    expect(unspammed.messages).toEqual([
      { id: "in1", labelIds: ["CATEGORY_PERSONAL", "INBOX"] },
      { id: "out1", labelIds: ["SENT"] },
      { id: "in2", labelIds: ["INBOX", "UNREAD"] },
    ]);
    await gmail.trash(ME, "threads", "t1", true);
    expect(calls.at(-1)!.body).toEqual({ ids: ["in1"], addLabelIds: ["INBOX"] });
    const before = calls.length;
    await gmail.notSpam(ME, "messages", "m5");
    expect(calls.length).toBe(before + 1);
  });

  it("tidies padded snippets and bodies", () => {
    const padded = messageView(
      ME,
      { ...original, snippet: "Your recap \u034f\u200c\u200b\u200d\ufeff \u034f\u200c  done" },
      "MINIMAL"
    );
    expect(padded.snippet).toBe("Your recap done");
    expect(tidyText(`a\r\n${"-".repeat(400)}\r\n\r\n\r\n\r\nb  \r\n`)).toBe(
      `a\n${"-".repeat(10)}\n\nb\n`
    );
  });

  it("marks spam by moving labels and trashes threads", async () => {
    const { gmail, calls } = fake(
      router((_m, url) => {
        if (url.endsWith("/modify")) return { id: "m1", threadId: "t1", labelIds: ["SPAM"] };
        if (url.endsWith("/trash"))
          return { id: "t1", messages: [{ id: "m1", labelIds: ["TRASH"] }] };
      })
    );
    await gmail.modify(ME, "messages", "m1", ["SPAM"], ["INBOX"]);
    expect(calls.at(-1)!.body).toEqual({ addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] });
    const trashed = await gmail.trash(ME, "threads", "t1");
    expect(calls.at(-1)!.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/threads/t1/trash"
    );
    expect(trashed).toMatchObject({
      threadId: "t1",
      messages: [{ id: "m1", labelIds: ["TRASH"] }],
    });
  });
});
