/**
 * The connector's MCP server: iCloud mail, when configured, and every linked
 * Google account's Gmail and Calendar, on one endpoint.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectorContext } from "../icloud/context.js";
import { icloudInstructions, registerIcloudTools, type ToolOptions } from "../icloud/tools.js";
import type { GoogleAccounts } from "../google/accounts.js";
import { googleInstructions, registerGoogleTools } from "../google/tools.js";
import { CONNECTOR_DESCRIPTION, CONNECTOR_NAME, CONNECTOR_TITLE } from "./identity.js";
import { registerTool, toolResult } from "./tooling.js";
import { registerUploadTool, UPLOAD_INSTRUCTIONS } from "./uploads.js";
import {
  MAIL_LISTEN_INSTRUCTIONS,
  registerMailListenTools,
  type MailWatcher,
} from "../icloud/listeners.js";

declare const CONNECTOR_VERSION: string;

export interface ConnectorServices {
  icloud?: ConnectorContext;
  google?: GoogleAccounts;
}

export async function createConnectorServer(
  services: ConnectorServices,
  options: ToolOptions & { websiteUrl?: string; mailListeners?: MailWatcher } = {}
): Promise<McpServer> {
  const { icloud, google } = services;
  const parts: string[] = [];
  if (icloud) {
    parts.push(
      `iCloud mail (${icloud.account}) is served by the tools without a prefix, such as search_messages and create_reply_draft. ${icloudInstructions(icloud)}`
    );
  }
  if (google) {
    const linked = await google.summaries().catch(() => []);
    parts.push(googleInstructions(linked, google.manageUrl));
  }
  const mailListeners = icloud ? options.mailListeners : undefined;
  if (mailListeners) parts.push(MAIL_LISTEN_INSTRUCTIONS);
  const uploads = icloud || google ? options.uploads : undefined;
  if (uploads) parts.push(UPLOAD_INSTRUCTIONS);
  parts.push(
    "Use list_accounts to see every connected account. When the user asks about mail or calendar without naming an account, cover all of them."
  );
  const server = new McpServer(
    {
      name: CONNECTOR_NAME,
      title: CONNECTOR_TITLE,
      description: CONNECTOR_DESCRIPTION,
      version: CONNECTOR_VERSION,
      ...(options.websiteUrl && { websiteUrl: options.websiteUrl }),
    },
    { instructions: parts.join("\n\n") }
  );
  if (icloud) registerIcloudTools(server, icloud, options);
  if (google) registerGoogleTools(server, google, uploads);
  if (mailListeners) registerMailListenTools(server, mailListeners);
  if (uploads) registerUploadTool(server, uploads);
  registerTool(
    server,
    "list_accounts",
    {
      description:
        "List every account this connector serves: the iCloud mail account with its sending addresses, and each linked Google account with the services it granted (gmail, calendar).",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    () =>
      toolResult(async () => {
        if (icloud) await icloud.refresh();
        return {
          icloud: icloud
            ? {
                account: icloud.account,
                primaryAddress: icloud.settings.primaryAddress,
                addresses: icloud.settings.addresses,
              }
            : null,
          google: google ? await google.summaries() : [],
          ...(google && { manageGoogleAccounts: google.manageUrl }),
        };
      })
  );
  return server;
}
