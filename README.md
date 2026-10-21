# Mail & Calendar

An MCP connector that runs as a Cloudflare Worker. It reads and searches iCloud
mail directly over IMAP/SMTP, creates synchronized drafts, resolves threaded
replies, and applies saved sender signatures. It does not launch Mail.app or
use AppleScript.

The same connector serves any number of Gmail and Google Calendar accounts:
Gmail tools that match Google's own Gmail connector, calendar tools that work
across every account, and one place to link them.

Added once to a Claude or ChatGPT account, it works in every app and device
signed in to that account, with nothing installed per machine. Clients that
can run shell commands, such as Claude Code, can also attach local files
through one-time upload links. Agents can also register webhooks that hear
about new iCloud mail (`mail_listen_set`).

| Guide | |
| --- | --- |
| [docs/WORKER.md](docs/WORKER.md) | Deploy, connect clients, attachments, new-mail webhooks, security |
| [docs/GOOGLE.md](docs/GOOGLE.md) | Link Gmail and Google Calendar accounts |

## Data

Account passwords and preferences are Worker secrets, uploaded by
`scripts/setup-worker.mjs` from this Mac's iCloud configuration (see
[docs/WORKER.md](docs/WORKER.md#deploy)). The primary address, sending
addresses, signatures and display names live in the Worker's KV, seeded on
first use and edited from chat. iCloud has no API for its alias settings, so
`list_sending_addresses` adds addresses found in Sent and suggests
custom-domain recipients from the inbox.

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
