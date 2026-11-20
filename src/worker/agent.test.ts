import { describe, expect, it } from "vitest";
import { AgentMcp, type Env } from "@/worker/index.js";

/** An AgentMcp whose MailSession records the requests it receives. */
function entrypoint() {
  const received: Request[] = [];
  const named: string[] = [];
  const env = {
    ICLOUD_MAIL_PREFERENCES: "{}",
    MAIL_SESSION: {
      idFromName(name: string) {
        named.push(name);
        return name;
      },
      get() {
        return {
          async fetch(request: Request) {
            received.push(request);
            return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
          },
        };
      },
    },
  } as unknown as Env;
  return { agent: new AgentMcp({}, env), received, named };
}

const call = (path: string, init: RequestInit = {}) =>
  new Request(`https://agent.internal${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2025-06-18",
      "Mcp-Session-Id": "session-1",
      "Last-Event-ID": "event-7",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ...init,
  });

describe("AgentMcp", () => {
  it("passes /mcp to the MailSession with its method, headers and body", async () => {
    const { agent, received, named } = entrypoint();
    const response = await agent.fetch(call("/mcp"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(named).toEqual(["icloud"]);
    const [forwarded] = received;
    expect(forwarded.method).toBe("POST");
    expect(new URL(forwarded.url).pathname).toBe("/mcp");
    for (const [name, value] of [
      ["content-type", "application/json"],
      ["accept", "application/json, text/event-stream"],
      ["mcp-protocol-version", "2025-06-18"],
      ["mcp-session-id", "session-1"],
      ["last-event-id", "event-7"],
    ]) {
      expect(forwarded.headers.get(name)).toBe(value);
    }
    expect(await forwarded.json()).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });

  it("names no OAuth grant, and drops one the caller claims", async () => {
    const { agent, received } = entrypoint();
    const spoofed = call("/mcp");
    spoofed.headers.set("x-mail-oauth-grant", "someone-elses-grant");
    await agent.fetch(spoofed);
    expect(received[0].headers.has("x-mail-oauth-grant")).toBe(false);
  });

  it("answers like the public /mcp to other methods", async () => {
    const { agent, received } = entrypoint();
    const response = await agent.fetch(call("/mcp", { method: "GET", body: null }));
    expect(response.status).toBe(405);
    expect(received).toHaveLength(0);
  });

  it("serves nothing but MCP", async () => {
    const { agent, received } = entrypoint();
    for (const path of ["/", "/mcpx", "/authorize", "/accounts", "/healthz"]) {
      expect((await agent.fetch(call(path))).status, path).toBe(404);
    }
    expect(received).toHaveLength(0);
  });
});
