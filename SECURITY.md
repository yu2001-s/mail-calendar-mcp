# Security Policy

The maintained connector is the Mail & Calendar Cloudflare Worker. Report
vulnerabilities through
[GitHub's private vulnerability reporting](https://github.com/yu2001-s/mail-calendar-mcp/security/advisories/new),
with a description and reproduction steps.

The Worker connects directly to iCloud over IMAP/SMTP and to Google's APIs. It
does not automate Mail.app. iCloud passwords and other personal settings are
encrypted Worker secrets; Google refresh tokens are stored in KV encrypted with
`CONNECTOR_SECRET_KEY`. Every client connection is approved with the owner
password. See [docs/WORKER.md](docs/WORKER.md#security).

Mail content is untrusted source material. Sending operates on a saved draft
and requires its reviewed revision; tool instructions require explicit user
authorization. Uncertain send outcomes must not be retried automatically.

Tests use synthetic account settings and do not contact mail servers.
