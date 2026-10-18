// @vitest-environment jsdom
// Settings → Lead Sources → Tracking links, and Check a link: the text to paste for each
// platform, built from the catalogue, what a click on it would record, and the checker
// with every step of the decision.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { trackingLinkTemplate, trackingLinkTemplates, type FormList } from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  at,
  formId,
  funnelRule,
  previewOf,
  springRule,
  worldOf,
  type LeadSourcesWorld,
} from '../../e2e/lead-sources-fixtures';
import CheckTab from './check-tab';
import LinksTab from './links-tab';

interface Server {
  world: LeadSourcesWorld;
  instead: (operation: string) => unknown;
}
const server = vi.hoisted((): { current: Server | undefined } => ({ current: undefined }));
const forms: FormList = {
  items: [
    {
      id: formId,
      name: 'Wedding enquiry',
      status: 'published',
      hasUnpublishedChanges: false,
      submissionCount: 0,
      lastSubmissionAt: null,
      updatedAt: at,
    },
    {
      id: 'form_01k8e2wzr0e008000000000002',
      name: 'Open day',
      status: 'draft',
      hasUnpublishedChanges: false,
      submissionCount: 0,
      lastSubmissionAt: null,
      updatedAt: at,
    },
  ],
  nextCursor: null,
  canManage: true,
};

vi.mock('../api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: { readonly body?: unknown }) =>
      Promise.resolve().then(() => {
        const held = server.current;
        if (held === undefined) throw new Error('no server');
        const custom = held.instead(endpoint.operationId);
        if (custom !== undefined) return custom;
        if (endpoint.operationId === 'previewLeadSource') return previewOf(held.world, input.body);
        if (endpoint.operationId === 'listForms') return forms;
        throw new Error(`unexpected ${endpoint.operationId}`);
      }),
  }),
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
vi.mock('../shell/page', () => ({
  Page: ({ title, children }: { title: string; children: ReactNode }) => (
    <main>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 60000 });

const copied: string[] = [];
beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server.current = undefined;
  copied.length = 0;
});
afterEach(cleanup);

function show(
  tab: ReactElement,
  world: LeadSourcesWorld = worldOf(),
): { world: LeadSourcesWorld; user: ReturnType<typeof userEvent.setup> } {
  server.current = { world, instead: () => undefined };
  const user = userEvent.setup();
  // The clipboard of the test's browser: what was copied is kept to be read.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider i18n={i18n}>{tab}</I18nProvider>
    </QueryClientProvider>,
  );
  return { world, user };
}

const built = (): string =>
  screen.getByRole<HTMLTextAreaElement>('textbox', { name: /to paste|to use|to add/ }).value;
const recorded = (): HTMLElement =>
  screen.getByRole('region', { name: 'What this link will record' });
const rowOf = (within_: HTMLElement, term: string): string =>
  [...within_.querySelectorAll('dt')].find((each) => each.textContent === term)?.nextElementSibling
    ?.textContent ?? '';

it('opens on Google Ads with the Final URL suffix, says where it goes and that it is not fully confirmed', async () => {
  show(<LinksTab />);
  const suffix = trackingLinkTemplate('google_ads_suffix');
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Google Ads' }).checked).toBe(true);
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Google Ads: Final URL suffix' }).checked,
  ).toBe(true);
  expect(screen.getByText(suffix?.where ?? 'missing')).toBeTruthy();
  expect(built()).toBe(
    'utm_source=google&utm_medium=cpc&utm_campaign={campaignid}&utm_content={adgroupid}&utm_term={keyword}&matchtype={matchtype}&campaign_id={campaignid}&ad_group_id={adgroupid}&ad_id={creative}&device={device}&network={network}',
  );
  // The catalogue marks this template as not verified: the page says so, and never the opposite.
  expect(screen.getByText(/Not fully confirmed/)).toBeTruthy();
  expect(screen.queryByText(/^Checked:/)).toBeNull();
  for (const note of suffix?.notes ?? []) expect(screen.getByText(note)).toBeTruthy();
  const link = screen.getByRole('link', {
    name: /support\.google\.com\/google-ads\/answer\/6305348/,
  });
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');

  // What a click would record, with the catalogue's sample values in place of the placeholders.
  expect(await within(recorded()).findByText('Google Ads', { selector: 'dd' })).toBeTruthy();
  expect(rowOf(recorded(), 'Session source')).toBe('Paid Search');
  expect(recorded().textContent).toContain('utm_campaign=20511223344');
  expect(recorded().textContent).not.toContain('{campaignid}');
});

