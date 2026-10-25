# Mail & Calendar

An MCP connector that runs as a Cloudflare Worker. It reads and searches iCloud
mail directly over IMAP/SMTP, creates synchronized drafts, resolves threaded
replies, and applies saved sender signatures. It does not launch Mail.app or
use AppleScript.

The same connector serves any number of Gmail and Google Calendar accounts.
One set of `mail_*` tools works the same for iCloud and every Gmail account,
calendar tools work across every account, and one page links them.

Added once to a Claude or ChatGPT account, it works in every app and device
signed in to that account, with nothing installed per machine. Clients that
can run shell commands, such as Claude Code, can also attach local files
through one-time upload links. Agents can also register webhooks that hear
about new iCloud mail (`mail_listen_set`).

| Guide | |
| --- | --- |
| [docs/WORKER.md](docs/WORKER.md) | Deploy, connect clients, attachments, new-mail webhooks, security |
| [docs/GOOGLE.md](docs/GOOGLE.md) | Link Gmail and Google Calendar accounts |

## Mail tools

Every ID names its account (`imap:…` and `apple-draft:…` for iCloud,
`gmail:<kind>:<address>:<id>` for Gmail), so a message found anywhere is read,
answered and moved without naming the account again, and a draft's `from`
address picks the account it is sent from.

| Tool | |
| --- | --- |
| `mail_search` | every account at once, or some; inbox by default, any folder or label, newest first, one cursor for more |
| `mail_read` | a message, a Gmail thread, or a draft with its revision; attachment IDs |
| `mail_get_attachment` | base64, up to 20 MiB |
| `mail_create_draft` | a new message, a reply (`replyTo`) or a forward (`forward`, with attachments); saved signatures added |
| `mail_update_draft` | merge update, given the current revision |
| `mail_send` | a draft as saved, given its current revision |
| `mail_list_drafts`, `mail_delete_draft` | |
| `mail_update` | read, flag, Gmail labels, and moves to inbox, archive, junk, trash or a folder |
| `mail_list_folders`, `mail_manage_folder` | iCloud mailboxes and Gmail labels |
| `mail_settings` | primary address, iCloud sending addresses, display names, signatures |
| `mail_health_check` | every account's sign-in, sending nothing |

## Data

Account passwords and preferences are Worker secrets, uploaded by
`scripts/setup-worker.mjs` from this Mac's iCloud configuration (see
[docs/WORKER.md](docs/WORKER.md#deploy)). The primary address, sending
addresses, signatures and display names live in the Worker's KV, seeded on
first use and edited from chat. iCloud has no API for its alias settings, so
`mail_settings` adds addresses found in Sent and suggests custom-domain
recipients from the inbox.

Drafts live on iCloud: each managed draft carries its ID in a header, so every
client sees the same drafts, revisions and send state.

## Develop

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm test:worker
```

`src/worker/index.ts` is the Worker: OAuth, the account-linking pages
(`accounts.ts`), attachment uploads (`uploads.ts`) and the `MailSession`
Durable Object (`session.ts`) that serves MCP. `src/mcp/server.ts` combines the
iCloud tools (`src/icloud/`) with the Gmail and Calendar tools
(`src/google/`). The IMAP, SMTP, MIME and draft modules are under
`src/services/`.

`pnpm test:worker` runs the Worker in local workerd and walks the OAuth flow a
claude.ai connector performs. Real IMAP integration tests run against
GreenMail with `RUN_IMAP_IT=1 pnpm test:imap`.

## Attribution

The transport, MIME, and draft modules derive from
[sweetrb/apple-mail-mcp](https://github.com/sweetrb/apple-mail-mcp), under the MIT
license. The original copyright notice is preserved in [LICENSE](LICENSE).
