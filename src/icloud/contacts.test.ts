import { describe, expect, it } from "vitest";
import {
  ICloudContacts,
  MAX_WRITES,
  nameParts,
  uidFor,
  vcard,
  type ContactInput,
} from "./contacts.js";

const USER = "owner@icloud.com";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const AUTH = `Basic ${btoa(`${USER}:${PASSWORD}`)}`;
const PARTITION = "https://p42-contacts.icloud.com";
const BOOK = "/1234/carddav/card/";

/** iCloud's CardDAV as far as contacts_sync uses it, holding one card the owner made. */
function fakeICloud(options: { putEtags?: boolean } = {}) {
  const cards = new Map<string, { text: string; etag: string }>([
    [`${BOOK}OWNERS-OWN.vcf`, { text: "BEGIN:VCARD\r\nFN:Mom\r\nEND:VCARD\r\n", etag: '"own-1"' }],
  ]);
  const log: string[] = [];
  let version = 0;
  const multistatus = (rows: string[]) =>
    new Response(`<?xml version="1.0"?><multistatus xmlns="DAV:">${rows.join("")}</multistatus>`, {
      status: 207,
      headers: { "content-type": "text/xml" },
    });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    log.push(`${method} ${url.host}${url.pathname}`);
    if (headers.get("authorization") !== AUTH) return new Response("", { status: 401 });
    if (url.origin === "https://contacts.icloud.com") {
      if (url.pathname === "/" && method === "PROPFIND") {
        return multistatus([
          `<response><href>/</href><propstat><prop><current-user-principal><href>/1234/principal/</href></current-user-principal></prop></propstat></response>`,
        ]);
      }
      // iCloud sends a client on to the partition that holds its data.
      return new Response("", {
        status: 301,
        headers: { location: `${PARTITION}${url.pathname}` },
      });
    }
    if (url.pathname === "/1234/principal/") {
      return multistatus([
        `<response><href>/1234/principal/</href><propstat><prop><addressbook-home-set xmlns="urn:ietf:params:xml:ns:carddav"><href xmlns="DAV:">${PARTITION}:443/1234/carddav/</href></addressbook-home-set></prop></propstat></response>`,
      ]);
    }
    if (url.pathname === "/1234/carddav/" && headers.get("depth") === "1") {
      return multistatus([
        `<response><href>/1234/carddav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>`,
        `<response><href>${BOOK}</href><propstat><prop><resourcetype><collection/><addressbook xmlns="urn:ietf:params:xml:ns:carddav"/></resourcetype></prop></propstat></response>`,
      ]);
    }
    if (url.pathname === BOOK && method === "PROPFIND") {
      return multistatus([
        `<response><href>${BOOK}</href><propstat><prop><getetag/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>`,
        ...[...cards].map(
          ([path, card]) =>
            `<response><href>${path}</href><propstat><prop><getetag>${card.etag.replace(/"/g, "&quot;")}</getetag></prop></propstat></response>`
        ),
      ]);
    }
    if (method === "PUT") {
      const etag = `"v${++version}"`;
      const existed = cards.has(url.pathname);
      cards.set(url.pathname, { text: String(init?.body), etag });
      return new Response(null, {
        status: existed ? 204 : 201,
        headers: options.putEtags === false ? {} : { etag },
      });
    }
    if (method === "DELETE") {
      return new Response(null, { status: cards.delete(url.pathname) ? 204 : 404 });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { cards, log, fetch: fetcher };
}

function memoryKv() {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async put(key: string, value: string) {
      data.set(key, value);
    },
  };
}

const LIU: ContactInput = {
  id: "p_liu0000000",
  name: "劉慧卿",
  organization: "宏慈",
  phones: [{ number: "+886979307742", label: "mobile" }],
  emails: ["huangtzu@titan.seed.net.tw"],
};
const ZENG: ContactInput = {
  id: "p_zeng000000",
  name: "曾小姐",
  organization: "三總北投",
  phones: [{ number: "+886228959808", ext: "603361", label: "work" }],
};

