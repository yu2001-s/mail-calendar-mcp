# Changelog

## Unreleased

- The server instructions and `gmail_create_draft` now say that a reviewed
  Gmail draft is sent with `gmail_send_message` and its `draftId`. Without
  this, a host looking for a way to send the draft found only the iCloud
  `send_draft` and resent the text as a new message instead.
- New-mail webhooks for iCloud: `mail_listen_set`, `mail_listen_list` and
  `mail_listen_remove`. The Durable Object polls INBOX (and Junk, if asked)
  about once a minute, read-only, and POSTs each new message's headers, never
  its body, to the registered URL, once, with retries and backoff. Gmail
  accounts cannot be watched. See docs/WORKER.md#new-mail-webhooks.
- The repository is renamed `yu2001-s/mail-calendar-mcp` (package
  `mail-calendar-mcp`). The Worker (`icloud-mail`), its URL and the
  `APPLE_MAIL_MCP_*` configuration are unchanged.

## 1.6.0 — 2026-10-08

- The Cloudflare Worker is now the only way to run the connector. The local
  stdio plugin for Claude Code and Codex (`plugins/icloud-mail/`), the
  self-hosted HTTP server (`--http`, `deploy/`, docs/REMOTE.md) and their
  install, packaging and verification scripts are removed, along with the code
  only they used: Keychain lookups, the local config-file loader, file-backed
  settings and draft caches, attachments by file path, and leftover
  AppleScript-era types and helpers. `scripts/setup-worker.mjs` still reads
  the same local configuration to set the Worker's secrets.
- Serve Gmail and Google Calendar for any number of Google accounts from the
  Worker, on the same connector URL. Accounts are linked and removed at
  `/accounts` behind the owner password; refresh tokens are stored in KV
  encrypted with the new `CONNECTOR_SECRET_KEY`. See docs/GOOGLE.md.
- 29 `gmail_*` tools matching Google's Gmail connector (threads, messages,
  attachments, drafts, send, reply, forward, labels, trash, spam), each with an
  `account` argument; `gmail_search_threads` searches every account when it is
  omitted. Draft updates keep attachments unless replaced.
- 8 `calendar_*` tools: calendars, events merged across accounts, create,
  update, delete, RSVP, and free time across every account.
- `list_accounts` lists the iCloud account and each linked Google account.
- The Worker introduces itself as **Mail & Calendar** (`mail-calendar`, with a
  title, description and website in its server info) on its OAuth metadata,
  approval page and home page. The Worker URL is unchanged.
- "Not spam" and untrash return only received mail to the inbox, never the
  user's own sent messages. Event times are shown in the event's own time zone
  (or the requested one) rather than the calendar's, free time in the offset it
  was asked in, and snippets and bodies lose invisible padding and long rules.
