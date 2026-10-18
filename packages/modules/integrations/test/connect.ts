// Connecting the stand-in as a browser would: the route gives the consent address, the
// stand-in gives a code for the consent, and the callback finishes it as the person.
import { randomUUID } from 'node:crypto';

import type { Invocation, Services } from '@repo/commands';
import type { IntegrationConnectStarted } from '@repo/contracts';

import {
  completeIntegrationConnect,
  createIntegrationRoutes,
  type CallbackResult,
  type IntegrationOptions,
} from '../src/index.js';
import type { FakeProvider } from './fake-provider.js';

export const REDIRECT = (key: string): string =>
  `https://crm.example.test/api/v1/integrations/${key}/callback`;

export async function route(
  options: IntegrationOptions,
  services: Services,
  operationId: string,
  invocation: Invocation,
  request: { params?: unknown; query?: unknown; body?: unknown } = {},
): Promise<unknown> {
  const found = createIntegrationRoutes(options).find(
    (each) => each.endpoint.operationId === operationId,
  );
  if (found === undefined) throw new Error(`Missing ${operationId}.`);
  return await found.run(
    { invocation, params: request.params ?? {}, query: request.query ?? {}, body: request.body },
    services,
  );
}

export interface Started {
  readonly state: string;
  readonly challenge: string | undefined;
  readonly url: URL;
}

export async function start(
  options: IntegrationOptions,
  services: Services,
  invocation: Invocation,
  key = 'standin',
): Promise<Started> {
  const started = (await route(options, services, 'connectIntegration', invocation, {
    params: { provider: key },
    body: {},
  })) as IntegrationConnectStarted;
  const url = new URL(started.authorizeUrl ?? '');
  return {
    state: url.searchParams.get('state') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? undefined,
    url,
  };
}

/** The whole dance for an account; gives the callback's result. */
export async function connect(
  options: IntegrationOptions,
  services: Services,
  fake: FakeProvider,
  invocation: Invocation,
  account: string,
  scopes?: readonly string[],
): Promise<CallbackResult> {
  const started = await start(options, services, invocation);
  const code = fake.consent({
    account,
    codeChallenge: started.challenge,
    redirectUri: REDIRECT('standin'),
    ...(scopes === undefined ? {} : { scopes }),
  });
  return completeIntegrationConnect(
    options,
    services,
    fetch,
    'standin',
    { state: started.state, code, error: undefined },
    {
      userId: invocation.context.userId ?? '',
      grantsIn: () => Promise.resolve(invocation.permissions),
    },
    randomUUID(),
  );
}