it('builds Google’s tracking template too, with its own words for a campaign, and copies it', async () => {
  const { user } = show(<LinksTab />);
  await user.click(screen.getByRole('radio', { name: 'Google Ads: tracking template' }));
  expect(
    built().startsWith('{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign={campaignid}'),
  ).toBe(true);
  // This one is verified in the catalogue.
  expect(screen.getByText(/^Checked:/)).toBeTruthy();
  expect(screen.queryByText(/Not fully confirmed/)).toBeNull();

  await user.type(screen.getByLabelText('UTM campaign (utm_campaign)'), 'Spring promo');
  expect(built()).toContain('utm_campaign=Spring%20promo&');
  expect(screen.getByText('UTM campaign. Your own words.')).toBeTruthy();
  // The landing page is for the example only: the platform adds the ad's own address.
  await user.type(
    screen.getByLabelText('Landing page address'),
    'www.harborlights.example/open-day',
  );
  expect(built().includes('harborlights')).toBe(false);
  await waitFor(() => {
    expect(recorded().textContent).toContain(
      'https://www.harborlights.example/open-day?utm_source=google&utm_medium=cpc&utm_campaign=Spring+promo',
    );
  });

  await user.click(screen.getByRole('button', { name: 'Copy: Tracking template to paste' }));
  expect(copied).toEqual([built()]);
  expect(await screen.findByText('Copied.')).toBeTruthy();
});

it('builds a Meta link as the catalogue has it, and says what it will record', async () => {
  const { user } = show(<LinksTab />, worldOf([springRule()]));
  await user.click(screen.getByRole('radio', { name: 'Meta' }));
  expect(built()).toBe(
    'utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}',
  );
  expect(screen.getAllByRole('radio').map((radio) => radio.parentElement?.textContent)).toEqual(
    expect.arrayContaining(
      trackingLinkTemplates.filter((each) => each.platform === 'meta').map((each) => each.label),
    ),
  );
  expect(screen.getByText(trackingLinkTemplate('meta_ads')?.where ?? 'missing')).toBeTruthy();
  // The sample campaign is "Spring promo": the business's own rule matches and names the lead,
  // and the built-in rule under it still says Facebook Ads.
  await waitFor(() => {
    expect(rowOf(recorded(), 'Lead source')).toBe('Spring promo');
  });
  expect(rowOf(recorded(), 'Your rules that match')).toContain('1. Spring promo');
  expect(rowOf(recorded(), 'Built-in rule')).toContain('Facebook Ads');
  expect(rowOf(recorded(), 'Built-in rule')).toContain('not used: a rule of yours names the lead');

  // The GoHighLevel-style template lets nobody write over its names.
  await user.click(screen.getByRole('radio', { name: 'Meta ads, GoHighLevel style (fb_ad)' }));
  expect(built().startsWith('utm_source=fb_ad&utm_medium={{adset.name}}')).toBe(true);
  expect(screen.queryByLabelText('UTM campaign (utm_campaign)')).toBeNull();
});

it('gives a whole link for an email, refuses a landing page that is no address, and keeps the page across platforms', async () => {
  const { user } = show(<LinksTab />);
  await user.type(screen.getByLabelText('Landing page address'), 'www.harborlights.example/offer');
  await user.click(screen.getByRole('radio', { name: 'Email' }));
  expect(screen.getByLabelText<HTMLInputElement>('Landing page address').value).toBe(
    'www.harborlights.example/offer',
  );
  expect(built()).toBe(
    'https://www.harborlights.example/offer?utm_source=newsletter&utm_medium=email&utm_campaign=october',
  );
  await waitFor(() => {
    expect(rowOf(recorded(), 'Lead source')).toBe('Email');
  });
  // No platform's documentation stands behind an email link: nothing claims it was checked.
  expect(screen.queryByText(/^Checked:/)).toBeNull();
  expect(screen.queryByText(/Not fully confirmed/)).toBeNull();

  const page = screen.getByLabelText('Landing page address');
  await user.clear(page);
  await user.type(page, 'ftp://example.com');
  expect(await screen.findByText('Enter a web address, starting with https://.')).toBeTruthy();
  expect(page.getAttribute('aria-invalid')).toBe('true');
  expect(built()).toBe('');
  expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Copy:/ }).disabled).toBe(true);

  await user.clear(page);
  await user.click(screen.getByRole('radio', { name: 'Other' }));
  expect(built()).toBe('source=Spring%20flyer');
  await waitFor(() => {
    expect(rowOf(recorded(), 'Lead source')).toBe('Spring flyer');
  });
});

it('says so when what a link would record cannot be read', async () => {
  show(<LinksTab />);
  if (server.current !== undefined)
    server.current.instead = (operation) => {
      if (operation === 'previewLeadSource')
        throw new ApiError({ type: 'about:blank', title: 'Refused', status: 403, detail: 'No.' });
      return undefined;
    };
  expect(await within(recorded()).findByRole('alert')).toBeTruthy();
  expect(within(recorded()).getByRole('alert').textContent).toBe('No.');
});