describe("ICloudContacts", () => {
  it("writes each person as a card in the comms group and leaves the owner's own cards alone", async () => {
    const icloud = fakeICloud();
    const contacts = new ICloudContacts({
      user: USER,
      password: PASSWORD,
      store: memoryKv(),
      fetch: icloud.fetch,
    });

    const result = await contacts.sync([LIU, ZENG]);

    expect(result).toEqual({
      contacts: 2,
      created: 3,
      updated: 0,
      unchanged: 0,
      deleted: 0,
      pending: 0,
    });
    const liuUid = await uidFor(LIU.id);
    const liu = icloud.cards.get(`${BOOK}${liuUid}.vcf`)!.text;
    expect(liu).toContain("N:劉;慧卿;;;\r\n");
    expect(liu).toContain("ORG:宏慈;\r\n");
    expect(liu).toContain("TEL;type=CELL;type=VOICE;type=pref:+886979307742\r\n");
    expect(liu).toContain(`UID:${liuUid}\r\n`);
    const zeng = icloud.cards.get(`${BOOK}${await uidFor(ZENG.id)}.vcf`)!.text;
    expect(zeng).toContain("TEL;type=WORK;type=VOICE;type=pref:+886228959808,603361\r\n");
    const group = [...icloud.cards.values()].find((c) => c.text.includes("KIND:group"))!.text;
    expect(group).toContain("FN:comms\r\n");
    expect(group).toContain(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${liuUid}\r\n`);
    expect(icloud.cards.get(`${BOOK}OWNERS-OWN.vcf`)!.etag).toBe('"own-1"');
    // The redirect to the partition kept the credentials, and discovery happened once.
    expect(
      icloud.log.filter((l) => l.startsWith("PROPFIND p42-contacts.icloud.com/1234/principal/"))
    ).toHaveLength(1);
  });

  it("skips cards nobody changed, overwrites an edit made on the phone, and deletes people left out", async () => {
    const icloud = fakeICloud();
    const store = memoryKv();
    const contacts = new ICloudContacts({
      user: USER,
      password: PASSWORD,
      store,
      fetch: icloud.fetch,
    });
    await contacts.sync([LIU, ZENG]);

    expect(await contacts.sync([LIU, ZENG])).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 3,
    });
    expect(icloud.log.filter((l) => l === "PROPFIND contacts.icloud.com/")).toHaveLength(1);

    const liuPath = `${BOOK}${await uidFor(LIU.id)}.vcf`;
    icloud.cards.set(liuPath, { text: "edited on the phone", etag: '"phone"' });
    expect(await contacts.sync([LIU, ZENG])).toMatchObject({ updated: 1, unchanged: 2 });
    expect(icloud.cards.get(liuPath)!.text).toContain("FN:劉慧卿");

    expect(await contacts.sync([LIU])).toMatchObject({ deleted: 1, updated: 1, unchanged: 1 });
    expect(icloud.cards.has(`${BOOK}${await uidFor(ZENG.id)}.vcf`)).toBe(false);
    const group = [...icloud.cards.values()].find((c) => c.text.includes("KIND:group"))!.text;
    expect(group).not.toContain(await uidFor(ZENG.id));
    expect(icloud.cards.has(`${BOOK}OWNERS-OWN.vcf`)).toBe(true);
  });

  it("reads back ETags a write did not return, so the next sync can skip the card", async () => {
    const icloud = fakeICloud({ putEtags: false });
    const contacts = new ICloudContacts({
      user: USER,
      password: PASSWORD,
      store: memoryKv(),
      fetch: icloud.fetch,
    });
    await contacts.sync([LIU]);
    expect(await contacts.sync([LIU])).toMatchObject({ unchanged: 2 });
  });

  it("writes at most MAX_WRITES cards per call and says how many are left", async () => {
    const icloud = fakeICloud();
    const contacts = new ICloudContacts({
      user: USER,
      password: PASSWORD,
      store: memoryKv(),
      fetch: icloud.fetch,
    });
    const many = Array.from({ length: MAX_WRITES + 5 }, (_, i) => ({
      ...LIU,
      id: `p_${String(i).padStart(10, "0")}`,
    }));
    expect(await contacts.sync(many)).toMatchObject({ created: MAX_WRITES, pending: 6 });
    expect(await contacts.sync(many)).toMatchObject({
      created: 6,
      unchanged: MAX_WRITES,
      pending: 0,
    });
  });

  it("says when iCloud refuses the credentials", async () => {
    const icloud = fakeICloud();
    const contacts = new ICloudContacts({
      user: USER,
      password: "wrong",
      store: memoryKv(),
      fetch: icloud.fetch,
    });
    await expect(contacts.sync([LIU])).rejects.toThrow(/refused the Apple ID owner@icloud.com/);
  });

  it("refuses a list with the same person twice", async () => {
    const icloud = fakeICloud();
    const contacts = new ICloudContacts({
      user: USER,
      password: PASSWORD,
      store: memoryKv(),
      fetch: icloud.fetch,
    });
    await expect(contacts.sync([LIU, LIU])).rejects.toThrow(/twice/);
  });
});

describe("vcard", () => {
  it("escapes text and folds long lines", () => {
    const text = vcard("U", {
      id: "p_x",
      name: "A, B",
      phones: [{ number: "+15551234567" }],
      note: `line one\nline; two ${"長".repeat(40)}`,
    });
    expect(text).toContain("FN:A\\, B\r\n");
    expect(text).toContain("NOTE:line one\\nline\\; two ");
    for (const line of text.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it("splits names into family and given", () => {
    expect(nameParts("劉慧卿")).toEqual(["劉", "慧卿"]);
    expect(nameParts("Ada Lovelace")).toEqual(["Lovelace", "Ada"]);
    expect(nameParts("曾小姐")).toEqual(["曾", "小姐"]);
    expect(nameParts("Cher")).toEqual(["Cher", ""]);
  });
});
