import { describe, expect, it } from "vitest";
import { baseSubject, findConversation } from "@/mail/conversation.js";

const ME = "peter@poieti.com";
const HIM = "hamalai@yahoo.com.tw";
const SUBJECT = "台大新創團隊｜AI 醫療減負，想請教賴副院長";

interface FakeMessage {
  path: string;
  uid: number;
  day: number;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  subject: string;
  from: string;
  to: string;
}

const boxes = [
  { path: "INBOX", name: "INBOX" },
  { path: "Sent Messages", name: "Sent Messages", specialUse: "\\Sent" },
  { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
  { path: "Junk", name: "Junk", specialUse: "\\Junk" },
  { path: "Archive", name: "Archive", specialUse: "\\Archive" },
];

/** An IMAP client over a few folders that answers the searches findConversation sends. */
function fakeClient(messages: FakeMessage[]) {
  const searched: string[] = [];
  let open = "";
  const header = (message: FakeMessage, name: string) =>
    ({
      "message-id": message.messageId,
      references: message.references ?? "",
      "in-reply-to": message.inReplyTo ?? "",
    })[name] ?? "";
  const matches = (message: FakeMessage, query: Record<string, any>): boolean =>
    Object.entries(query).every(([term, value]) => {
      switch (term) {
        case "or":
          return value.some((sub: Record<string, any>) => matches(message, sub));
        case "header":
          return Object.entries(value).every(([name, text]) =>
            header(message, name).includes(text as string)
          );
        case "subject":
          return message.subject.includes(value);
        case "from":
        case "to":
          return message[term as "from" | "to"].includes(value);
        case "cc":
          return false;
        default:
          throw new Error(`Unexpected search term ${term}`);
      }
    });
  const client = {
    async list() {
      return boxes;
    },
    async getMailboxLock(path: string) {
      open = path;
      return { release: () => (open = "") };
    },
    async search(query: Record<string, any>) {
      searched.push(open);
      return messages.filter((m) => m.path === open && matches(m, query)).map((m) => m.uid);
    },
    async *fetch(range: string) {
      const uids = range.split(",").map(Number);
      for (const m of messages.filter((m) => m.path === open && uids.includes(m.uid))) {
        yield {
          uid: m.uid,
          envelope: {
            date: new Date(Date.UTC(2026, 9, m.day)),
            subject: m.subject,
            messageId: m.messageId,
            inReplyTo: m.inReplyTo,
            from: [{ address: m.from }],
            to: [{ address: m.to }],
          },
          headers: Buffer.from(m.references ? `References: ${m.references}\r\n` : ""),
        };
      }
    },
  };
  return { client: client as any, searched };
}

const isOwn = (address: string) => address === ME;

describe("findConversation", () => {
  it("collects a conversation from every folder, including replies without the seed's words", async () => {
    const { client, searched } = fakeClient([
      { path: "Sent Messages", uid: 242, day: 1, messageId: "<a@me>", subject: SUBJECT, from: ME, to: HIM }, // prettier-ignore
      { path: "INBOX", uid: 152, day: 2, messageId: "<b@yahoo>", inReplyTo: "<a@me>", references: "<a@me>", subject: `Re: ${SUBJECT}`, from: HIM, to: ME }, // prettier-ignore
      { path: "Sent Messages", uid: 289, day: 3, messageId: "<c@me>", inReplyTo: "<b@yahoo>", references: "<a@me> <b@yahoo>", subject: `Re: ${SUBJECT}`, from: ME, to: HIM }, // prettier-ignore
      // Its reply headers were dropped: found by subject and correspondent.
      { path: "INBOX", uid: 156, day: 4, messageId: "<d@yahoo>", subject: `RE: ${SUBJECT}`, from: HIM, to: ME }, // prettier-ignore
      // Another subject, answering the one above: found in the next round.
      { path: "Sent Messages", uid: 293, day: 5, messageId: "<e@me>", inReplyTo: "<d@yahoo>", subject: "回覆：改下午兩點", from: ME, to: HIM }, // prettier-ignore
      // A copy of the seed counts once.
      { path: "Archive", uid: 9, day: 2, messageId: "<b@yahoo>", references: "<a@me>", subject: `Re: ${SUBJECT}`, from: HIM, to: ME }, // prettier-ignore
      // Same words in a longer subject, or the same subject with someone else.
      { path: "INBOX", uid: 160, day: 6, messageId: "<f@yahoo>", subject: `${SUBJECT} (2)`, from: HIM, to: ME }, // prettier-ignore
      { path: "INBOX", uid: 170, day: 7, messageId: "<g@x>", subject: `Re: ${SUBJECT}`, from: "other@x.com", to: ME }, // prettier-ignore
      // Junk is not searched.
      { path: "Junk", uid: 3, day: 8, messageId: "<h@x>", references: "<a@me>", subject: `Re: ${SUBJECT}`, from: HIM, to: ME }, // prettier-ignore
    ]);
    const found = await findConversation(client, { path: "INBOX", uid: 152 }, isOwn);
    expect(found).toEqual({
      messages: [
        { path: "Sent Messages", uid: 242 },
        { path: "INBOX", uid: 152 },
        { path: "Sent Messages", uid: 289 },
        { path: "INBOX", uid: 156 },
        { path: "Sent Messages", uid: 293 },
      ],
      omitted: 0,
    });
    expect([...new Set(searched)]).toEqual(["INBOX", "Sent Messages", "Archive"]);
  });

  it("keeps the newest messages of a long conversation", async () => {
    const messages = Array.from({ length: 55 }, (_, i) => ({
      path: "INBOX",
      uid: i + 1,
      day: i + 1,
      messageId: `<m${i}@x>`,
      references: i ? "<m0@x>" : undefined,
      subject: "Plan",
      from: HIM,
      to: ME,
    }));
    const found = await findConversation(
      fakeClient(messages).client,
      { path: "INBOX", uid: 1 },
      isOwn
    );
    expect(found.omitted).toBe(5);
    expect(found.messages[0]).toEqual({ path: "INBOX", uid: 6 });
    expect(found.messages.at(-1)).toEqual({ path: "INBOX", uid: 55 });
  });

  it("fails for a message that is gone", async () => {
    await expect(
      findConversation(fakeClient([]).client, { path: "INBOX", uid: 1 }, isOwn)
    ).rejects.toThrow(/no longer in "INBOX"/);
  });
});

describe("baseSubject", () => {
  it("drops reply and forward prefixes in several languages", () => {
    expect(baseSubject("Re: RE: Fwd:  Lunch  plans")).toBe("Lunch plans");
    expect(baseSubject("回覆：轉寄: 會議")).toBe("會議");
    expect(baseSubject("Re[2]: Budget")).toBe("Budget");
    expect(baseSubject("Reminder: Budget")).toBe("Reminder: Budget");
    expect(baseSubject(undefined)).toBe("");
  });
});
