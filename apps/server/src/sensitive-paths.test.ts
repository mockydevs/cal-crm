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
