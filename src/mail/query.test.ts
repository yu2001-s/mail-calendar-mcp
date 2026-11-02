import { describe, expect, it } from "vitest";
import { gmailId, parseGmailId, attachmentId, draftId, messageId, readableId } from "@/mail/ids.js";
import { gmailQuery, imapCriteria, imapFolderPaths, specialFolder } from "@/mail/query.js";

const boxes = [
  { path: "INBOX", name: "INBOX" },
  { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
  { path: "Deleted Messages", name: "Deleted Messages", specialUse: "\\Trash" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
  { path: "Clients/Acme", name: "Acme" },
  { path: "Clients", name: "Clients", flags: new Set(["\\Noselect"]) },
];

describe("mail IDs", () => {
  it("round-trips Gmail IDs with the account they belong to", () => {
    const id = gmailId("attachment", "me+work@gmail.com", "18c2:ANGjdJ_x-1");
    expect(id).toBe("gmail:a:me+work@gmail.com:18c2:ANGjdJ_x-1");
    expect(parseGmailId(id)).toEqual({
      kind: "attachment",
      account: "me+work@gmail.com",
      id: "18c2:ANGjdJ_x-1",
    });
    expect(parseGmailId("imap:eyJhIjoiaUNsb3VkIn0")).toBeNull();
  });

  it("accepts each account's IDs in full and nothing else", () => {
    const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: string) =>
      schema.safeParse(value).success;
    expect(ok(messageId(), "imap:eyJhIjoiaUNsb3VkIn0")).toBe(true);
    expect(ok(messageId(), "gmail:t:me@gmail.com:18c2a")).toBe(true);
    expect(ok(messageId(), "gmail:d:me@gmail.com:r-1")).toBe(false);
    expect(ok(messageId(), "other:imap:abc")).toBe(false);
    expect(ok(readableId(), "apple-draft:ea1baad1-3355")).toBe(true);
    expect(ok(readableId(), "gmail:d:me@gmail.com:r-123")).toBe(true);
    expect(ok(draftId(), "gmail:m:me@gmail.com:18c2a")).toBe(false);
    expect(ok(attachmentId(), "imap:eyJhIjoiaUNsb3VkIn0#1.2")).toBe(true);
    expect(ok(attachmentId(), "gmail:a:me@gmail.com:18c2a:ANGjdJ_x")).toBe(true);
    expect(ok(attachmentId(), "imap:eyJhIjoiaUNsb3VkIn0")).toBe(false);
  });
});

describe("gmailQuery", () => {
  it("searches the inbox by default and maps every field", () => {
    expect(gmailQuery({})).toBe("in:inbox");
    expect(
      gmailQuery({
        folder: "all",
        from: "Amy Chen",
        to: "me@example.com",
        subject: "Q4 plan",
        since: "2026-10-01",
        before: "2026-10-08",
        unread: true,
        flagged: false,
        hasAttachment: true,
        text: "budget OR forecast",
      })
    ).toBe(
      'from:"Amy Chen" to:me@example.com subject:"Q4 plan" after:2026/10/01 before:2026/10/08 is:unread -is:starred has:attachment budget OR forecast'
    );
  });

  it("finds mail from, to or copied to one person", () => {
    expect(gmailQuery({ folder: "all", with: "Amy Chen" })).toBe(
      '{from:"Amy Chen" to:"Amy Chen" cc:"Amy Chen"}'
    );
  });

  it("maps special folders and searches other folders as labels", () => {
    expect(gmailQuery({ folder: "Spam" })).toBe("in:spam");
    expect(gmailQuery({ folder: "trash" })).toBe("in:trash");
    expect(gmailQuery({ folder: "Projects/Q4 Launch" })).toBe("label:Projects-Q4-Launch");
  });
});

describe("imapCriteria and imapFolderPaths", () => {
  it("builds IMAP SEARCH criteria, or all", () => {
    expect(imapCriteria({})).toEqual({ all: true });
    expect(imapCriteria({ text: "hi", unread: true, flagged: true, hasAttachment: true })).toEqual({
      text: "hi",
      seen: false,
      flagged: true,
      header: { "content-type": "multipart/mixed" },
    });
    expect(imapCriteria({ with: "amy@example.com", since: "2026-10-01" })).toEqual({
      or: [{ from: "amy@example.com" }, { to: "amy@example.com" }, { cc: "amy@example.com" }],
      since: "2026-10-01",
    });
  });

  it("finds special folders by their special use, and others by path or name", () => {
    expect(imapFolderPaths(boxes, undefined)).toEqual(["INBOX"]);
    expect(imapFolderPaths(boxes, "sent")).toEqual(["Sent Messages"]);
    expect(imapFolderPaths(boxes, "spam")).toEqual(["Junk"]);
    expect(imapFolderPaths(boxes, "trash")).toEqual(["Deleted Messages"]);
    expect(imapFolderPaths(boxes, "acme")).toEqual(["Clients/Acme"]);
    expect(imapFolderPaths(boxes, "all")).toEqual([
      "INBOX",
      "Sent Messages",
      "Archive",
      "Clients/Acme",
    ]);
    expect(() => imapFolderPaths(boxes, "Nowhere")).toThrow(/No folder "Nowhere"/);
    expect(specialFolder("Deleted Messages")).toBe("trash");
  });
});
