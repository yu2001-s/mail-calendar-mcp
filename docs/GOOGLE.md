# Gmail and Google Calendar

The Worker can serve any number of Google accounts next to iCloud mail, all
through the one connector URL you already added to Claude and ChatGPT. Each
account is linked once in a browser; after that, Claude can search, read,
draft, send and label its mail and manage its calendars.

```text
Claude / ChatGPT ──▶ Worker /mcp ──▶ iCloud IMAP / SMTP
                          │
                          ├──▶ Gmail API ────────┐ one OAuth grant
                          └──▶ Calendar API ─────┘ per Google account
       browser ──▶ Worker /accounts ──▶ Google sign-in (owner password first)
```

Google needs an OAuth client to issue those grants. You create your own, so
your mail never passes through anyone else's app.

## 1. Create the Google OAuth client

In the [Google Cloud console](https://console.cloud.google.com/), signed in
with any Google account:

1. **Create a project**, for example "Mail connector".
2. **Enable the APIs**: open
   [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   and
   [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   and choose **Enable** on each.
3. **Google Auth Platform → Branding**: give the app a name and your support
   email. Google only lets an app be published once it has a home page and a
   privacy policy on an authorized domain. The Worker serves both: use
   `https://icloud-mail.<your-subdomain>.workers.dev/` and `…/privacy`, and add
   `<your-subdomain>.workers.dev` under *Authorized domains*.
4. **Audience**: choose **External**, then **Publish app** so the status reads
   **In production**. This step matters: while an app is in *Testing*, Google
   expires its refresh tokens after 7 days and every account would need
   linking again each week. Google does not need to verify the app for
   your own use. It shows an "unverified app" warning instead and limits the
   app to 100 users.
5. **Data Access → Add or remove scopes**: add
   `https://www.googleapis.com/auth/gmail.modify` and
   `https://www.googleapis.com/auth/calendar`.
6. **Clients → Create client → Web application**. Under *Authorized redirect
   URIs* add

   ```text
   https://icloud-mail.<your-subdomain>.workers.dev/accounts/google/callback
   ```

   (and the same path on any custom domain you set as `ICLOUD_MAIL_PUBLIC_URL`).
   Copy the **Client ID** and **Client secret**.

## 2. Give them to the Worker

From the repository:

```sh
GOOGLE_CLIENT_ID=<client id> GOOGLE_CLIENT_SECRET=<client secret> node scripts/setup-worker.mjs
```

This deploys the Worker and uploads the client as Worker secrets. It also
generates `CONNECTOR_SECRET_KEY`, the key that encrypts Google refresh tokens in
KV. The key is created once and kept on later runs. Deleting or replacing it
makes every linked account unreadable, and each one then has to be linked again.

## 3. Link accounts

Open `https://icloud-mail.<your-subdomain>.workers.dev/accounts`, enter the
owner password, and choose **Link a Google account**. On Google's screens:

1. Pick the account.
2. "Google hasn't verified this app": choose **Advanced**, then **Go to …
   (unsafe)**. It is your own client from step 1.
3. Tick **every** checkbox (Gmail and Calendar). If one is left unticked, that
   account works without those tools until it is linked again.

Repeat for each account. The page lists linked accounts with **Remove**, which
also revokes the grant at Google, and a **nickname** field: give an account a
short name such as `work` or `personal` and Claude accepts it anywhere it takes
an account ("search my work mail"). You can also ask Claude to set one; it uses
`set_account_nickname`. Changes reach Claude within about a minute.
You don't need to reconnect anything in Claude. In ChatGPT, open the connector's
**Manage** page and choose **Refresh tools** once after this upgrade, because
it keeps its own copy of the tool list.

### Google Workspace accounts

A work or school administrator may block apps that Google has not verified. If
linking fails with "access blocked" or "admin_policy_enforced", ask the
administrator to trust your client ID: Admin console → Security → Access and
data control → API controls → Manage third-party app access → Configure new
app → OAuth app name or client ID → **Trusted**.

## Tools

Gmail is served by the `mail_*` tools, which work the same for iCloud and every
Gmail account (see the [README](../README.md#mail-tools)). Searching mail,
listing events and finding free time cover **every** linked account unless
told otherwise. The calendar tools take `account`, the Google address or its
nickname; it may be left out when only one Google account is linked. Results
always say which account they came from, and IDs only work with that account.

| Calendar | |
| --- | --- |
| `calendar_list_calendars` | every account's calendars |
| `calendar_list_events` | merged across accounts and shown calendars, single occurrences |
| `calendar_get_event` | attendees, responses, Meet link |
| `calendar_create_event`, `calendar_update_event` | all-day or timed, guests, recurrence, Meet, reminders |
| `calendar_delete_event` | |
| `calendar_respond_to_event` | accept, decline, tentative |
| `calendar_find_free_time` | free windows across every linked account |

`list_accounts` shows the iCloud account and each Google account with its
nickname and the services it granted; `set_account_nickname` names an account.

For Gmail accounts, the mail tools:

- keep a draft's attachments unless `attachmentNamesToRemove` names them, and
  add `attachmentsToAdd`;
- take uploads from `create_attachment_upload`, attached as `{uploadId}`, so
  local files need not pass through the conversation (see
  [WORKER.md](WORKER.md#attachments));
- reply from the address the original was sent to when it is one of your
  verified Gmail "Send mail as" addresses;
- use a draft's current message ID as its revision, so `mail_send` never
  sends a draft that changed in Gmail after it was read;
- cap bodies at 20,000 characters by default (`maxBodyChars`), with
  `bodyTruncated` when a cap applied.

## Security

- The connector asks Google for `gmail.modify` and `calendar`. `gmail.modify`
  covers reading, drafting, sending, labels and Trash, but never permanent
  deletion.
- Refresh tokens are stored in the Worker's KV encrypted with AES-256-GCM
  under `CONNECTOR_SECRET_KEY`, and each one is bound to its own account
  address. Access tokens live only in the Durable Object's memory.
- `/accounts` needs the owner password, which shares its 10-tries-per-hour
  lockout with the connection approval page. It then keeps a 30-minute session
  cookie (HttpOnly, Secure, SameSite=Lax) with a CSRF token on every form.
  Google's callback only completes in the browser session that started it,
  and only once: Google sign-in uses PKCE and a single-use state.
- Google ends a grant when the account's password changes, when the grant
  goes unused for six months, or when you remove the app at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
  Tools then answer with a message to link the account again at `/accounts`.
