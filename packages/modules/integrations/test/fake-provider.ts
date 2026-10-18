// A stand-in OAuth 2.0 provider on a real local socket, so the integrations model can be
// proven end to end without any third party. It speaks the standards the module speaks:
//
//   GET  /authorize        RFC 6749 section 4.1.1: a page with Allow and Cancel; Allow sends
//                          the browser to redirect_uri with code and state, Cancel with
//                          error=access_denied (section 4.1.2.1)
//   POST /token            section 4.1.3 (with RFC 7636's code_verifier, checked against the
//                          S256 challenge) and section 6 (refresh); the client by HTTP Basic;
//                          400 invalid_grant for a spent code or refresh token (section 5.2).
//                          Refresh tokens rotate: the old one dies when a new one is given.
//   POST /revoke           RFC 7009: 200 whatever the token
//   GET  /me               the account, for a bearer access token (RFC 6750): 401 when the
//                          token is unknown, expired or revoked
//   GET  /_stats           the stand-in's own: how many tokens were revoked
//
// Its client, accounts and tokens are made up. A test can also consent without a browser
// (`consent`), make the next answers fail, and read what was asked (never a token).
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { IntegrationProvider, OAuthProvider } from '../src/index.js';

export const STANDIN_CLIENT = {
  clientId: 'standin-client-fixture',
  clientSecret: 'standin-secret-fixture-not-real',
} as const;

export const STANDIN_SCOPES = ['account:read', 'messages:write'] as const;

interface Grant {
  readonly account: string;
  readonly scopes: readonly string[];
  readonly challenge: string | undefined;
  readonly redirectUri: string;
}

interface Account {
  readonly id: string;
  readonly name: string;
}

export interface FakeProvider {
  readonly origin: string;
  /** Every request answered, in order: method and path, never a body or a token. */
  readonly requests: { method: string; path: string }[];
  /** Tokens revoked, by kind: counts only. */
  readonly revoked: { refresh: number; access: number };
  addAccount(account: Account): void;
  /** What the consent page would send back, without a browser: a code for the account. */
  consent(input: {
    readonly account: string;
    readonly codeChallenge?: string | undefined;
    readonly scopes?: readonly string[];
    readonly redirectUri: string;
  }): string;
  /** The account the browser's Allow consents for, and the scopes it grants. */
  consentAs(account: string, scopes?: readonly string[]): void;
  /** Whether a refresh gives a new refresh token (the default) or keeps the one presented. */
  setRotation(rotate: boolean): void;
  /** Makes access tokens expire this many seconds after they are given (default an hour). */
  setAccessLifetime(seconds: number): void;
  /** The next answers of /me: an HTTP status each, in order. */
  failNextIdentity(...statuses: number[]): void;
  /** Kills every token of the account: as if the person revoked access at the provider. */
  revokeAccount(account: string): void;
  /** Whether the token endpoint gave any refresh token that is still alive. */
  liveRefreshTokens(): number;
  close(): Promise<void>;
}

