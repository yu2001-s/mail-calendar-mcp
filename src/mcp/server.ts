/**
 * The connector's MCP server: one set of mail tools over iCloud mail, when
 * configured, and every linked Gmail account, plus Google Calendar, on one
 * endpoint.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectorContext } from "../icloud/context.js";
import type { GoogleAccounts, GoogleAccountSummary } from "../google/accounts.js";
import { Gmail } from "../google/gmail.js";
import { googleInstructions, registerGoogleTools } from "../google/tools.js";
import { addressDisplayName } from "../icloud/settings.js";
import { mailInstructions, registerMailTools } from "../mail/tools.js";
import { CONNECTOR_DESCRIPTION, CONNECTOR_NAME, CONNECTOR_TITLE } from "./identity.js";
import { registerTool, toolResult } from "./tooling.js";
import { registerUploadTool, UPLOAD_INSTRUCTIONS, type Uploads } from "./uploads.js";
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

/**
 * What each part of the connector does. Hosts keep only the first 2048
 * characters (server.test.ts checks), so the details live in the tool
 * descriptions and the Google account list, which grows, comes last.
 */
export function connectorInstructions(parts: {
  mail?: { primaryAddress?: string };
  google?: { linked: GoogleAccountSummary[]; manageUrl: string };
  mailListeners?: boolean;
  uploads?: boolean;
}): string {
  return [
    parts.mail && mailInstructions(parts.mail.primaryAddress),
    parts.mailListeners && MAIL_LISTEN_INSTRUCTIONS,
    parts.uploads && UPLOAD_INSTRUCTIONS,
    "list_accounts lists every connected account and the addresses each sends from.",
    parts.google && googleInstructions(parts.google.linked, parts.google.manageUrl),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function createConnectorServer(
  services: ConnectorServices,
  options: {
    uploads?: Uploads;
    websiteUrl?: string;
    mailListeners?: MailWatcher;
    /** The OAuth grant behind this request; webhooks it sets end with it. */
    mailListenGrant?: string;
  } = {}
): Promise<McpServer> {
  const { icloud, google } = services;
  // A display name saved here for a Gmail address goes on its mail too.
  const gmail =
    google &&
    new Gmail(google, {
      displayName: (address) => icloud && addressDisplayName(icloud.settings, address),
    });
  const mailListeners = icloud ? options.mailListeners : undefined;
  const uploads = icloud || google ? options.uploads : undefined;
  const instructions = connectorInstructions({
    mail: icloud || google ? { primaryAddress: icloud?.settings.primaryAddress } : undefined,
    google: google && {
      linked: await google.summaries().catch(() => []),
      manageUrl: google.manageUrl,
    },
    mailListeners: !!mailListeners,
    uploads: !!uploads,
  });
  const server = new McpServer(
    {
      name: CONNECTOR_NAME,
      title: CONNECTOR_TITLE,
      description: CONNECTOR_DESCRIPTION,
      version: CONNECTOR_VERSION,
      ...(options.websiteUrl && { websiteUrl: options.websiteUrl }),
    },
    { instructions }
  );
  if (icloud || google) registerMailTools(server, { icloud, google, gmail, uploads });
  if (google) registerGoogleTools(server, google);
  if (mailListeners) registerMailListenTools(server, mailListeners, options.mailListenGrant);
  if (uploads) registerUploadTool(server, uploads);
  registerTool(
    server,
    "list_accounts",
    {
      description:
        "List every account this connector serves: the iCloud mail account with its sending addresses, and each linked Google account with the services it granted (gmail, calendar) and its Gmail send-as addresses.",
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
        const linked = google ? await google.summaries() : [];
        return {
          icloud: icloud
            ? {
                account: icloud.account,
                primaryAddress: icloud.settings.primaryAddress,
                addresses: icloud.settings.addresses,
              }
            : null,
          google: await Promise.all(
            linked.map(async (item) =>
              item.services.includes("gmail") && gmail
                ? {
                    ...item,
                    addresses: (await gmail.sendAs(item.email)).map((alias) => alias.sendAsEmail),
                  }
                : item
            )
          ),
          ...(google && { manageGoogleAccounts: google.manageUrl }),
        };
      })
  );
  return server;
}
