import { expect, it } from 'vitest';

import { endpoints } from './api.js';

const operation = (id: string) => endpoints.find((endpoint) => endpoint.operationId === id);

it('discovers businesses through a bounded native read without a required account ID', () => {
  const endpoint = operation('listBusinesses');
  expect(endpoint).toMatchObject({
    method: 'get',
    path: '/integration/businesses',
    group: 'Businesses',
  });
  expect(endpoint?.query?.parse({})).toEqual({ limit: 50 });
  expect(endpoint?.query?.safeParse({ limit: 101 }).success).toBe(false);
  expect(endpoint?.query?.safeParse({ after: 'foreign-or-malformed' }).success).toBe(false);
});

it('reports the key account and explicit read restrictions without exposing the credential', () => {
  const endpoint = operation('getApiKeyContext');
  expect(endpoint).toMatchObject({ method: 'get', path: '/integration/context', group: 'Account' });
  const context = {
    scope: 'agency',
    agency: { name: 'Bluebird Digital', slug: 'bluebird-digital' },
    business: null,
    scopes: ['businesses.create'],
    readOnly: false,
    readGroups: ['Businesses'],
    expiresAt: null,
  };
  expect(endpoint?.response.schema?.parse(context)).toEqual(context);
  expect(endpoint?.response.schema?.safeParse({ ...context, key: 'crm_live_secret' }).success).toBe(
    false,
  );
  expect(
    endpoint?.response.schema?.safeParse({ ...context, readGroups: ['Unknown'] }).success,
  ).toBe(false);
});
