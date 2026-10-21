# Cloudflare Worker deployment

The connector runs on Cloudflare. Add it once to your Claude and ChatGPT
accounts and it follows you to every device: nothing is installed per device
and no computer has to stay on.

```text
Claude / ChatGPT (any device) ──HTTPS──▶ Worker: OAuth + MCP ──TLS──▶ iCloud IMAP / SMTP
                                            │                 └─HTTPS─▶ Gmail / Calendar APIs
                                            └─ KV: OAuth grants, settings, sealed Google tokens
```

Gmail and Google Calendar accounts are optional; set them up with
[GOOGLE.md](GOOGLE.md) after the steps below.

## Deploy

Requires a Cloudflare account and, on the Mac you deploy from, the iCloud
account configuration described below. From the repository:

```sh
pnpm install --frozen-lockfile
npx wrangler login
node scripts/setup-worker.mjs
```

The script deploys the Worker (creating its KV namespace and the R2 bucket for
attachment uploads), then uploads
everything personal as encrypted Worker secrets: your addresses, the app
passwords read from Keychain, your preferences and signatures, and a new
owner password, which it prints once. Save that password; it approves every
connection. Nothing personal is committed to `wrangler.jsonc`.

Settings are edited from chat afterwards, for example "make hello@example.com
my default sender" or "change my signature for me@example.com". They are
stored in the Worker's KV; the `ICLOUD_MAIL_PREFERENCES` secret only seeds
them on first use. To update account secrets such as an app password:

```sh
node scripts/setup-worker.mjs --secrets
```

Later runs keep the existing owner password; set `ICLOUD_MAIL_OWNER_PASSWORD`
in the environment to choose or rotate it. Rotating it does not disconnect
clients you already approved. Redeploy code changes with
`npx wrangler deploy`; run the script once more first if the R2 bucket named in
`wrangler.jsonc` does not exist yet.

### iCloud account configuration

The script reads the account settings from
`~/Library/Application Support/apple-mail-mcp/config.json` (or the file named
by `APPLE_MAIL_MCP_CONFIG_FILE`): `APPLE_MAIL_MCP_IMAP_HOST`
(`imap.mail.me.com`), `APPLE_MAIL_MCP_IMAP_USER`, `APPLE_MAIL_MCP_IMAP_ACCOUNT`,
`APPLE_MAIL_MCP_SMTP_HOST` (`smtp.mail.me.com`), `APPLE_MAIL_MCP_SMTP_USER`,
and the sending addresses in `APPLE_MAIL_MCP_SMTP_FROM` and
`APPLE_MAIL_MCP_SMTP_ALLOWED_FROM`. The Apple app-specific passwords come from
`APPLE_MAIL_MCP_IMAP_PASSWORD` and `APPLE_MAIL_MCP_SMTP_PASSWORD`, or from the
Keychain items named by the `*_KEYCHAIN_SERVICE` and `*_KEYCHAIN_ACCOUNT`
settings:

```sh
security add-generic-password -s <KEYCHAIN_SERVICE> -a <KEYCHAIN_ACCOUNT> -w
```

`~/.codex/integrations/icloud-mail/preferences.json` (or the directory in
`ICLOUD_MAIL_DATA_DIR`) supplies `primaryAddress` and a `signatures` object
keyed by sender address. It only seeds the settings on first use. Once
connected, the `health_check` tool verifies IMAP and SMTP authentication
without sending.

### Worker URL

The Worker URL is `https://icloud-mail.<your-subdomain>.workers.dev`; a custom
domain can be added in the Cloudflare dashboard. If it answers on more than one
hostname, set `ICLOUD_MAIL_PUBLIC_URL` so tokens are bound to one origin.

## Connect

The connector URL is `<Worker URL>/mcp`. Each connection opens an approval page
that asks for the owner password.

- **Claude**: Settings → Connectors → Add custom connector. A connector added
  on claude.ai is available in the web, desktop and mobile apps.
- **ChatGPT**: Settings → Apps & Connectors → Advanced settings → Developer
  mode, then Create, with the URL and OAuth authentication. ChatGPT limits
  which plans may use custom connectors and their write actions, and whether
  they work in its mobile apps is not documented; check your plan.
- **Claude Code** on any machine:

  ```sh
  claude mcp add --transport http icloud-mail https://icloud-mail.<your-subdomain>.workers.dev/mcp
  ```

