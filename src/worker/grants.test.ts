import { describe, expect, it } from "vitest";
import { grantFromHeader, liveGrantIds, stampGrantId, withGrantHeader } from "@/worker/grants.js";

/** The KV calls the OAuth library makes, over a map; pages hold pageSize keys. */
function memoryKv(entries: Record<string, unknown>, pageSize = 1000) {
  return {
    async get(key: string) {
      return entries[key] ?? null;
    },
    async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
      const names = Object.keys(entries).filter((k) => k.startsWith(prefix));
      const start = Number(cursor ?? 0);
      const end = start + pageSize;
      return {
        keys: names.slice(start, end).map((name) => ({ name })),
        list_complete: end >= names.length,
        cursor: String(end),
      };
    },
  };
}

const grant = (id: string) => ({ id, clientId: "client", userId: "owner", scope: ["mail"] });

describe("liveGrantIds", () => {
  it("lists the owner's grants through the OAuth library", async () => {
    const OAUTH_KV = memoryKv({
      "grant:owner:a": grant("a"),
      "grant:owner:b": grant("b"),
      "grant:someone:c": grant("c"),
      "token:owner:a:x": { id: "x" },
      "google-accounts:v1": {},
    });
    expect((await liveGrantIds({ OAUTH_KV })).sort()).toEqual(["a", "b"]);
  });

  it("follows every page", async () => {
    const OAUTH_KV = memoryKv(
      {
        "grant:owner:a": grant("a"),
        "grant:owner:b": grant("b"),
        "grant:owner:c": grant("c"),
      },
      2
    );
    expect((await liveGrantIds({ OAUTH_KV })).sort()).toEqual(["a", "b", "c"]);
  });

  it("is empty once the entries are deleted", async () => {
    expect(await liveGrantIds({ OAUTH_KV: memoryKv({ "google-accounts:v1": {} }) })).toEqual([]);
  });

  it("rejects when KV fails, rather than reporting no grants", async () => {
    const OAUTH_KV = {
      list: async () => {
        throw new Error("KV unavailable");
      },
    };
    await expect(liveGrantIds({ OAUTH_KV })).rejects.toThrow("KV unavailable");
  });
});

describe("the grant header", () => {
  const forged = () =>
    new Request("https://worker.example/mcp", {
      method: "POST",
      headers: { "x-mail-oauth-grant": "forged", "Content-Type": "application/json" },
      body: "{}",
    });

  it("replaces a value sent by the client", async () => {
    const forwarded = withGrantHeader(forged(), "grant-a");
    expect(grantFromHeader(forwarded)).toBe("grant-a");
    expect(forwarded.headers.get("content-type")).toBe("application/json");
    expect(await forwarded.text()).toBe("{}");
  });

  it("removes a value sent by the client when the token names no grant", () => {
    expect(grantFromHeader(withGrantHeader(forged()))).toBeUndefined();
  });
});

describe("stampGrantId", () => {
  it("adds the grant to the access token's props and leaves the grant's alone", () => {
    const props = { other: 1 };
    expect(stampGrantId({ grantId: "grant-a", props })).toEqual({
      accessTokenProps: { other: 1, grantId: "grant-a" },
    });
    expect(props).toEqual({ other: 1 });
  });
});