it('checks a link step by step: the rule of the business that matched, then the built-in rule', async () => {
  const { world, user } = show(<CheckTab />, worldOf([springRule(), funnelRule()]));
  await user.type(
    screen.getByLabelText('Link they follow'),
    'www.harborlights.example/wedding/step-2?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&fbclid=abc',
  );
  await user.click(screen.getByRole('button', { name: 'Check' }));
  const answer = await screen.findByRole('region', {
    name: 'What a lead arriving by this link would be',
  });
  expect(world.checked.at(-1)).toEqual({
    url: 'https://www.harborlights.example/wedding/step-2?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&fbclid=abc',
  });
  const rules = within(answer).getAllByRole('listitem');
  expect(rules.map((rule) => rule.textContent)).toEqual([
    '1. Spring promoSource: Spring promo (used) · tags: Promo, VIP',
    '2. Wedding funnelNames no Source · tags: Wedding enquiry · fills Campaign: wedding',
  ]);
  expect(rowOf(answer, 'Built-in rule')).toContain('Facebook Ads');
  expect(rowOf(answer, 'Built-in rule')).toContain('(not used: a rule of yours names the lead)');
  expect(rowOf(answer, 'Lead source')).toBe('Spring promo');
  expect(rowOf(answer, 'Session source')).toBe('Paid Social');
  expect(rowOf(answer, 'Click ids in the link')).toBe('Meta');
  // No form was named: nothing is said of a form's Source or tags.
  expect(rowOf(answer, 'Source written on the contact')).toBe('');
});

it('says none of the rules match, names the built-in rule, and warns of a link that carries nothing', async () => {
  const { user } = show(<CheckTab />, worldOf([springRule()]));
  await user.type(
    screen.getByLabelText('Link they follow'),
    'https://www.harborlights.example/{Enter}',
  );
  const answer = await screen.findByRole('region', {
    name: 'What a lead arriving by this link would be',
  });
  expect(rowOf(answer, 'Your rules that match')).toBe('None of your rules match this link.');
  expect(rowOf(answer, 'Built-in rule')).toContain('Direct');
  expect(rowOf(answer, 'Built-in rule')).toContain('(names the lead)');
  expect(within(answer).getByText(/would be recorded as Direct/)).toBeTruthy();

  // A click id alone: the API's own remark is passed on in its words.
  const link = screen.getByLabelText('Link they follow');
  await user.clear(link);
  await user.type(link, 'https://www.harborlights.example/?fbclid=abc{Enter}');
  // The answer is drawn anew for each link checked.
  expect(
    await screen.findByText(
      'Only a Facebook click id is known: a paid click cannot be told from a post’s.',
    ),
  ).toBeTruthy();
});

it('checks against a form when one is chosen, and refuses what is no address before asking', async () => {
  const { world, user } = show(<CheckTab />, worldOf([springRule()]));
  await user.click(screen.getByRole('button', { name: 'Check' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(world.checked).toHaveLength(0);

  await user.type(
    screen.getByLabelText('Link they follow'),
    'https://www.harborlights.example/?gclid=abc',
  );
  await user.type(screen.getByLabelText('Where they came from (optional)'), 'www.google.com');
  await user.click(
    await screen.findByRole('combobox', { name: 'Form to check against (optional)' }),
  );
  expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
    'No form',
    'Wedding enquiry',
    'Open day (draft)',
  ]);
  await user.click(screen.getByRole('option', { name: 'Wedding enquiry' }));
  await user.click(screen.getByRole('button', { name: 'Check' }));
  const answer = await screen.findByRole('region', {
    name: 'What a lead arriving by this link would be',
  });
  expect(world.checked.at(-1)).toEqual({
    url: 'https://www.harborlights.example/?gclid=abc',
    referrer: 'https://www.google.com',
    formId,
  });
  expect(rowOf(answer, 'Source written on the contact')).toContain('Google Ads');
  expect(rowOf(answer, 'Tags added')).toContain('Wedding enquiry');
  expect(rowOf(answer, 'Tags added')).toContain('Source: Google Ads (made by the first such lead)');
});

it('says in the words of the server why a link could not be checked', async () => {
  const { user } = show(<CheckTab />);
  if (server.current !== undefined)
    server.current.instead = (operation) => {
      if (operation === 'previewLeadSource')
        throw new ApiError({
          type: 'about:blank',
          title: 'Refused',
          status: 429,
          detail: 'Too many checks. Try again in a minute.',
        });
      return undefined;
    };
  await user.type(screen.getByLabelText('Link they follow'), 'https://www.example.com/{Enter}');
  expect(await screen.findByText('Too many checks. Try again in a minute.')).toBeTruthy();
});
