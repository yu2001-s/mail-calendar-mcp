/**
 * The public home and privacy pages Google requires before an OAuth app with
 * Gmail and Calendar access can be published.
 */
import { CONNECTOR_DESCRIPTION, CONNECTOR_TITLE } from "../mcp/identity.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import { page } from "./consent.js";

function html(title: string, body: string): Response {
  return new Response(page(title, body), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}

export function homePage(): Response {
  return html(
    CONNECTOR_TITLE,
    `<h1>${escapeHtml(CONNECTOR_TITLE)}</h1>
<p>${escapeHtml(CONNECTOR_DESCRIPTION)}</p>
<p>A private connector for its owner's AI assistants (Claude and ChatGPT).</p>
<p>It serves only the person who deployed it: every connection and every linked account is approved with the owner's password. It is not offered to the public.</p>
<p><a href="/privacy">Privacy policy</a></p>`
  );
}

export function privacyPage(): Response {
  return html(
    "Privacy policy",
    `<h1>Privacy policy</h1>
<p>This connector is run by its owner for their own accounts only.</p>
<h2>Data accessed</h2>
<p>With the owner's approval it accesses the owner's iCloud mail, and for each Google account the owner links, Gmail (read, compose, send, labels, trash) and Google Calendar (calendars and events). It does so when the owner's AI assistant calls one of its tools. If an assistant registers a new-mail webhook, it also checks iCloud mail about once a minute and sends each new message's sender, recipients, subject and date to that webhook, until the webhook is removed or the connection that set it is revoked or expires.</p>
<h2>Data stored</h2>
<p>It stores the OAuth grants of approved assistants, the owner's mail settings and signatures, and an encrypted refresh token for each linked Google account. Mail and calendar content is not stored; it is passed to the requesting assistant and discarded.</p>
<h2>Sharing</h2>
<p>Data is never sold, shared with third parties, or used for advertising or model training by this connector. The use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Removal</h2>
<p>The owner can remove a Google account on the connector's accounts page, which revokes its access, or at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>`
  );
}
