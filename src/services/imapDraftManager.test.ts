import { describe, expect, it, vi } from "vitest";
import {
  ImapDraftManager,
  SENDING_KEYWORD,
  type ImapDraftManagerOptions,
} from "@/services/imapDraftManager.js";
import type { ImapClientLike, ImapConfig } from "@/services/imapClient.js";
import type { SendingIdentity } from "@/types.js";
import { encodeImapId } from "@/services/imapClient.js";
import { parseDraftMime } from "@/services/mimeDraft.js";

function identity(): SendingIdentity {
  return {
    identityId: "mail-identity:test",
    accountId: "account-1",
    accountName: "iCloud",
    email: "sender@example.com",
    fullName: "Sender",
    sender: "Sender <sender@example.com>",
    enabled: true,
    isDefault: true,
  };
}

function fakeImap() {
  const boxes = new Map<string, Map<number, Buffer>>([
    ["INBOX", new Map()],
    ["Drafts", new Map()],
    ["Sent", new Map()],
  ]);
  const flags = new Map<number, Set<string>>();
  let selected = "Drafts";
  let nextUid = 1;
  let refuseDelete = false;
  const client = {
    connect: async () => undefined,
    getMailboxLock: async (path: string) => {
      selected = path;
      return { release: () => undefined };
    },
    search: async (query: Record<string, unknown>) => {
      const header = query.header as Record<string, string> | undefined;
      const entries = [...(boxes.get(selected)?.entries() ?? [])];
      if (!header) return entries.map(([uid]) => uid);
      const [name, value] = Object.entries(header)[0] ?? [];
      if (!name) return [];
      const pattern = new RegExp(`^${name}:.*${value}`, "im");
      return entries.filter(([, raw]) => pattern.test(raw.toString())).map(([uid]) => uid);
    },
    fetch: async function* (range: string, query: { headers?: string[] }) {
      for (const uid of range.split(",").map(Number)) {
        const raw = boxes.get(selected)?.get(uid);
        if (!raw) continue;
        const name = query.headers?.[0] ?? "";
        const line = raw
          .toString()
          .split(/\r?\n/)
          .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
        yield {
          uid,
          headers: Buffer.from(line ? `${line}\r\n\r\n` : "\r\n"),
          flags: flags.get(uid),
        };
      }
    },
    fetchOne: async (range: string) => {
      const raw = boxes.get(selected)?.get(Number(range));
      return raw ? { uid: Number(range), source: raw, flags: flags.get(Number(range)) } : false;
    },
    list: async () => [
      { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "Sent", name: "Sent", specialUse: "\\Sent" },
    ],
    status: async (path: string) => ({ path }),
    download: async () => ({
      content: (async function* () {
        yield new Uint8Array();
      })(),
    }),
    mailboxCreate: async (path: string) => ({ path, created: true }),
    mailboxRename: async (path: string, newPath: string) => ({ path, newPath }),
    mailboxDelete: async (path: string) => ({ path }),
    append: async (path: string, content: string | Buffer, appendFlags: string[] = []) => {
      const uid = nextUid++;
      boxes.get(path)?.set(uid, Buffer.isBuffer(content) ? content : Buffer.from(content));
      flags.set(uid, new Set(appendFlags));
      return { destination: path, uid };
    },
    messageFlagsAdd: async (uids: number[], added: string[]) => {
      for (const uid of uids) for (const flag of added) flags.get(uid)?.add(flag);
      return true;
    },
    messageFlagsRemove: async (uids: number[], removed: string[]) => {
      for (const uid of uids) for (const flag of removed) flags.get(uid)?.delete(flag);
      return true;
    },
    messageMove: async () => true,
    messageDelete: async (uids: number[]) => {
      if (refuseDelete) return false;
      for (const uid of uids) boxes.get(selected)?.delete(uid);
      return true;
    },
    noop: async () => undefined,
    logout: async () => undefined,
    close: () => undefined,
  } as unknown as ImapClientLike;
  return {
    client,
    boxes,
    flags,
    refuseDeletes: (value: boolean) => {
      refuseDelete = value;
    },
  };
}

