/**
 * Cloudflare Worker deployment of the connector: iCloud mail, plus Gmail and
 * Google Calendar for every Google account linked at /accounts.
 *
 * The Worker is its own OAuth 2.1 authorization server (dynamic registration
 * for Claude, Client ID Metadata Documents for ChatGPT) and serves MCP over
 * stateless Streamable HTTP at /mcp. After OAuth, requests are handled by one
 * Durable Object that keeps the IMAP connection open between tool calls. The
 * iCloud Drafts mailbox and its send markers hold all durable draft state, so
 * only OAuth data, settings and sealed Google tokens need Worker storage.
 */
import {
  AuthorizationError,
  CimdFetchError,
  OAuthProvider,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { isAllowedRedirect, parseRedirectList } from "../icloud/redirects.js";
import { handleAccounts } from "./accounts.js";
import { consentPage, messagePage, retryPage } from "./consent.js";
import { CONNECTOR_TITLE } from "../mcp/identity.js";
import { homePage, privacyPage } from "./pages.js";
import { handleUpload, type R2 } from "./uploads.js";
import {
  consentFormAction,
  failures,
  MAX_FAILURES,
  passwordMatches,
  recordFailure,
  withPageHeaders,
  type KV,
} from "./owner.js";

export { MailSession } from "./session.js";

const MAIL_SCOPE = "mail";

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(
    id: unknown,
    options?: { locationHint?: string }
  ): { fetch(request: Request): Promise<Response> };
}

export interface Env {
  OAUTH_KV: KV;
  OAUTH_PROVIDER: OAuthHelpers;
  /** The MailSession Durable Object that serves MCP. */
  MAIL_SESSION: DurableObjectNamespace;
  /** Approves each OAuth connection. Secret, at least 16 characters. */
  ICLOUD_MAIL_OWNER_PASSWORD?: string;
  /** preferences.json content: primary address and signatures. Secret. */
  ICLOUD_MAIL_PREFERENCES?: string;
  /** Optional canonical origin when the Worker answers on several hostnames. */
  ICLOUD_MAIL_PUBLIC_URL?: string;
  ICLOUD_MAIL_OAUTH_REDIRECT_URIS?: string;
  /** Google OAuth client for linking Gmail and Calendar accounts. See docs/GOOGLE.md. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Encrypts stored Google refresh tokens and signs upload links. Secret, at least 32 characters. */
  CONNECTOR_SECRET_KEY?: string;
  /** Files uploaded for attachments; see src/worker/uploads.ts. */
  UPLOADS?: R2;
  [key: string]: unknown;
}

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
        { status: 405, headers: { Allow: "POST" } }
      );
    }
    if (!env.ICLOUD_MAIL_PREFERENCES && !env.GOOGLE_CLIENT_ID) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Configure iCloud (ICLOUD_MAIL_PREFERENCES) or Google (GOOGLE_CLIENT_ID).",
          },
          id: null,
        },
        { status: 500 }
      );
    }
    // One instance for all accounts, created near iCloud's IMAP servers.
    const session = env.MAIL_SESSION.get(env.MAIL_SESSION.idFromName("icloud"), {
      locationHint: "enam",
    });
    return session.fetch(request);
  },
};

async function authorize(request: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const ownerPassword = env.ICLOUD_MAIL_OWNER_PASSWORD ?? "";
  if (ownerPassword.length < 16) {
    return messagePage("ICLOUD_MAIL_OWNER_PASSWORD must be set to at least 16 characters.", 500);
  }
  const extra = parseRedirectList(env.ICLOUD_MAIL_OAUTH_REDIRECT_URIS);
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      if (!isAllowedRedirect(authRequest.redirectUri, extra)) {
        return messagePage("This app's sign-in callback is not allowed for this server.", 403);
      }
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return new Response(consentPage(details, consent.handle), {
        headers: withPageHeaders(consent.headers, consentFormAction(extra)),
      });
    }
    if (request.method !== "POST") return messagePage("Method not allowed.", 405);
    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if ((await failures(env.OAUTH_KV)) >= MAX_FAILURES) {
      return messagePage("Too many failed attempts. Try again in an hour.", 429);
    }
    if (!(await passwordMatches(String(form.get("password") ?? ""), ownerPassword))) {
      await recordFailure(env.OAUTH_KV);
      return new Response(retryPage(handle, "Incorrect owner password."), {
        status: 401,
        headers: withPageHeaders(new Headers(), consentFormAction(extra)),
      });
    }
    const approved = await oauth.approveConsent(request, handle, { scope: [MAIL_SCOPE] });
    if (!isAllowedRedirect(approved.request.redirectUri, extra)) {
      return messagePage("This app's sign-in callback is not allowed for this server.", 403);
    }
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: "owner",
      metadata: {},
      scope: [MAIL_SCOPE],
      props: {},
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      return messagePage(
        `${error.description}. Return to Claude or ChatGPT and connect again; an approval page is valid for 10 minutes.`
      );
    }
    if (error instanceof CimdFetchError) return messagePage("This app could not be verified.");
    throw error;
  }
}

const appHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return authorize(request, env);
    if (pathname === "/accounts" || pathname.startsWith("/accounts/")) {
      return handleAccounts(request, env);
    }
    if (pathname.startsWith("/uploads/")) return handleUpload(request, env);
    if (pathname === "/healthz") return Response.json({ ok: true });
    if (pathname === "/") return homePage();
    if (pathname === "/privacy") return privacyPage();
    return new Response("Not found", { status: 404 });
  },
};

const GRANT_IDLE_TTL = 90 * 24 * 60 * 60;

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, extraRedirects: string[]): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpHandler as never,
      defaultHandler: appHandler as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [MAIL_SCOPE],
      requiredScopes: [MAIL_SCOPE],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: CONNECTOR_TITLE,
      },
      clientIdMetadataDocumentEnabled: true,
      accessTokenTTL: 60 * 60,
      // A grant lasts 90 days from its last refresh, so a connector in use never
      // needs approving again. A fixed lifetime signed every client out on schedule.
      refreshTokenTTL: GRANT_IDLE_TTL,
      refreshTokenIdleTTL: GRANT_IDLE_TTL,
      clientRegistrationCallback: ({ clientMetadata }) => {
        const uris = Array.isArray(clientMetadata.redirect_uris)
          ? clientMetadata.redirect_uris
          : [];
        if (
          !uris.some((uri) => typeof uri === "string" && isAllowedRedirect(uri, extraRedirects))
        ) {
          return { description: "No redirect URI is allowed for this server." };
        }
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: WaitUntil): Promise<Response> {
    const origin = new URL(env.ICLOUD_MAIL_PUBLIC_URL || request.url).origin;
    return providerFor(origin, parseRedirectList(env.ICLOUD_MAIL_OAUTH_REDIRECT_URIS)).fetch(
      request as never,
      env,
      ctx as never
    );
  },
};