After changing tool parameters, deploy the Worker, then open the existing
iCloud Mail plugin in ChatGPT, choose **Manage**, and select **Refresh tools**.
Start a new conversation if the host still has the old tool definitions.
See [OpenAI's metadata refresh guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
ID patterns must match the complete value: `^imap:[A-Za-z0-9_-]+$` works with
the host's full-match validation, while a prefix-only `^imap:` does not.

## Attachments

The Worker cannot read files on your computer, so an attachment reaches it in
one of two ways:

- **Inline**: `{filename, contentBase64}` in the tool call. The model has to
  write out every base64 character, so this suits small files it produced
  itself.
- **Upload**: in a client that can run shell commands, such as Claude Code,
  `create_attachment_upload` returns a one-time URL. The client uploads the
  file to it with `curl -T` and attaches it as `{uploadId}`, to iCloud drafts
  (`create_draft`, `update_draft`) or Gmail (`gmail_create_draft`,
  `gmail_update_draft`, `gmail_send_message`). The file never passes through
  the conversation. Up to 25 MiB.

Uploads are kept in the R2 bucket named in `wrangler.jsonc`. Once a draft or
message has one, its file is replaced by an empty marker, so its link cannot
upload again. A draft that fails keeps its uploads, so the same `uploadId` can
be retried. A lifecycle rule set by `setup-worker.mjs` deletes anything left,
markers included, after a day.

## New-mail webhooks

`mail_listen_set {name, url, account?, mailboxes?, headers?}` registers a
webhook for new iCloud mail; `mail_listen_list` and `mail_listen_remove {name}`
manage them, like the LINE connector's `line_listen_*` tools. Setting an
existing name replaces that listener.

A Worker cannot keep an IMAP IDLE connection open, so the `MailSession`
Durable Object polls instead: while any listener exists, an alarm fires about
every 60 seconds, opens a short-lived IMAP connection, `EXAMINE`s each watched
mailbox (read-only, so no flag, `\Seen` included, can change) and fetches only
the envelopes of messages above the last UID delivered. Each new message is
POSTed to the listener's `url` with its `headers`:

```json
{
  "text": "New mail in INBOX from Ann: Hello",
  "listener": "courier",
  "account": "me@example.com",
  "mailbox": "INBOX",
  "message": {
    "id": "imap:…",
    "rfcMessageId": "<…@example.com>",
    "inReplyTo": null,
    "from": { "name": "Ann", "address": "ann@example.com" },
    "to": [{ "name": null, "address": "me@example.com" }],
    "subject": "Hello",
    "date": "2026-10-21T09:00:00.000Z"
  }
}
```

`message.id` is the ID `read_message` and `create_reply_draft` take. Bodies
are never sent. The last UID and UIDVALIDITY are stored per listener and
mailbox in Durable Object storage, so each message is sent once and restarts
never replay mail; a new or replaced listener starts after the newest message,
and a UIDVALIDITY change starts over the same way without firing. A delivery
that fails (non-2xx or a network error) is retried on later polls with
exponential backoff (1, 2, 4 … up to 30 minutes), holding back later messages
for that listener so they arrive in order; after 8 attempts the message is
skipped and logged. Only the iCloud account (its primary address) can be
watched, in `INBOX` and optionally `Junk` for bounces; Gmail accounts are
refused. The iCloud inbox holds mail for every address on the account, so a
listener hears all of them. Webhook URLs must be https; `mail_listen_list`
shows header names but not their values.

## Security

- `@cloudflare/workers-oauth-provider` implements OAuth 2.1: PKCE, single-use
  codes, rotating refresh tokens, tokens bound to the `/mcp` resource, and only
  hashes of tokens and secrets in KV. Access tokens last 1 hour; grants 30 days.
- Clients may register dynamically (Claude) or present a Client ID Metadata
  Document (ChatGPT), but codes are only ever sent to the claude.ai,
  claude.com and chatgpt.com connector callbacks or to a loopback address. Add
  exact callbacks with `ICLOUD_MAIL_OAUTH_REDIRECT_URIS` (comma-separated).
- The approval page's CSP `form-action` lists only the allowed callback
  origins, and browsers check it on every redirect after the form is
  submitted. If a callback redirects to another host, list that host's
  callback too. Cursor's `https://www.cursor.com/agents/mcp/oauth/callback`, for
  example, redirects to `https://cursor.com/agents/mcp/oauth/callback`, so it
  needs both. Otherwise approving seems to do nothing, and approving again
  shows "This authorization was not started in this browser".
- The approval page is bound to the browser that opened it and cannot be
  framed. After 10 wrong owner passwords in an hour, approval is locked for
  everyone until the hour passes.
- Upload links are signed with a key derived from `CONNECTOR_SECRET_KEY`.
  Each names its file, expires after 15 minutes and accepts one PUT of at most
  25 MiB. A link cannot read anything back; only the connector, behind OAuth,
  reads an upload. If someone else uses a link first, your upload fails with
  409 instead of being replaced. The upload reports a sha256 to compare with
  `shasum -a 256`.

To revoke every connection, delete the entries in the Worker's `OAUTH_KV`
namespace from the Cloudflare dashboard; each client then has to be approved
again with the owner password. Leave `google-accounts:v1` in place unless you
also mean to unlink every Google account.

## How it works

The Worker checks OAuth and hands each MCP request to one Durable Object
(`MailSession`), created in eastern North America next to iCloud's IMAP
servers. It keeps a single connector: one IMAP connection reused across tool
calls, the in-memory draft cache, and the queue that serializes mail
operations. The connection is logged out after three idle minutes. An open
socket keeps the object in memory and is billed as Durable Object duration;
even around the clock that stays within the free daily allowance.

The Worker itself runs next to iCloud too (`placement.host` in
`wrangler.jsonc`); the `cf-placement` response header shows the data center.
The first call after an idle period logs in again, which takes about a second;
later calls only pay the network trip to the Worker.

The Worker keeps no draft state. The iCloud Drafts mailbox is the source of
truth: each draft carries its connector ID in a header, so the connector finds,
edits and sends it no matter which client created it. While a send is in
flight or its outcome is uncertain, the server copy carries the
`$IcloudMailSending` keyword, and the draft is not sent again until the
outcome is resolved. Before submitting, the connector also checks Sent for the
same Message-ID, so a draft whose cleanup failed is never sent twice.

## Test locally

```sh
pnpm test:worker
```

This runs the Worker in local workerd with synthetic settings and walks the
complete OAuth flow and tool discovery without contacting iCloud.