function managerOptions(
  client: ImapClientLike,
  overrides: Partial<ImapDraftManagerOptions> = {}
): ImapDraftManagerOptions {
  const config: ImapConfig = {
    host: "imap.example.com",
    port: 993,
    secure: true,
    user: "sender@example.com",
    pass: "test-only",
    accountLabel: "iCloud",
  };
  const sender = identity();
  return {
    resolveIdentity: (selector) =>
      !selector ||
      selector === sender.identityId ||
      selector === sender.email ||
      selector === sender.sender
        ? sender
        : null,
    imapAccount: () => "iCloud",
    imapDeps: () => ({ config, connect: async () => client }),
    smtpConfig: () => ({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: sender.email,
      pass: "test-only",
      from: sender.email,
    }),
    sleep: async () => undefined,
    ...overrides,
  };
}

describe("IMAP-backed drafts", () => {
  const originalId = encodeImapId("iCloud", "INBOX", 100);
  function seedOriginal(fake: ReturnType<typeof fakeImap>, headers: string[] = []) {
    fake.boxes
      .get("INBOX")!
      .set(
        100,
        Buffer.from(
          [
            ...headers,
            'From: "Su, Doctor" <president@example.com>',
            "To: sender@example.com, hello@example.com, colleague@example.com",
            "Cc: colleague@example.com, nurse@example.com",
            "Bcc: private@example.com",
            `Subject: =?UTF-8?B?${Buffer.from("Re: 醫療減負合作交流").toString("base64")}?=`,
            "Message-ID: <parent@example.com>",
            "References: <Root@example.com>\r\n <root@example.com>",
            "In-Reply-To: <previous@example.com>",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Original message text",
          ].join("\r\n")
        )
      );
  }

  it("previews without mutations, honors Reply-To and preserves the exact reply body", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["Reply-To: director@example.com"]);
    const smtpSend = vi.fn();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend,
        selfAddresses: ["hello@example.com"],
      })
    );
    const preview = await manager.previewReply({
      originalMessageId: originalId,
      body: "謝謝您協助轉介！",
    });
    expect(preview).toMatchObject({
      success: true,
      reply: {
        from: "sender@example.com",
        to: ["director@example.com"],
        subject: "Re: 醫療減負合作交流",
        body: "謝謝您協助轉介！",
        inReplyTo: "<parent@example.com>",
        references: [
          "<Root@example.com>",
          "<root@example.com>",
          "<previous@example.com>",
          "<parent@example.com>",
        ],
      },
    });
    expect(preview.reply?.cc).toBeUndefined();
    expect(preview.reply?.bcc).toBeUndefined();
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it("reply-all excludes configured aliases and Bcc; quoting is opt-in", async () => {
    const fake = fakeImap();
    seedOriginal(fake);
    const manager = new ImapDraftManager(
      managerOptions(fake.client, { selfAddresses: ["HELLO@example.com"] })
    );
    const result = await manager.createReplyDraft({
      originalMessageId: originalId,
      body: "Thanks",
      replyAll: true,
      quoteOriginal: true,
    });
    expect(result.success).toBe(true);
    expect(result.draft).toMatchObject({
      to: ["president@example.com"],
      cc: ["colleague@example.com", "nurse@example.com"],
      bcc: [],
    });
    expect(result.draft?.body).toContain("> Original message text");
    expect(result.draft?.hasAttachments).toBe(false);
  });

  it("keeps reply threading through edits, rejects stale send revisions, and submits once", async () => {
    const fake = fakeImap();
    seedOriginal(fake);
    const smtpSend = vi.fn(async () => ({ success: true, messageId: "<sent@example.com>" }));
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const created = await manager.createReplyDraft({
      originalMessageId: originalId,
      body: "First draft",
    });
    const draftId = created.draft!.draftId;
    const edited = await manager.updateDraft(draftId, {
      expectedRevision: created.draft!.revision,
      body: "謝謝您協助轉介！",
    });
    expect(edited.draft).toMatchObject({
      inReplyTo: "<parent@example.com>",
      references: created.draft!.references,
    });
    expect(await manager.sendDraft(draftId, created.draft!.revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/revision conflict/),
    });
    expect(smtpSend).not.toHaveBeenCalled();
    const read = await manager.getDraft(draftId);
    const sent = await manager.sendDraft(draftId, read.draft!.revision);
    expect(sent.success).toBe(true);
    const raw = (smtpSend.mock.calls[0] as unknown as [Buffer])[0];
    expect(parseDraftMime(raw)).toMatchObject({
      inReplyTo: "<parent@example.com>",
      references: created.draft!.references,
      body: "謝謝您協助轉介！",
    });
    expect(fake.boxes.get("Sent")?.size).toBe(1);
    await manager.sendDraft(draftId, read.draft!.revision);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("does not send a follow-up to our own address when the original was sent by us", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["From: sender@example.com", "Reply-To: sender@example.com"]);
    const manager = new ImapDraftManager(
      managerOptions(fake.client, { selfAddresses: ["hello@example.com"] })
    );
    const preview = await manager.previewReply({
      originalMessageId: originalId,
      body: "Following up",
    });
    expect(preview.reply?.to).toEqual(["colleague@example.com"]);
  });

  it("rejects missing source IDs, foreign accounts and malformed original Message-ID before creating a draft", async () => {
    const fake = fakeImap();
    seedOriginal(fake, ["Message-ID: invalid"]);
    const manager = new ImapDraftManager(managerOptions(fake.client));
    for (const id of [
      originalId,
      encodeImapId("other-account", "INBOX", 100),
      encodeImapId("iCloud", "INBOX", 999),
    ]) {
      expect(
        await manager.createReplyDraft({ originalMessageId: id, body: "Thanks" })
      ).toMatchObject({ success: false });
    }
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
  });

  it("creates a server Drafts resource and round-trips clean MIME", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(managerOptions(fake.client));
    const created = await manager.createDraft({
      from: "sender@example.com",
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "同步草稿",
      body: "乾淨內容",
      htmlBody: "<p>乾淨內容</p>",
      attachments: [
        {
          filename: "report.txt",
          contentBase64: Buffer.from("report").toString("base64"),
        },
      ],
    });

    expect(created.success).toBe(true);
    expect(created.draft).toMatchObject({
      backend: "imap",
      subject: "同步草稿",
      bcc: ["hidden@example.com"],
      hasAttachments: true,
    });
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.attachments?.[0]).toMatchObject({
      name: "report.txt",
      size: 6,
    });
  });

  it("replaces atomically, preserves stable id, edits attachments, and rejects stale revisions", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(managerOptions(fake.client));
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Before",
      body: "Before",
      attachments: [
        { filename: "old.txt", contentBase64: Buffer.from("old").toString("base64") },
        { filename: "keep.txt", contentBase64: Buffer.from("keep").toString("base64") },
      ],
    });
    const draftId = created.draft?.draftId as string;
    const oldRevision = created.draft?.revision as string;

    const updated = await manager.updateDraft(draftId, {
      expectedRevision: oldRevision,
      subject: "After",
      body: "After",
      attachmentNamesToRemove: ["old.txt"],
      attachmentsToAdd: [
        { filename: "new.txt", contentBase64: Buffer.from("new").toString("base64") },
      ],
    });

    expect(updated.success).toBe(true);
    expect(updated.draft?.draftId).toBe(draftId);
    expect(updated.draft?.revision).not.toBe(oldRevision);
    expect(updated.draft?.attachments?.map((item) => item.name)).toEqual(["keep.txt", "new.txt"]);
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    expect(
      await manager.updateDraft(draftId, {
        expectedRevision: oldRevision,
        body: "stale overwrite",
      })
    ).toMatchObject({ success: false, error: expect.stringMatching(/revision conflict/i) });
  });

  it("sends the reviewed revision once, strips private headers, syncs Sent, and removes Drafts", async () => {
    const fake = fakeImap();
    let submitted = Buffer.alloc(0);
    const smtpSend = vi.fn(async (raw: Buffer) => {
      submitted = raw;
      return { success: true, messageId: "<smtp-result@example.com>" };
    });
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const created = await manager.createDraft({
      to: ["to@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Send",
      body: "Exact body",
      attachments: [
        { filename: "a.txt", contentBase64: Buffer.from("attachment").toString("base64") },
      ],
    });
    const draftId = created.draft?.draftId as string;

    const sent = await manager.sendDraft(draftId, created.draft?.revision);

    expect(sent.success).toBe(true);
    expect(sent.smtpMessageId).toBe("<smtp-result@example.com>");
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(submitted.toString()).toContain("Exact body");
    expect(submitted.toString()).not.toMatch(/^Bcc:/im);
    expect(submitted.toString()).not.toMatch(/^X-Apple-Mail-Plugin-Draft-ID:/im);
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
    expect(fake.boxes.get("Sent")?.size).toBe(1);

    const repeated = await manager.sendDraft(draftId, created.draft?.revision);
    expect(repeated.success).toBe(true);
    expect(repeated.warning).toMatch(/already sent/i);
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft editable after a definite SMTP rejection", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend: async () => ({ success: false, error: "550 rejected" }),
      })
    );
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Keep on failure",
      body: "Body",
    });

    const sent = await manager.sendDraft(created.draft?.draftId as string, created.draft?.revision);

    expect(sent).toMatchObject({ success: false, error: "550 rejected" });
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.deliveryState).toBe("draft");
  });

  it("locks an uncertain SMTP outcome for manual Sent review", async () => {
    const fake = fakeImap();
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend: async () => ({
          success: false,
          error: "socket closed",
          uncertain: true,
        }),
      })
    );
    const created = await manager.createDraft({
      to: ["to@example.com"],
      subject: "Uncertain",
      body: "Body",
    });

    const sent = await manager.sendDraft(created.draft?.draftId as string, created.draft?.revision);

    expect(sent.error).toMatch(/verify Sent/i);
    const reread = await manager.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.deliveryState).toBe("needs_review");
    expect(await manager.sendDraft(created.draft?.draftId as string)).toMatchObject({
      success: false,
      error: expect.stringMatching(/avoid a duplicate/i),
    });
    expect(
      await manager.resolveUncertainSend(created.draft?.draftId as string, "not_sent")
    ).toMatchObject({
      success: true,
      draft: expect.objectContaining({ deliveryState: "draft" }),
    });
  });
});

