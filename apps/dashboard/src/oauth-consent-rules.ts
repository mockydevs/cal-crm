// The consent page's address, read as the app wrote it. The router reads search
// parameters as JSON, so a state of 123 or "x" would come back changed; the app must get
// its state back exactly, so these are read raw.
import type { OAuthAuthorizationRequest } from '@repo/contracts';

/** OAuth's parameter names (RFC 6749 section 4.1.1, RFC 7636 section 4.3), and the API's. */
const names = {
  client_id: 'clientId',
  redirect_uri: 'redirectUri',
  response_type: 'responseType',
  scope: 'scope',
  state: 'state',
  code_challenge: 'codeChallenge',
  code_challenge_method: 'codeChallengeMethod',
} as const satisfies Readonly<Record<string, keyof OAuthAuthorizationRequest>>;

/** The request in an address's query, by the API's names; a parameter left out stays out. */
export function authorizationRequestOf(search: string): OAuthAuthorizationRequest {
  const params = new URLSearchParams(search);
  const request: Partial<Record<keyof OAuthAuthorizationRequest, string>> = {};
  for (const [name, key] of Object.entries(names)) {
    const value = params.get(name);
    if (value !== null) request[key] = value;
  }
  return request;
}
