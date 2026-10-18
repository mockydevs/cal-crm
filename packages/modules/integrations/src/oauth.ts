// OAuth 2.0 as a provider's sign-in needs it: the consent address, the code traded for
// tokens, a refresh, and revoking. The requests and the reading of answers follow RFC 6749
// (sections 4.1.1, 4.1.3, 5.1, 5.2 and 6), PKCE follows RFC 7636 (S256) and revoking RFC 7009.
// Nothing here keeps a token or logs one: it is handed what it needs, and answers with what
// came back.

/** Where a provider's sign-in is, and how it wants the client to say who it is. */
export interface OAuthEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  /** RFC 7009's revocation endpoint, where the provider has one. */
  readonly revokeUrl?: string | undefined;
  /** HTTP Basic (RFC 6749 section 2.3.1, the default) or the id and secret in the body. */
  readonly clientAuth: 'basic' | 'body';
}

/** The operator's registered app, and the address the provider sends the browser back to. */
export interface OAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export type Fetch = typeof fetch;

/** How long a request to a provider may take. */
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  /** When the access token stops working; null when the provider gave no lifetime. */
  readonly expiresAt: string | null;
  /** The scopes granted; null when the answer named none, which means those asked for. */
  readonly scopes: readonly string[] | null;
}

export type TokenOutcome =
  | { readonly ok: true; readonly tokens: TokenSet }
  /** invalid_grant: the code or refresh token is spent or revoked; only signing in again helps. */
  | { readonly ok: false; readonly failure: 'invalid_grant' | 'refused' | 'unavailable' };

/** The consent address: response_type code, the client, where to come back, scopes, state. */
export function authorizationUrl(
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  request: {
    readonly state: string;
    readonly scopes: readonly string[];
    readonly codeChallenge?: string;
  },
): string {
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  if (request.scopes.length > 0) url.searchParams.set('scope', request.scopes.join(' '));
  url.searchParams.set('state', request.state);
  if (request.codeChallenge !== undefined) {
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.href;
}

function clientRequest(
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  fields: Readonly<Record<string, string>>,
): { headers: Record<string, string>; body: URLSearchParams } {
  const body = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (endpoints.clientAuth === 'basic') {
    // RFC 6749 section 2.3.1: each part form-encoded, then joined with a colon.
    const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
    headers['authorization'] = `Basic ${Buffer.from(pair).toString('base64')}`;
  } else {
    body.set('client_id', client.clientId);
    body.set('client_secret', client.clientSecret);
  }
  return { headers, body };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a token endpoint's answer. A 200 with an access token is a token set (section 5.1);
 * a 400 or 401 with invalid_grant means the grant is gone for good (section 5.2); any other
 * error answer is a refusal; a 429, a 5xx or something unreadable is the provider not
 * answering now.
 */
export function readTokenAnswer(status: number, body: unknown, now: Date): TokenOutcome {
  if (status === 200 && isRecord(body) && typeof body['access_token'] === 'string') {
    const expiresIn = body['expires_in'];
    const seconds =
      typeof expiresIn === 'number'
        ? expiresIn
        : typeof expiresIn === 'string'
          ? Number.parseInt(expiresIn, 10)
          : Number.NaN;
    const scope = body['scope'];
    const refresh = body['refresh_token'];
    return {
      ok: true,
      tokens: {
        accessToken: body['access_token'],
        refreshToken: typeof refresh === 'string' && refresh !== '' ? refresh : null,
        expiresAt:
          Number.isFinite(seconds) && seconds > 0
            ? new Date(now.getTime() + seconds * 1000).toISOString()
            : null,
        scopes:
          typeof scope === 'string' ? scope.split(/[\s,]+/).filter((each) => each !== '') : null,
      },
    };
  }
  if ((status === 400 || status === 401) && isRecord(body)) {
    return { ok: false, failure: body['error'] === 'invalid_grant' ? 'invalid_grant' : 'refused' };
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { ok: false, failure: 'refused' };
  return { ok: false, failure: 'unavailable' };
}

async function postForm(
  fetcher: Fetch,
  url: string,
  request: { headers: Record<string, string>; body: URLSearchParams },
): Promise<{ status: number; body: unknown } | undefined> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } catch {
    // Unreachable, timed out, or redirected: the provider is not answering now.
    return undefined;
  }
}

/** Trades the code from the callback for tokens (section 4.1.3, with RFC 7636's verifier). */
export async function exchangeCode(
  fetcher: Fetch,
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  code: string,
  codeVerifier: string | undefined,
  now: () => Date = () => new Date(),
): Promise<TokenOutcome> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: client.redirectUri,
  };
  if (codeVerifier !== undefined) fields['code_verifier'] = codeVerifier;
  const answer = await postForm(
    fetcher,
    endpoints.tokenUrl,
    clientRequest(endpoints, client, fields),
  );
  if (answer === undefined) return { ok: false, failure: 'unavailable' };
  return readTokenAnswer(answer.status, answer.body, now());
}

/** A new access token for a refresh token (section 6). Some providers rotate the refresh token. */
export async function refreshTokens(
  fetcher: Fetch,
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  refreshToken: string,
  now: () => Date = () => new Date(),
): Promise<TokenOutcome> {
  const answer = await postForm(
    fetcher,
    endpoints.tokenUrl,
    clientRequest(endpoints, client, { grant_type: 'refresh_token', refresh_token: refreshToken }),
  );
  if (answer === undefined) return { ok: false, failure: 'unavailable' };
  return readTokenAnswer(answer.status, answer.body, now());
}

/**
 * Revokes a token (RFC 7009 section 2.1). A 200 is revoked, and so is an answer saying the
 * token is unknown or already invalid (section 2.2: the server answers 200 for those too,
 * and some answer 400 invalid_token). A provider with no endpoint has nothing to revoke.
 */
export async function revokeToken(
  fetcher: Fetch,
  endpoints: OAuthEndpoints,
  client: OAuthClient,
  token: string,
  hint: 'refresh_token' | 'access_token',
): Promise<'revoked' | 'unsupported' | 'unavailable'> {
  if (endpoints.revokeUrl === undefined) return 'unsupported';
  const answer = await postForm(
    fetcher,
    endpoints.revokeUrl,
    clientRequest(endpoints, client, { token, token_type_hint: hint }),
  );
  if (answer === undefined || answer.status === 429 || answer.status >= 500) return 'unavailable';
  return 'revoked';
}

/** What an account read with a token says, or why it could not be read. */
export type IdentityOutcome =
  | { readonly ok: true; readonly body: unknown }
  | {
      readonly ok: false;
      /** 401: the token is not accepted; 403: it lacks a permission; otherwise not now. */
      readonly failure: 'unauthorized' | 'forbidden' | 'rate_limited' | 'unavailable';
    };

/** Reads the account a token belongs to: a GET with the token as a bearer token (RFC 6750). */
export async function readIdentity(
  fetcher: Fetch,
  url: string,
  token: string,
): Promise<IdentityOutcome> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
  if (response.status === 401) return { ok: false, failure: 'unauthorized' };
  if (response.status === 403) return { ok: false, failure: 'forbidden' };
  if (response.status === 429) return { ok: false, failure: 'rate_limited' };
  if (!response.ok) return { ok: false, failure: 'unavailable' };
  try {
    return { ok: true, body: await response.json() };
  } catch {
    return { ok: false, failure: 'unavailable' };
  }
}
