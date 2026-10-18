// @vitest-environment jsdom
// The contact page's Attribution group: what a touch said, a carried arrival with both of
// its pages, and "Show all fields" for the rows a visit did not carry.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { ContactAttribution, ContactAttributions } from '@repo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import ContactAttributionGroup from './contact-attribution';

const server = vi.hoisted((): { answer: () => unknown } => ({
  answer: () => {
    throw new Error('no answer set');
  },
}));
vi.mock('../api', () => ({
  apiIn: () => ({ request: () => Promise.resolve().then(() => server.answer()) }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const touchOf = (patch: Partial<ContactAttribution> = {}): ContactAttribution => ({
  touchedAt: '2026-10-10T09:00:00.000Z',
  medium: 'form',
  sessionSource: 'paid_search',
  utmSource: 'google',
  utmMedium: 'cpc',
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  referrerDomain: null,
  landingUrl: 'https://harborlights.example/open-day',
  pageUrl: 'https://harborlights.example/open-day',
  source: 'Google Ads',
  sourceRule: 'google_ads',
  clickIds: ['gclid'],
  ...patch,
});

function show(answer: ContactAttributions): void {
  server.answer = () => answer;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>
        <ContactAttributionGroup contactId="con_01k8e2wzr0e008000000000001" query="" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const rowNames = (group: HTMLElement): string[] =>
  [...group.querySelectorAll('dt')].map((term) => term.textContent);

it('lists what the visit said, and every field once all are asked for', async () => {
  const touch = touchOf();
  show({ first: touch, latest: touch });
  const first = await screen.findByRole('group', { name: 'First attribution' });
  expect(rowNames(first)).toEqual([
    'Lead source',
    'Session source',
    'Medium',
    'UTM source',
    'UTM medium',
    'Landing page',
    'When',
    'Click ids held',
  ]);
  expect(screen.queryByText(/Arrival carried from an earlier page/)).toBeNull();

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Show all fields' }));
  expect(rowNames(first)).toEqual([
    'Lead source',
    'Session source',
    'Medium',
    'UTM source',
    'UTM medium',
    'UTM campaign',
    'UTM content',
    'UTM term',
    'Match type',
    'Campaign ID',
    'Ad group ID',
    'Ad ID',
    'Referrer',
    'Landing page',
    'Page',
    'When',
    'Click ids held',
  ]);
  // A field the visit did not carry reads "Not set" to a screen reader.
  expect(within(first).getAllByText('Not set').length).toBe(8);

  await user.click(screen.getByRole('button', { name: 'Hide empty fields' }));
  expect(rowNames(first)).toHaveLength(8);
});

it('says an arrival was carried from an earlier page, with both pages', async () => {
  show({
    first: touchOf({
      landingUrl: 'https://harborlights.example/step-1',
      pageUrl: 'https://harborlights.example/step-2',
      arrivalCarried: true,
    }),
    latest: touchOf({ touchedAt: '2026-10-11T09:00:00.000Z', arrivalCarried: false }),
  });
  const first = await screen.findByRole('group', { name: 'First attribution' });
  expect(within(first).getByText(/Arrival carried from an earlier page/)).toBeTruthy();
  expect(within(first).getByText('https://harborlights.example/step-1')).toBeTruthy();
  expect(within(first).getByText('https://harborlights.example/step-2')).toBeTruthy();
  const latest = screen.getByRole('group', { name: 'Latest attribution' });
  expect(within(latest).queryByText(/Arrival carried from an earlier page/)).toBeNull();
});

it('offers no toggle while no touch is recorded', async () => {
  show({ first: null, latest: null });
  expect(await screen.findByText(/No touch is recorded for this contact yet/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show all fields' })).toBeNull();
});
