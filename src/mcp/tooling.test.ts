import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { nullAsAbsent, registerTool, toolResult } from "@/mcp/tooling.js";

const shape = {
  name: z.string().optional(),
  link: z.boolean().default(false),
  flagged: z.boolean().optional(),
  confirm: z.boolean(),
};

describe("nullAsAbsent", () => {
  const schema = z.object(nullAsAbsent(shape));

  it("treats null as absent so defaults apply", () => {
    expect(schema.parse({ name: null, link: null, flagged: null, confirm: true })).toEqual({
      link: false,
      confirm: true,
    });
  });

  it('reads "true" and "false" as booleans, from clients with an older tool list', () => {
    expect(schema.parse({ link: "true", flagged: "false", confirm: "true" })).toEqual({
      link: true,
      flagged: false,
      confirm: true,
    });
    expect(schema.parse({ name: "true", confirm: false })).toEqual({
      name: "true",
      link: false,
      confirm: false,
    });
    expect(() => schema.parse({ link: "yes", confirm: true })).toThrow();
  });

  it("still publishes booleans as booleans", async () => {
    const server = new McpServer({ name: "test", version: "1" });
    registerTool(
      server,
      "probe",
      {
        description: "Probe",
        inputSchema: shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (args) => toolResult(async () => args)
    );
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const [tool] = (await client.listTools()).tools;
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.confirm.type).toBe("boolean");
    expect(JSON.stringify(properties.link)).toContain('"boolean"');
    const result = await client.callTool({
      name: "probe",
      arguments: { link: "true", confirm: "false" },
    });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual({
      link: true,
      confirm: false,
    });
  });
});
