import { expect, it } from 'vitest';

import { redactedRequestUrl } from './sensitive-paths.js';

it('keeps the token of a form preview out of what is logged, and leaves a form’s own page as it is', () => {
  const token = `${'A'.repeat(70)}.${'B'.repeat(22)}`;
  for (const path of [
    `/f/preview/${token}`,
    `/f/preview/${token}?utm_source=mail`,
    '/f/preview',
    '/f/preview/',
    '/f/%70review/anything',
    `https://crm.example.test/f/preview/${token}`,
  ])
    expect(redactedRequestUrl(path)).toBe('/f/preview/[redacted]');
  // A form key is in the page source of every website that shows the form.
  const page = `/f/${'k'.repeat(32)}`;
  expect(redactedRequestUrl(page)).toBe(page);
  expect(redactedRequestUrl('/f/previews')).toBe('/f/previews');
  // The API a preview calls was private already, with every other public API.
  expect(redactedRequestUrl(`/api/v1/public/forms/preview/${token}`)).toBe(
    '/api/v1/public/[redacted]',
  );
});

it('keeps the token of a document’s public address out of what is logged', () => {
  const token = 'A'.repeat(43);
  for (const path of [
    `/d/${token}`,
    `/d/${token}/pdf`,
    `/d/${token}/logo`,
    `/d/${token}/accept`,
    `/d/${token}/pay`,
    `/d/${token}/pay/0199a3f2-3c4d-7e5f-8a9b-0c1d2e3f4a5b`,
    `/d/${token}/paid`,
    `/d/${token}?utm_source=mail`,
    '/d',
    '/d/',
    '/%64/anything',
    `https://crm.example.test/d/${token}`,
  ])
    expect(redactedRequestUrl(path)).toBe('/d/[redacted]');
  // Only that address: other paths that start with the letter stay as they are.
  for (const path of ['/dashboard', '/deals', '/documents/1'])
    expect(redactedRequestUrl(path)).toBe(path);
});

it('keeps the token of an appointment’s own page out of what is logged', () => {
  const token = `${'A'.repeat(40)}.${'B'.repeat(22)}`;
  for (const url of [
    `/appointments/manage/${token}`,
    `/appointments/manage/${token}?from=email`,
    `/appointments/manage/${token}/anything/after`,
    `https://crm.example/appointments/manage/${token}`,
    // However the prefix is spelled on the wire.
    `/appointments/%6danage/${token}`,
    '/appointments/manage',
    '/appointments/manage/',
  ])
    expect(redactedRequestUrl(url), url).toBe('/appointments/manage/[redacted]');
  // Nothing else under that name is changed: the dashboard's own pages carry no token.
  for (const url of ['/appointments', '/appointments/managed', '/b/acme/appointments/manage/x'])
    expect(redactedRequestUrl(url)).toBe(url);
});

it('keeps the code and state Google sends back out of what is logged', () => {
  expect(
    redactedRequestUrl('/api/v1/integrations/google/callback?state=abc&code=4/0secret&scope=x'),
  ).toBe('/api/v1/integrations/google/callback?[redacted]');
  expect(redactedRequestUrl('/api/v1/integrations/google/callback')).toBe(
    '/api/v1/integrations/google/callback?[redacted]',
  );
  expect(redactedRequestUrl('/api/v1/integrations/google')).toBe('/api/v1/integrations/google');
});

it("keeps a provider's code and state, and an update address's capability, out of what is logged", () => {
  expect(
    redactedRequestUrl('/api/v1/integrations/standin/callback?state=abc&code=secret-code'),
  ).toBe('/api/v1/integrations/[provider]/callback?[redacted]');
  expect(redactedRequestUrl('/webhooks/integrations/standin/' + 'a'.repeat(43))).toBe(
    '/webhooks/integrations/[redacted]',
  );
  // The integrations API itself carries nothing secret in its address.
  expect(redactedRequestUrl('/api/v1/integrations/standin/connect')).toBe(
    '/api/v1/integrations/standin/connect',
  );
  expect(redactedRequestUrl('/api/v1/integrations')).toBe('/api/v1/integrations');
});

it("keeps the token of a Stripe account's webhook address out of what is logged", () => {
  const token = 'A'.repeat(43);
  for (const path of [
    `/webhooks/stripe/${token}`,
    `/webhooks/stripe/${token}?x=1`,
    '/webhooks/stripe',
  ])
    expect(redactedRequestUrl(path)).toBe('/webhooks/stripe/[redacted]');
});