describe("drafts shared across devices", () => {
  // Two managers with separate registries model two devices on one account.
  function devices(overrides: Partial<ImapDraftManagerOptions> = {}) {
    const fake = fakeImap();
    const smtpSend = vi.fn(async () => ({
      success: true,
      messageId: "<smtp-result@example.com>",
    }));
    const options = { smtpSend, ...overrides };
    return {
      fake,
      smtpSend,
      laptop: new ImapDraftManager(managerOptions(fake.client, options)),
      desktop: new ImapDraftManager(managerOptions(fake.client, options)),
    };
  }

  it("lists, edits and sends a draft that another device created", async () => {
    const { fake, smtpSend, laptop, desktop } = devices();
    const created = await laptop.createDraft({
      to: ["to@example.com"],
      subject: "Shared",
      body: "From the laptop",
    });
    const draftId = created.draft?.draftId as string;

    const listed = await desktop.listDrafts();
    expect(listed.drafts?.map((draft) => draft.draftId)).toEqual([draftId]);
    expect(listed.drafts?.[0].revision).toBe(created.draft?.revision);

    const updated = await desktop.updateDraft(draftId, {
      expectedRevision: created.draft?.revision,
      body: "Edited on the desktop",
    });
    expect(updated.success).toBe(true);
    expect((await laptop.getDraft(draftId)).draft?.body).toContain("Edited on the desktop");

    const sent = await laptop.sendDraft(draftId, updated.draft?.revision);
    expect(sent.success).toBe(true);
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
  });

  it("blocks a second device while a send is uncertain, until it is resolved", async () => {
    const { laptop, desktop } = devices({
      smtpSend: vi.fn(async () => ({ success: false, error: "socket closed", uncertain: true })),
    });
    const created = await laptop.createDraft({
      to: ["to@example.com"],
      subject: "Uncertain",
      body: "Body",
    });
    const draftId = created.draft?.draftId as string;
    await laptop.sendDraft(draftId, created.draft?.revision);

    expect((await desktop.getDraft(draftId)).draft?.deliveryState).toBe("needs_review");
    expect(await desktop.sendDraft(draftId, created.draft?.revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/avoid a duplicate/i),
    });
    expect(await desktop.updateDraft(draftId, { body: "x" })).toMatchObject({ success: false });

    expect(await desktop.resolveUncertainSend(draftId, "not_sent")).toMatchObject({
      success: true,
      draft: expect.objectContaining({ deliveryState: "draft" }),
    });
    // The laptop set the marker; seeing it cleared means another device resolved it.
    expect((await laptop.getDraft(draftId)).draft?.deliveryState).toBe("draft");
  });

  it("clears the server marker after a definite rejection", async () => {
    const { fake, laptop, desktop } = devices({
      smtpSend: vi.fn(async () => ({ success: false, error: "550 rejected" })),
    });
    const created = await laptop.createDraft({ to: ["to@example.com"], subject: "S", body: "B" });
    await laptop.sendDraft(created.draft?.draftId as string, created.draft?.revision);

    expect([...fake.flags.values()].some((set) => set.has(SENDING_KEYWORD))).toBe(false);
    const reread = await desktop.getDraft(created.draft?.draftId as string);
    expect(reread.draft?.deliveryState).toBe("draft");
  });

  it("reports a draft another device already sent instead of sending it again", async () => {
    const { smtpSend, laptop, desktop } = devices();
    const created = await laptop.createDraft({ to: ["to@example.com"], subject: "S", body: "B" });
    const draftId = created.draft?.draftId as string;
    await desktop.getDraft(draftId);
    await laptop.sendDraft(draftId, created.draft?.revision);

    expect(await desktop.getDraft(draftId)).toMatchObject({
      success: false,
      error: expect.stringMatching(/already sent/i),
    });
    const repeated = await desktop.sendDraft(draftId, created.draft?.revision);
    expect(repeated).toMatchObject({ success: true, warning: expect.stringMatching(/already/i) });
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("does not resend a leftover Drafts copy whose message is already in Sent", async () => {
    const { fake, smtpSend, laptop, desktop } = devices();
    const created = await laptop.createDraft({ to: ["to@example.com"], subject: "S", body: "B" });
    const draftId = created.draft?.draftId as string;
    fake.refuseDeletes(true);
    await laptop.sendDraft(draftId, created.draft?.revision);
    fake.refuseDeletes(false);
    expect(fake.boxes.get("Drafts")?.size).toBe(1);

    const repeated = await desktop.sendDraft(draftId, created.draft?.revision);
    expect(repeated).toMatchObject({ success: true, warning: expect.stringMatching(/in Sent/i) });
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
  });
});

describe("in-memory draft cache", () => {
  it("recovers everything from the server when each request starts empty", async () => {
    const fake = fakeImap();
    const fresh = () =>
      new ImapDraftManager(
        managerOptions(fake.client, {
          smtpSend: vi.fn(async () => ({ success: false, error: "lost", uncertain: true })),
        })
      );
    const created = await fresh().createDraft({ to: ["to@example.com"], subject: "S", body: "B" });
    const draftId = created.draft?.draftId as string;
    expect((await fresh().getDraft(draftId)).draft?.revision).toBe(created.draft?.revision);

    await fresh().sendDraft(draftId, created.draft?.revision);
    // A later request still sees the unresolved send through the server marker.
    expect((await fresh().getDraft(draftId)).draft?.deliveryState).toBe("needs_review");
    expect(await fresh().sendDraft(draftId, created.draft?.revision)).toMatchObject({
      success: false,
    });
  });
});

describe("drafts saved by other mail clients", () => {
  const draftUid = 500;
  const imapId = encodeImapId("iCloud", "Drafts", draftUid);
  const raw = Buffer.from(
    [
      "From: Sender <sender@example.com>",
      "To: peggy@example.com",
      "Cc: murphy@example.com",
      "Bcc: hidden@example.com",
      "Subject: Re: Contract",
      "Message-ID: <apple-mail-draft@example.com>",
      "In-Reply-To: <parent@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Written in Mail.",
    ].join("\r\n")
  );
  function seedDraft(fake: ReturnType<typeof fakeImap>, source = raw) {
    fake.boxes.get("Drafts")!.set(draftUid, source);
    fake.flags.set(draftUid, new Set(["\\Draft", "\\Seen"]));
  }

  it("reads and sends an existing Drafts message exactly as written", async () => {
    const fake = fakeImap();
    seedDraft(fake);
    let submitted = Buffer.alloc(0);
    let envelope: { from: string; to: string[] } | undefined;
    const smtpSend = vi.fn(async (body: Buffer, env: { from: string; to: string[] }) => {
      submitted = body;
      envelope = env;
      return { success: true, messageId: "<apple-mail-draft@example.com>" };
    });
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));

    const read = await manager.getImapDraft(imapId);
    expect(read.draft).toMatchObject({
      draftId: imapId,
      to: ["peggy@example.com"],
      body: "Written in Mail.",
      deliveryState: "draft",
      visible: true,
    });

    const sent = await manager.sendImapDraft(imapId, read.draft!.revision);

    expect(sent).toMatchObject({ success: true, draft: { deliveryState: "sent", visible: false } });
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect(envelope).toEqual({
      from: "sender@example.com",
      to: ["peggy@example.com", "murphy@example.com", "hidden@example.com"],
    });
    expect(submitted.toString()).toBe(raw.toString().replace("Bcc: hidden@example.com\r\n", ""));
    expect(fake.boxes.get("Drafts")?.size).toBe(0);
    expect(fake.boxes.get("Sent")?.size).toBe(1);

    // The sent draft left Drafts, so a repeat is refused instead of resent.
    expect(await manager.sendImapDraft(imapId, read.draft!.revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/no longer exists/),
    });
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("rejects stale revisions, foreign senders and non-Drafts messages without sending", async () => {
    const fake = fakeImap();
    seedDraft(fake);
    const smtpSend = vi.fn(async () => ({ success: true, messageId: "<x@example.com>" }));
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));

    expect(await manager.sendImapDraft(imapId, "stale")).toMatchObject({
      success: false,
      error: expect.stringMatching(/revision conflict/),
    });
    expect(await manager.sendImapDraft(encodeImapId("iCloud", "INBOX", 100), "any")).toMatchObject({
      success: false,
      error: expect.stringMatching(/not the Drafts mailbox/),
    });

    const foreign = Buffer.from(raw.toString().replace("sender@example.com", "other@example.com"));
    seedDraft(fake, foreign);
    const revision = (await manager.getImapDraft(imapId)).draft!.revision;
    expect(await manager.sendImapDraft(imapId, revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/not found or is disabled/),
    });
    expect(smtpSend).not.toHaveBeenCalled();
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
  });

  it("keeps the Drafts copy and blocks retries after an uncertain send", async () => {
    const fake = fakeImap();
    seedDraft(fake);
    const smtpSend = vi.fn(async () => ({
      success: false,
      error: "socket closed",
      uncertain: true,
    }));
    const fresh = () => new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const revision = (await fresh().getImapDraft(imapId)).draft!.revision;

    expect((await fresh().sendImapDraft(imapId, revision)).error).toMatch(/verify Sent/i);
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    expect(fake.flags.get(draftUid)?.has(SENDING_KEYWORD)).toBe(true);
    // Another instance sees the server marker and does not resend.
    expect(await fresh().sendImapDraft(imapId, revision)).toMatchObject({
      success: false,
      error: expect.stringMatching(/avoid a duplicate/i),
    });
    expect(smtpSend).toHaveBeenCalledTimes(1);
  });

  it("leaves the draft sendable after a definite rejection", async () => {
    const fake = fakeImap();
    seedDraft(fake);
    const manager = new ImapDraftManager(
      managerOptions(fake.client, {
        smtpSend: async () => ({ success: false, error: "550 rejected" }),
      })
    );
    const revision = (await manager.getImapDraft(imapId)).draft!.revision;
    expect(await manager.sendImapDraft(imapId, revision)).toMatchObject({
      success: false,
      error: "550 rejected",
    });
    expect(fake.boxes.get("Drafts")?.size).toBe(1);
    expect(fake.flags.get(draftUid)?.has(SENDING_KEYWORD)).toBe(false);
    expect((await manager.getImapDraft(imapId)).draft?.deliveryState).toBe("draft");
  });

  it("routes the imap: ID of a connector draft through its managed send", async () => {
    const fake = fakeImap();
    const smtpSend = vi.fn(async () => ({ success: true, messageId: "<m@example.com>" }));
    const manager = new ImapDraftManager(managerOptions(fake.client, { smtpSend }));
    const created = await manager.createDraft({ to: ["to@example.com"], subject: "S", body: "B" });

    const sent = await manager.sendImapDraft(created.draft!.nativeId!, created.draft!.revision);

    expect(sent).toMatchObject({ success: true, draft: { draftId: created.draft!.draftId } });
    expect(smtpSend).toHaveBeenCalledTimes(1);
    expect((await manager.listDrafts()).drafts).toEqual([]);
  });
});