- iCloud display names: `set_display_name` sets the name recipients see (a
  default for every sending address, or one address's own), shown in
  `list_sending_addresses`.
- Nicknames for Google accounts (e.g. `work`), set on `/accounts` or with
  `set_account_nickname`, accepted wherever a tool takes `account`.
- Attachment uploads: `create_attachment_upload` returns a signed, single-use
  URL. A client that can run shell commands (Claude Code) uploads a local file
  to it with `curl -T` and attaches it to iCloud or Gmail mail as
  `{uploadId}`, so the file never passes through the conversation. Files are
  kept in a new R2 bucket and deleted once attached, or after a day.
- The Worker's `create_draft` and `update_draft` no longer describe
  attachments as local paths, which a remote server cannot read.
- `scripts/setup-worker.mjs` uploads `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
  creates `CONNECTOR_SECRET_KEY` once and the uploads bucket with its
  lifecycle rule, and now stops if it cannot list the existing secrets instead
  of replacing them.

## 1.5.0 — 2026-10-05

- Serve MCP on the Worker from a Durable Object that keeps one IMAP
  connection open across tool calls, closing it after three idle minutes.
- Run the Worker next to iCloud's IMAP servers (`placement.host`).
- iCloud-backed tool calls measured from Taipei: 3.0-4.4 s before, about
  0.6 s now, most of it the network trip to the Worker.
- Expose the body of a single-part message as an attachment. Google's DMARC
  reports, whose whole message is one `.zip`, read as empty with no
  attachments; `list_attachments` and `fetch_attachment` now return the zip.

## 1.4.1 — 2026-10-02

- Publish optional tool arguments as nullable in JSON Schema. ChatGPT
  validates arguments against the schema itself and rejected the `null` it
  sends for unset fields before the request reached the server.

## 1.4.0 — 2026-10-02

- Settings editable from chat: `update_settings` changes the primary (default)
  sender and the sending addresses, `set_signature` sets or clears a
  sender's signature. Settings live in `settings.json` locally and in KV on
  the Worker, seeded from the existing configuration on first use.
- Discover sending addresses: `list_sending_addresses` adds addresses used in
  Sent (rescanned daily, or with `refresh`) and suggests custom-domain
  recipients from the inbox. Addresses the user removed are never re-added.
- Tool schemas and descriptions no longer embed addresses, so settings
  changes need no tool refresh in ChatGPT; sender addresses are checked at
  run time, including at send time for existing drafts.
- Inline every schema field instead of emitting `$ref`.

## 1.3.1 — 2026-10-02

- Publish ID patterns ChatGPT's connector validator accepts: no escaped
  punctuation (zod's `startsWith()` emitted `^imap\:`) and anchored to the
  whole value (`^imap:[A-Za-z0-9_-]+$`), since it requires a full match.
- Lower `read_message`'s minimum `maxBodyChars` to 100.
- Accept `null` for optional tool arguments, as strict-mode clients such as
  ChatGPT send; `update_draft` now removes the HTML part only for an empty
  `htmlBody` string.
- Drop the repository plugin marketplaces in favour of the account-level
  Worker connector; the plugin directory still loads with `--plugin-dir`.

## 1.3.0 — 2026-10-01

- Package the connector as a Claude Code plugin with a repository
  marketplace, alongside the Codex Plugin.
- Start the server through a portable launcher that finds Node.js 20+ instead
  of a hard-coded Homebrew path.
- Treat the iCloud Drafts mailbox as the source of truth: drafts from other
  devices are recovered by their ID header, a `$IcloudMailSending` keyword
  blocks duplicate sends across devices, and a Sent Message-ID check prevents
  resending a draft whose cleanup failed.
- Add a remote Streamable HTTP mode with a built-in single-owner OAuth 2.1
  server for claude.ai custom connectors, plus Docker and Cloudflare Tunnel
  deployment files.
- Accept inline base64 attachments; remote callers cannot attach server files.
- Deploy as a Cloudflare Worker (`scripts/setup-worker.mjs`): OAuth through
  `@cloudflare/workers-oauth-provider` with dynamic registration for Claude and
  Client ID Metadata Documents for ChatGPT, secrets loaded from the existing
  Keychain configuration, and no per-device installation.
- Accept ChatGPT connector OAuth callbacks alongside Claude's.
- Fix an ImapFlow lost-wakeup race that stalled the first command after login
  in the Workers runtime.

## 1.2.1 — 2026-10-01

- Consolidate on the direct iCloud Mail Plugin; remove the obsolete Apple Mail
  connector, its bundles, Skill, launch entrypoints, and automation code.
- Move the customized iCloud source and signature tests into the repository;
  build the standalone plugin here instead of copying an older installation.
- Preserve existing preferences, draft IDs/revisions, account configuration,
  and Keychain credentials.
- Keep one marketplace entry and add an isolated standalone boot check.

## 1.2.0 — 2026-10-01

- Package the customized iCloud MCP as a personal Codex Plugin.
- Add direct mail/reply verification and a minimal usage Skill.

Earlier upstream history remains in Git.
