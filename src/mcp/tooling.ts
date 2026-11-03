/**
 * Tool registration shared by every service the connector serves, so each
 * tool publishes schemas that strict hosts such as ChatGPT accept.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** The schema inside optional, default and nullable wrappers. */
function unwrapped(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrapped(schema.unwrap());
  }
  return schema instanceof z.ZodDefault ? unwrapped(schema.removeDefault()) : schema;
}

/**
 * A client that cached an older tool list sends an argument it does not know
 * as text, so "true" and "false" are read as booleans.
 */
function textBoolean(value: unknown): unknown {
  return value === "true" ? true : value === "false" ? false : value;
}

/**
 * Strict-mode clients such as ChatGPT send null for every optional argument
 * they leave unset; treat that as absent so defaults apply. Booleans also
 * accept "true" and "false".
 */
export function nullAsAbsent(shape: z.ZodRawShape): z.ZodRawShape {
  // Keep optional/default wrappers outside nullable so the exported JSON
  // Schema accepts null too, without hiding defaults inside a union branch.
  function allowNull(schema: z.ZodTypeAny): z.ZodTypeAny {
    const nullable =
      schema instanceof z.ZodOptional
        ? allowNull(schema.unwrap()).optional()
        : schema instanceof z.ZodDefault
          ? allowNull(schema.removeDefault()).default(schema._def.defaultValue)
          : schema.nullable();
    return schema.description ? nullable.describe(schema.description) : nullable;
  }
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => {
      const read =
        unwrapped(schema) instanceof z.ZodBoolean ? textBoolean : (value: unknown) => value;
      return [
        key,
        schema.isOptional()
          ? z.preprocess((value) => read(value ?? undefined), allowNull(schema))
          : read === textBoolean
            ? z.preprocess(textBoolean, schema)
            : schema,
      ];
    })
  );
}

/** Render a handler's value, or its error, as an MCP tool result. */
export async function toolResult(run: () => Promise<any>): Promise<ToolResult> {
  try {
    const data = await run();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
      isError: data?.success === false,
    };
  } catch (e) {
    return {
      content: [
        { type: "text" as const, text: e instanceof Error ? e.message : "Operation failed" },
      ],
      isError: true,
    };
  }
}

/** Register one tool with nullable optional arguments. */
export function registerTool(
  server: McpServer,
  name: string,
  config: { description: string; inputSchema: z.ZodRawShape; annotations: ToolAnnotations },
  handler: (args: any) => Promise<ToolResult>
): void {
  // Runtime-validated dynamic schemas avoid the SDK's recursive Zod v3/v4 inference.
  const register = server.registerTool as unknown as (
    name: string,
    config: {
      description: string;
      inputSchema: z.ZodRawShape;
      annotations: ToolAnnotations;
    },
    handler: (args: any) => Promise<ToolResult>
  ) => unknown;
  register.call(
    server,
    name,
    { ...config, inputSchema: nullAsAbsent(config.inputSchema) },
    handler
  );
}