const html = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${String(character.charCodeAt(0))};`);

export async function startFakeProvider(): Promise<FakeProvider> {
  const accounts = new Map<string, Account>();
  const codes = new Map<string, Grant>();
  const refreshTokens = new Map<string, { account: string; scopes: readonly string[] }>();
  const accessTokens = new Map<string, { account: string; expires: number }>();
  const requests: { method: string; path: string }[] = [];
  const revoked = { refresh: 0, access: 0 };
  const identityFailures: number[] = [];
  let lifetime = 3600;
  let rotate = true;
  let consenting: { account: string; scopes: readonly string[] } | undefined;

  const issueCode = (grant: Grant): string => {
    const code = randomBytes(16).toString('hex');
    codes.set(code, grant);
    return code;
  };

  const tokensFor = (account: string, scopes: readonly string[]) => {
    const accessToken = randomBytes(16).toString('hex');
    const refreshToken = randomBytes(16).toString('hex');
    accessTokens.set(accessToken, { account, expires: Date.now() + lifetime * 1000 });
    refreshTokens.set(refreshToken, { account, scopes });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: lifetime,
      refresh_token: refreshToken,
      // A grant of no listed scopes says none: the answer then means what was asked for.
      ...(scopes.length === 0 ? {} : { scope: scopes.join(' ') }),
    };
  };

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const readBody = async (request: IncomingMessage): Promise<URLSearchParams> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };

  const clientOk = (request: IncomingMessage): boolean => {
    const header = request.headers.authorization ?? '';
    const expected = `Basic ${Buffer.from(
      `${encodeURIComponent(STANDIN_CLIENT.clientId)}:${encodeURIComponent(STANDIN_CLIENT.clientSecret)}`,
    ).toString('base64')}`;
    return header === expected;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push({ method: request.method ?? 'GET', path: url.pathname });
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const state = url.searchParams.get('state') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? undefined;
        const asked = (url.searchParams.get('scope') ?? '')
          .split(' ')
          .filter((each) => each !== '');
        if (url.searchParams.get('client_id') !== STANDIN_CLIENT.clientId || redirectUri === '') {
          response.writeHead(400, { 'content-type': 'text/html' });
          response.end(html('Stand-in', '<p>Unknown client.</p>'));
          return;
        }
        const who = consenting ?? { account: [...accounts.keys()][0] ?? '', scopes: asked };
        const back = new URL(redirectUri);
        back.searchParams.set('state', state);
        const denied = new URL(back);
        denied.searchParams.set('error', 'access_denied');
        back.searchParams.set(
          'code',
          issueCode({ account: who.account, scopes: who.scopes, challenge, redirectUri }),
        );
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(
          html(
            'Stand-in: allow access',
            `<h1>Allow access to Stand-in</h1><p>The CRM asks for: ${escapeHtml(asked.join(', '))}.</p>` +
              `<a href="${escapeHtml(back.href)}">Allow</a> <a href="${escapeHtml(denied.href)}">Cancel</a>`,
          ),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const body = await readBody(request);
        if (!clientOk(request)) {
          send(response, 401, { error: 'invalid_client' });
          return;
        }
        if (body.get('grant_type') === 'authorization_code') {
          const grant = codes.get(body.get('code') ?? '');
          codes.delete(body.get('code') ?? '');
          const verifier = body.get('code_verifier');
          const challengeOk =
            grant?.challenge === undefined
              ? verifier === null
              : verifier !== null &&
                createHash('sha256').update(verifier).digest('base64url') === grant.challenge;
          if (
            grant === undefined ||
            !challengeOk ||
            body.get('redirect_uri') !== grant.redirectUri
          ) {
            send(response, 400, { error: 'invalid_grant' });
            return;
          }
          send(response, 200, tokensFor(grant.account, grant.scopes));
          return;
        }
        if (body.get('grant_type') === 'refresh_token') {
          const presented = body.get('refresh_token') ?? '';
          const held = refreshTokens.get(presented);
          if (held === undefined) {
            send(response, 400, { error: 'invalid_grant' });
            return;
          }
          if (!rotate) {
            const { refresh_token: _kept, ...access } = tokensFor(held.account, held.scopes);
            send(response, 200, access);
            return;
          }
          // Rotation: the token presented is spent the moment a new one is given.
          refreshTokens.delete(presented);
          send(response, 200, tokensFor(held.account, held.scopes));
          return;
        }
        send(response, 400, { error: 'unsupported_grant_type' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/revoke') {
        const body = await readBody(request);
        const token = body.get('token') ?? '';
        if (refreshTokens.delete(token)) revoked.refresh += 1;
        if (accessTokens.delete(token)) revoked.access += 1;
        send(response, 200, {});
        return;
      }
      if (request.method === 'GET' && url.pathname === '/me') {
        const failure = identityFailures.shift();
        if (failure !== undefined) {
          send(response, failure, { error: 'scripted' });
          return;
        }
        const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
        const held = accessTokens.get(token);
        const account = held === undefined ? undefined : accounts.get(held.account);
        if (held === undefined || held.expires <= Date.now() || account === undefined) {
          send(response, 401, { error: 'invalid_token' });
          return;
        }
        send(response, 200, { account: { id: account.id, name: account.name } });
        return;
      }
      // For a test in another process: what was revoked, counts only.
      if (request.method === 'GET' && url.pathname === '/_stats') {
        send(response, 200, { revoked, liveRefreshTokens: refreshTokens.size });
        return;
      }
      send(response, 404, { error: 'not_found' });
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(port)}`,
    requests,
    revoked,
    addAccount(account) {
      accounts.set(account.id, account);
    },
    consent(input) {
      return issueCode({
        account: input.account,
        scopes: input.scopes ?? STANDIN_SCOPES,
        challenge: input.codeChallenge,
        redirectUri: input.redirectUri,
      });
    },
    consentAs(account, scopes = STANDIN_SCOPES) {
      consenting = { account, scopes };
    },
    setRotation(value) {
      rotate = value;
    },
    setAccessLifetime(seconds) {
      lifetime = seconds;
    },
    failNextIdentity(...statuses) {
      identityFailures.push(...statuses);
    },
    revokeAccount(account) {
      for (const [token, held] of refreshTokens)
        if (held.account === account) refreshTokens.delete(token);
      for (const [token, held] of accessTokens)
        if (held.account === account) accessTokens.delete(token);
    },
    liveRefreshTokens() {
      return refreshTokens.size;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

/** The stand-in as a provider the install can connect, at the stand-in's address. */
export function standInProvider(
  origin: string,
  overrides: Partial<Omit<OAuthProvider, 'auth'>> = {},
): OAuthProvider {
  return {
    key: 'standin',
    name: 'Stand-in',
    description: 'A local provider that proves the model without a third party.',
    category: 'productivity',
    multipleAccounts: true,
    operatorGuide: null,
    auth: 'oauth2',
    endpoints: {
      authorizeUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/token`,
      revokeUrl: `${origin}/revoke`,
      clientAuth: 'basic',
    },
    client: STANDIN_CLIENT,
    scopes: STANDIN_SCOPES,
    pkce: true,
    identity: { url: `${origin}/me`, id: 'account.id', label: 'account.name' },
    webhook: { header: 'x-standin-signature', encoding: 'hex', prefix: 'sha256=' },
    ...overrides,
  };
}

/** A provider connected with a pasted key: the stand-in's access token works as the key. */
export function standInKeyProvider(origin: string): IntegrationProvider {
  return {
    key: 'standin_key',
    name: 'Stand-in Keys',
    description: 'A local provider connected with a key.',
    category: 'forms',
    multipleAccounts: false,
    operatorGuide: null,
    auth: 'api_key',
    identity: { url: `${origin}/me`, id: 'account.id', label: 'account.name' },
  };
}

/** A key the stand-in accepts: an access token issued for the account, without OAuth. */
export async function standInKey(fake: FakeProvider, account: string): Promise<string> {
  const code = fake.consent({ account, redirectUri: 'https://key.example.test/' });
  const response = await fetch(`${fake.origin}/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${STANDIN_CLIENT.clientId}:${STANDIN_CLIENT.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://key.example.test/',
    }),
  });
  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}
