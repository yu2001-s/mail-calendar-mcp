// Deploy the connector to your Cloudflare account and load its secrets from
// this Mac's existing configuration: config.json, the Keychain passwords it
// references, and preferences.json. Run `npx wrangler login` first.
//
//   node scripts/setup-worker.mjs            deploy and set all secrets
//   node scripts/setup-worker.mjs --secrets  update secrets only
//
// The first run generates an owner password and prints it once; later runs
// keep it. Set ICLOUD_MAIL_OWNER_PASSWORD to choose or rotate it. Save it: it
// approves each new connection.
//
// For Gmail and Google Calendar, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
// (see docs/GOOGLE.md). The key that encrypts stored Google tokens,
// CONNECTOR_SECRET_KEY, is generated once and never rotated by this script:
// a new key makes every linked Google account unreadable.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(root, "node_modules/.bin/wrangler");
const configPath =
  process.env.APPLE_MAIL_MCP_CONFIG_FILE ||
  join(homedir(), "Library/Application Support/apple-mail-mcp/config.json");
const dataDir =
  process.env.ICLOUD_MAIL_DATA_DIR || join(homedir(), ".codex/integrations/icloud-mail");
// Non-personal settings committed in wrangler.jsonc; a secret may not reuse their names.
const committedVars = new Set([
  "APPLE_MAIL_MCP_IMAP_HOST",
  "APPLE_MAIL_MCP_IMAP_PORT",
  "APPLE_MAIL_MCP_SMTP_HOST",
  "APPLE_MAIL_MCP_SMTP_PORT",
  "APPLE_MAIL_MCP_SMTP_SECURE",
]);

function keychain(service, account) {
  for (const kind of ["find-internet-password", "find-generic-password"]) {
    try {
      const value = execFileSync("security", [kind, "-s", service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (value) return value;
    } catch {
      // Try the next item kind.
    }
  }
  return null;
}

function password(config, kind) {
  const prefix = `APPLE_MAIL_MCP_${kind}_`;
  const direct = process.env[`${prefix}PASSWORD`] || config[`${prefix}PASSWORD`];
  if (direct) return direct;
  const service = config[`${prefix}KEYCHAIN_SERVICE`];
  const account = config[`${prefix}KEYCHAIN_ACCOUNT`] || config[`${prefix}USER`];
  const found = service && keychain(service, account);
  if (!found) throw new Error(`No ${kind} password: set ${prefix}PASSWORD or its Keychain item.`);
  return found;
}

function run(args, input) {
  const result = spawnSync(wrangler, args, {
    cwd: root,
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed.`);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const preferences = JSON.parse(readFileSync(join(dataDir, "preferences.json"), "utf8"));
const secrets = {};
for (const [key, value] of Object.entries(config)) {
  if (typeof value !== "string" || committedVars.has(key)) continue;
  if (/KEYCHAIN_(SERVICE|ACCOUNT)$|_PASSWORD$/.test(key)) continue;
  secrets[key] = value;
}
secrets.APPLE_MAIL_MCP_IMAP_PASSWORD = password(config, "IMAP");
secrets.APPLE_MAIL_MCP_SMTP_PASSWORD = password(config, "SMTP");
secrets.ICLOUD_MAIL_PREFERENCES = JSON.stringify(preferences);
const chosen = process.env.ICLOUD_MAIL_OWNER_PASSWORD;
if (chosen !== undefined && chosen.length < 16) {
  throw new Error("ICLOUD_MAIL_OWNER_PASSWORD must be at least 16 characters.");
}

/**
 * Names of the secrets the deployed Worker already has. Fails rather than
 * guessing: a wrongly empty list would replace the owner password and the
 * token key, and a new token key makes every linked Google account unreadable.
 */
function existingSecrets() {
  const result = spawnSync(wrangler, ["secret", "list", "--format", "json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    return new Set(JSON.parse(result.stdout).map((secret) => secret.name));
  } catch {
    throw new Error(
      `Could not list the Worker's secrets; deploy it first or retry.\n${result.stderr ?? ""}`
    );
  }
}

const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;
if (Boolean(googleId) !== Boolean(googleSecret)) {
  throw new Error("Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither.");
}
if (googleId) {
  secrets.GOOGLE_CLIENT_ID = googleId;
  secrets.GOOGLE_CLIENT_SECRET = googleSecret;
}

/**
 * The R2 bucket named in wrangler.jsonc for attachment uploads, with a rule
 * that deletes uploads still there after a day (attached ones are deleted at once).
 */
function ensureUploadsBucket() {
  const bucket = /"bucket_name":\s*"([^"]+)"/.exec(
    readFileSync(join(root, "wrangler.jsonc"), "utf8")
  )?.[1];
  if (!bucket) throw new Error("wrangler.jsonc names no R2 bucket for uploads.");
  const info = spawnSync(wrangler, ["r2", "bucket", "info", bucket], {
    cwd: root,
    stdio: "ignore",
  });
  if (info.status !== 0) run(["r2", "bucket", "create", bucket]);
  const dir = mkdtempSync(join(tmpdir(), "icloud-mail-lifecycle-"));
  const file = join(dir, "lifecycle.json");
  writeFileSync(
    file,
    JSON.stringify({
      rules: [
        {
          id: "delete-uploads-after-a-day",
          enabled: true,
          conditions: { prefix: "uploads/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 24 * 60 * 60 } },
        },
        {
          id: "delete-downloads-after-a-day",
          enabled: true,
          conditions: { prefix: "downloads/" },
          deleteObjectsTransition: { condition: { type: "Age", maxAge: 24 * 60 * 60 } },
        },
      ],
    })
  );
  try {
    run(["r2", "bucket", "lifecycle", "set", bucket, "--file", file, "--force"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (!process.argv.includes("--secrets")) {
  ensureUploadsBucket();
  run(["deploy"]);
}
const existing = existingSecrets();
let generated = false;
if (chosen) secrets.ICLOUD_MAIL_OWNER_PASSWORD = chosen;
else if (!existing.has("ICLOUD_MAIL_OWNER_PASSWORD")) {
  secrets.ICLOUD_MAIL_OWNER_PASSWORD = randomBytes(18).toString("base64url");
  generated = true;
}
if (!existing.has("CONNECTOR_SECRET_KEY")) {
  secrets.CONNECTOR_SECRET_KEY = randomBytes(32).toString("base64url");
}
run(["secret", "bulk"], JSON.stringify(secrets));
console.log(`\nUploaded ${Object.keys(secrets).length} secrets.`);
if (generated) {
  console.log(
    `\nOwner password (shown once; save it in your password manager):\n\n  ${secrets.ICLOUD_MAIL_OWNER_PASSWORD}\n`
  );
}
console.log(
  "Add <worker URL>/mcp as a custom connector in Claude and ChatGPT; see docs/WORKER.md."
);
if (googleId || existing.has("GOOGLE_CLIENT_ID")) {
  console.log("Link Google accounts at <worker URL>/accounts; see docs/GOOGLE.md.");
}
