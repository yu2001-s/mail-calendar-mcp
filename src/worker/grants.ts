/**
 * Ties new-mail webhooks to the OAuth grants that set them. The webhooks run
 * from a Durable Object alarm with no request or token, so without this a
 * revoked client's webhook would go on receiving mail. The Worker passes the
 * object the grant behind each request, and the object can list the grants
 * that still exist.
 */
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";

/** The connector has one user, whose grants are all under this ID. */
export const OWNER_USER_ID = "owner";

const GRANT_HEADER = "x-mail-oauth-grant";

/**
 * tokenExchangeCallback: the library tells the API handler a token's props but
 * not its grant, so each access token carries the grant ID. A grant approved
 * before this existed gets it at its next refresh, within the hour.
 */
export function stampGrantId({ grantId, props }: { grantId: string; props: object }) {
  return { accessTokenProps: { ...props, grantId } };
}

/**
 * The request to pass to the Durable Object, naming the grant of its validated
 * token. Only the Worker can reach the object, and this removes any value the
 * client sent, so the object can trust the header.
 */
export function withGrantHeader(request: Request, grantId?: string): Request {
  const forwarded = new Request(request);
  forwarded.headers.delete(GRANT_HEADER);
  if (grantId) forwarded.headers.set(GRANT_HEADER, grantId);
  return forwarded;
}

export function grantFromHeader(request: Request): string | undefined {
  return request.headers.get(GRANT_HEADER) ?? undefined;
}

/** The IDs of the owner's grants that exist. Rejects if they cannot be read. */
export async function liveGrantIds(env: { OAUTH_KV: unknown }): Promise<string[]> {
  // listUserGrants reads only OAUTH_KV, but the options must still be valid.
  const unused = { fetch: () => new Response(null, { status: 404 }) };
  const oauth = getOAuthApi<typeof env>(
    {
      apiRoute: "/mcp",
      apiHandler: unused as never,
      defaultHandler: unused as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      resourceMetadata: { resource: "https://connector.invalid/mcp" },
    },
    env
  );
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await oauth.listUserGrants(OWNER_USER_ID, cursor ? { cursor } : undefined);
    ids.push(...page.items.map((grant) => grant.id));
    cursor = page.cursor;
  } while (cursor);
  return ids;
}
