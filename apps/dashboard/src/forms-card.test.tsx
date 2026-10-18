// @vitest-environment jsdom
// The card "When someone sends the form" (forms-extras.tsx): the Source a form writes, the
// tag of the lead source, the tags as chips, and "Check a link".
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  DEFAULT_FORM_DEFINITION,
  formDefinition,
  leadSourceKeys,
  leadSourceLabels,
  leadSourceRuleDescriptions,
  type FormContactActions,
  type FormDefinition,
  type LeadSourcePreview,
  type TagConfiguration,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FormSubmitSettings } from './forms-extras';

vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
// The card's one link, to the business's own rules in Settings: drawn as a plain link.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode;
    to: string;
    params: { slug: string };
  }) => <a href={to.replace('$slug', params.slug)}>{children}</a>,
}));

const FORM_ID = 'form_01k8e2wzr0e008000000000001';
const at = '2026-10-10T09:00:00.000Z';
const tagOf = (number: number, name: string): TagConfiguration['items'][number] => ({
  id: `tag_01k8e2wzr0e0080000000000${String(number).padStart(2, '0')}`,
  name,
  description: '',
  createdAt: at,
  updatedAt: at,
  groupId: null,
  revision: 'a'.repeat(64),
});
const tags = Array.from({ length: 12 }, (_, index) => tagOf(index + 1, `Tag ${String(index + 1)}`));
const configuration: TagConfiguration = {
  items: tags,
  groups: [],
  rules: { creation: 'everyone', suggestSimilar: true, revision: 'a'.repeat(64) },
  canManage: true,
  canCreate: true,
};
const nothing = {
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
  matchType: null,
  campaignId: null,
  adGroupId: null,
  adId: null,
  referrerDomain: null,
  landingUrl: 'https://www.example.com/offer',
};
/** A business with no rules of its own: the built-in rule names the lead. */
const builtInOnly = (
  key: 'google_ads' | 'facebook_ads' | 'direct',
): Pick<LeadSourcePreview, 'decidedBy' | 'builtIn' | 'rules'> => ({
  decidedBy: { kind: 'built_in', key },
  builtIn: { source: leadSourceLabels[key], sourceRule: key },
  rules: [],
});
/** What the API would answer, decided here by what the address carries. */
const previewOf = (url: string): LeadSourcePreview => {
  const query = new URL(url).searchParams;
  if (query.has('gclid'))
    return {
      sessionSource: 'paid_search',
      source: leadSourceLabels.google_ads,
      sourceRule: 'google_ads',
      reason: leadSourceRuleDescriptions.google_ads,
      ...builtInOnly('google_ads'),
      facts: nothing,
      clickIds: ['gclid'],
      form: {
        id: FORM_ID,
        contactSource: leadSourceLabels.google_ads,
        tags: [
          { name: 'Tag 1', kind: 'form', exists: true },
          { name: 'Source: Google Ads', kind: 'source', exists: false },
        ],
      },
      warnings: [],
    };
  if (query.get('utm_source') === 'facebook')
    return {
      sessionSource: 'paid_social',
      source: leadSourceLabels.facebook_ads,
      sourceRule: 'facebook_ads',
      reason: leadSourceRuleDescriptions.facebook_ads,
      ...builtInOnly('facebook_ads'),
      facts: { ...nothing, utmSource: 'facebook', utmMedium: 'paid_social' },
      clickIds: ['fbclid'],
      form: {
        id: FORM_ID,
        contactSource: null,
        tags: [{ name: 'Source: Facebook Ads', kind: 'source', exists: true }],
      },
      warnings: [{ code: 'too_many_tags', message: 'The form already adds 10 tags.' }],
    };
  return {
    sessionSource: 'direct',
    source: leadSourceLabels.direct,
    sourceRule: 'direct',
    reason: leadSourceRuleDescriptions.direct,
    ...builtInOnly('direct'),
    facts: nothing,
    clickIds: [],
    form: { id: FORM_ID, contactSource: leadSourceLabels.direct, tags: [] },
    warnings: [{ code: 'no_tracking', message: 'Nothing in the address and no referrer.' }],
  };
};

interface Server {
  preview: (body: { url: string; referrer?: string; formId?: string }) => unknown;
  calls: { operation: string; input: unknown }[];
}
let server: Server;
const client = {
  request: (endpoint: { operationId: string }, input: { body?: { url: string } }) => {
    server.calls.push({ operation: endpoint.operationId, input });
    return Promise.resolve().then(() =>
      endpoint.operationId === 'previewLeadSource'
        ? server.preview(input.body ?? { url: '' })
        : configuration,
    );
  },
} as unknown as Client;

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  server = { preview: (body) => previewOf(body.url), calls: [] };
});
afterEach(cleanup);

const changes: FormDefinition[] = [];
const submitted = vi.fn();
function Held({
  initial,
  disabled,
  unsaved,
  formName,
}: {
  readonly initial: FormDefinition;
  readonly disabled: boolean;
  readonly unsaved: boolean;
  readonly formName: string;
}): ReactElement {
  const [definition, setDefinition] = useState(initial);
  return (
    // As in the builder: the card sits inside the form that saves the draft.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitted();
      }}
    >
      <FormSubmitSettings
        formId={FORM_ID}
        formName={formName}
        definition={definition}
        disabled={disabled}
        unsaved={unsaved}
        client={client}
        onChange={(next) => {
          changes.push(next);
          setDefinition(next);
        }}
      />
      <button type="submit">Save draft</button>
    </form>
  );
}
function show(
  // Null for a form stored with no such part at all.
  contactActions: FormContactActions | null | undefined = DEFAULT_FORM_DEFINITION.contactActions,
  {
    disabled = false,
    unsaved = false,
    formName = 'Wedding enquiry',
  }: { disabled?: boolean; unsaved?: boolean; formName?: string } = {},
): ReturnType<typeof userEvent.setup> {
  changes.length = 0;
  submitted.mockClear();
  const { contactActions: _left, ...rest } = DEFAULT_FORM_DEFINITION;
  const initial: FormDefinition = contactActions === null ? rest : { ...rest, contactActions };
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <I18nProvider i18n={i18n}>
        <Held initial={initial} disabled={disabled} unsaved={unsaved} formName={formName} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup({ delay: null });
}
const last = (): FormContactActions | undefined => changes.at(-1)?.contactActions;
const source = (): HTMLElement =>
  screen.getByRole('radiogroup', { name: 'Source written on the contact' });
const checked = (): string | undefined =>
  within(source())
    .getAllByRole<HTMLInputElement>('radio')
    .find((radio) => radio.checked)
    ?.closest('label')?.textContent;

it('offers the four sources as a radio group, each said in a sentence, on how they arrived for a new form', () => {
  show();
  expect(
    within(source())
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')?.textContent),
  ).toEqual([
    'From how they arrived (recommended)',
    'A name I write',
    'The name of this form',
    'Leave it empty',
  ]);
  expect(checked()).toBe('From how they arrived (recommended)');
  const says = (name: string): string | undefined =>
    document.getElementById(
      within(source()).getByRole('radio', { name }).getAttribute('aria-describedby') ?? '',
    )?.textContent;
  // Its examples are the server's own names.
  expect(says('From how they arrived (recommended)')).toBe(
    'Google Ads, Facebook, Organic Search and so on, worked out for each person from the link they followed and the site they came from.',
  );
  expect(says('A name I write')).toBe(
    'The same name for everyone who sends this form, whatever link they followed.',
  );
  expect(says('The name of this form')).toBe('“Wedding enquiry” for everyone who sends this form.');
  expect(says('Leave it empty')).toBe('This form writes no source on the contact.');
  expect(
    screen.getByText('A contact who already has a source keeps it; tags are always added.'),
  ).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Source to write' })).toBeNull();
});

it('writes each choice as the contract stores it, and keeps a typed name across choices', async () => {
  const user = show();
  await user.click(within(source()).getByRole('radio', { name: 'The name of this form' }));
  expect(last()).toEqual({ tagIds: [], source: { kind: 'form_name' }, tagBySource: true });
  await user.click(within(source()).getByRole('radio', { name: 'Leave it empty' }));
  expect(last()?.source).toEqual({ kind: 'none' });
  await user.click(within(source()).getByRole('radio', { name: 'A name I write' }));
  expect(last()?.source).toEqual({ kind: 'text', text: '' });
  await user.type(screen.getByRole('textbox', { name: 'Source to write' }), 'Trade fair');
  expect(last()?.source).toEqual({ kind: 'text', text: 'Trade fair' });
  await user.click(
    within(source()).getByRole('radio', { name: 'From how they arrived (recommended)' }),
  );
  expect(last()?.source).toEqual({ kind: 'arrived' });
  expect(screen.queryByRole('textbox', { name: 'Source to write' })).toBeNull();
  await user.click(within(source()).getByRole('radio', { name: 'A name I write' }));
  expect(last()?.source).toEqual({ kind: 'text', text: 'Trade fair' });
  // Every step was a form the API takes.
  for (const change of changes.filter(
    (each) => each.contactActions?.source.kind !== 'text' || each.contactActions.source.text !== '',
  ))
    expect(formDefinition.safeParse(change).success).toBe(true);
});

it('reads a form saved long ago: no source, no tags, the switch off', async () => {
  show(null);
  expect(checked()).toBe('Leave it empty');
  expect(screen.getByRole<HTMLInputElement>('switch', { name: 'Also tag by source' }).checked).toBe(
    false,
  );
  expect(await screen.findByText('No tags chosen.')).toBeTruthy();
});

it('names the form in general words while it has no name, and opens on a written name', () => {
  show(
    { tagIds: [], source: { kind: 'text', text: 'Open day' }, tagBySource: false },
    { formName: '  ' },
  );
  expect(
    screen.getByText("The form's name, for everyone who sends it.", { exact: true }),
  ).toBeTruthy();
  expect(checked()).toBe('A name I write');
  expect(screen.getByRole('textbox', { name: 'Source to write' })).toHaveProperty(
    'value',
    'Open day',
  );
});

it('turns the tag by source on and off, and says what it adds', async () => {
  const user = show();
  const toggle = screen.getByRole<HTMLInputElement>('switch', { name: 'Also tag by source' });
  expect(toggle.checked).toBe(true);
  expect(document.getElementById(toggle.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
    'Adds one tag for how each person arrived, such as “Source: Google Ads”. A tag is made the first time it is needed.',
  );
  await user.click(toggle);
  expect(last()).toEqual({ tagIds: [], source: { kind: 'arrived' }, tagBySource: false });
  await user.click(toggle);
  expect(last()?.tagBySource).toBe(true);
});

it('says when the form lists so many tags that the source tag would be left out', async () => {
  const full = tags.slice(0, 10).map((tag) => tag.id);
  const user = show({ tagIds: full, source: { kind: 'arrived' }, tagBySource: true });
  const warning = /This form already adds 10 tags of its own/;
  expect(screen.getByText(warning)).toBeTruthy();
  // Off, it is not a problem and is not said.
  await user.click(screen.getByRole('switch', { name: 'Also tag by source' }));
  expect(screen.queryByText(warning)).toBeNull();
  await user.click(screen.getByRole('switch', { name: 'Also tag by source' }));
  await user.click(await screen.findByRole('button', { name: 'Remove Tag 1' }));
  expect(screen.queryByText(warning)).toBeNull();
  expect(last()?.tagIds).toEqual(full.slice(1));
});

it('lists the names the server can write, in its order, only when asked', async () => {
  const user = show();
  const opener = screen.getByRole('button', { name: 'The names “how they arrived” can be' });
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText(leadSourceRuleDescriptions.organic_search)).toBeNull();
  await user.click(opener);
  expect(opener.getAttribute('aria-expanded')).toBe('true');
  const terms = [...document.querySelectorAll('dt')].map((term) => term.textContent);
  expect(terms).toEqual(
    leadSourceKeys.map((key) =>
      key === 'source_param' ? 'The name in the link' : leadSourceLabels[key],
    ),
  );
  expect(screen.getByText(leadSourceRuleDescriptions.organic_search)).toBeTruthy();
  await user.click(opener);
  expect(screen.queryByText(leadSourceRuleDescriptions.organic_search)).toBeNull();
});

it('shows the tags as chips and adds one from the search, keeping the source as it is', async () => {
  const user = show({ tagIds: [tags[2]?.id ?? ''], source: { kind: 'none' }, tagBySource: false });
  const list = await screen.findByRole('list', { name: 'Tags added to the contact' });
  expect(
    within(list)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['Tag 3']);
  await user.click(screen.getByRole('button', { name: 'Add tag' }));
  await screen.findByRole('option', { name: 'Tag 12' });
  await user.type(screen.getByRole('combobox', { name: 'Search tags' }), 'tag 12{Enter}');
  expect(last()).toEqual({
    tagIds: [tags[2]?.id, tags[11]?.id],
    source: { kind: 'none' },
    tagBySource: false,
  });
  // Enter in the panel added a tag and saved nothing.
  expect(submitted).not.toHaveBeenCalled();
});

it('changes nothing for someone who may only read the form, and still checks a link', async () => {
  const user = show(
    { tagIds: [tags[0]?.id ?? ''], source: { kind: 'arrived' }, tagBySource: true },
    { disabled: true },
  );
  // Switched off by the settings' own fieldset, as the browser does it.
  for (const radio of within(source()).getAllByRole('radio'))
    expect(radio.matches(':disabled')).toBe(true);
  expect(screen.getByRole('switch').matches(':disabled')).toBe(true);
  await waitFor(() => {
    expect(screen.getByText('Tag 1')).toBeTruthy();
  });
  expect(screen.queryByRole('button', { name: 'Add tag' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove Tag 1' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Check a link' }));
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Link they follow' }).disabled).toBe(
    false,
  );
});

const checking = async (
  user: ReturnType<typeof userEvent.setup>,
  link: string,
): Promise<HTMLElement> => {
  if (screen.queryByRole('textbox', { name: 'Link they follow' }) === null)
    await user.click(screen.getByRole('button', { name: 'Check a link' }));
  const box = screen.getByRole('textbox', { name: 'Link they follow' });
  await user.clear(box);
  if (link !== '') await user.type(box, link);
  await user.click(screen.getByRole('button', { name: 'Check' }));
  return screen.getByRole('group', { name: 'Check a link' });
};
const answer = (group: HTMLElement): Record<string, string> =>
  Object.fromEntries(
    [...group.querySelectorAll('dt')].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent ?? '',
    ]),
  );

it('checks a Google ad link and a Facebook ad link, and shows two different leads', async () => {
  const user = show();
  const opener = screen.getByRole('button', { name: 'Check a link' });
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('textbox', { name: 'Link they follow' })).toBeNull();
  // Pasted without https://, as people copy it.
  const group = await checking(user, 'www.example.com/offer?gclid=Cj0abc');
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Google Ads');
  });
  expect(answer(group)).toEqual({
    'Lead source': 'Google Ads',
    'Session source': 'Paid Search',
    'Decided by': leadSourceRuleDescriptions.google_ads,
    'Source written on the contact': 'Google Ads (only if the contact has none yet)',
    'Tags added': 'Tag 1Source: Google Ads (made by the first such lead)',
    'Click ids in the link': 'Google',
  });
  // The id is named by its platform and never repeated.
  expect(group.textContent).not.toContain('Cj0abc');
  expect(screen.queryByText(/carries nothing that tells us/)).toBeNull();
  expect(server.calls.at(-1)).toEqual({
    operation: 'previewLeadSource',
    input: { body: { url: 'https://www.example.com/offer?gclid=Cj0abc', formId: FORM_ID } },
  });

  await checking(
    user,
    'https://www.example.com/offer?utm_source=facebook&utm_medium=paid_social&fbclid=IwAR0',
  );
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Facebook Ads');
  });
  expect(answer(group)).toEqual({
    'Lead source': 'Facebook Ads',
    'Session source': 'Paid Social',
    'Decided by': leadSourceRuleDescriptions.facebook_ads,
    'Source written on the contact': 'None: this form writes no source.',
    'Tags added': 'Source: Facebook Ads',
    'Click ids in the link': 'Meta',
  });
  // What else the API remarks is passed on in its words.
  expect(within(group).getByText('The form already adds 10 tags.')).toBeTruthy();
});

it('says plainly that a bare link carries nothing, and would be Direct', async () => {
  const user = show();
  const group = await checking(user, 'https://www.example.com/offer');
  expect(
    await within(group).findByText(
      'This link carries nothing that tells us where the visitor came from, so it would be recorded as Direct. Add tracking to your ad links, such as utm_source and utm_medium, so each lead says where it came from.',
    ),
  ).toBeTruthy();
  expect(answer(group)).toEqual({
    'Lead source': 'Direct',
    'Session source': 'Direct Traffic',
    'Decided by': leadSourceRuleDescriptions.direct,
    'Source written on the contact': 'Direct (only if the contact has none yet)',
    'Tags added': 'None',
  });
  // The API's own sentence for the same thing is not said twice.
  expect(within(group).queryByText('Nothing in the address and no referrer.')).toBeNull();
});

it('refuses an address that is not one before asking, by its box, and Enter checks without saving', async () => {
  const user = show();
  const group = await checking(user, '');
  const url = screen.getByRole('textbox', { name: 'Link they follow' });
  expect(within(group).getByRole('alert').textContent).toBe(
    'Enter a web address, starting with https://.',
  );
  expect(url.getAttribute('aria-invalid')).toBe('true');
  expect(server.calls.filter((call) => call.operation === 'previewLeadSource')).toEqual([]);
  const from = screen.getByRole('textbox', { name: 'Where they came from (optional)' });
  await user.type(url, 'https://www.example.com/offer?gclid=x');
  await user.type(from, 'from google{Enter}');
  expect(within(group).getByRole('alert').textContent).toBe(
    'Enter a web address, starting with https://.',
  );
  expect(from.getAttribute('aria-invalid')).toBe('true');
  expect(url.getAttribute('aria-invalid')).toBeNull();
  await user.clear(from);
  await user.type(from, 'https://www.google.com/{Enter}');
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Google Ads');
  });
  expect(within(group).queryByRole('alert')).toBeNull();
  expect(server.calls.at(-1)?.input).toEqual({
    body: {
      url: 'https://www.example.com/offer?gclid=x',
      referrer: 'https://www.google.com/',
      formId: FORM_ID,
    },
  });
  expect(submitted).not.toHaveBeenCalled();
  // A new mistake takes the old answer's place.
  await user.clear(url);
  await user.type(url, 'not an address{Enter}');
  expect(answer(group)).toEqual({});
});

it('shows the refusal of the server in its words, and its own when the answer never came', async () => {
  server.preview = () => {
    throw new ApiError({
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      detail: 'This form no longer exists.',
    });
  };
  const user = show();
  const group = await checking(user, 'https://www.example.com/offer');
  expect((await within(group).findByRole('alert')).textContent).toBe('This form no longer exists.');
  server.preview = () => {
    throw new TypeError('Failed to fetch');
  };
  await user.click(screen.getByRole('button', { name: 'Check' }));
  await waitFor(() => {
    expect(within(group).getByRole('alert').textContent).toBe(
      "The link couldn't be checked. Check your connection and try again.",
    );
  });
});

it('says it is checking, and that unsaved changes are not in the answer', async () => {
  let release: () => void = () => undefined;
  server.preview = (body) =>
    new Promise((resolve) => {
      release = () => {
        resolve(previewOf(body.url));
      };
    });
  const user = show(DEFAULT_FORM_DEFINITION.contactActions, { unsaved: true });
  const group = await checking(user, 'https://www.example.com/offer?gclid=x');
  expect(
    await within(group).findByRole<HTMLButtonElement>('button', { name: 'Checking…' }),
  ).toHaveProperty('disabled', true);
  expect(
    within(group).getByText(
      'This checks the form as last saved. Save the draft to check what you changed.',
    ),
  ).toBeTruthy();
  release();
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Google Ads');
  });
});

it('says nothing of the form when the answer names none', async () => {
  server.preview = (body) => ({ ...previewOf(body.url), form: null });
  const user = show();
  const group = await checking(user, 'https://www.example.com/offer?gclid=x');
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Google Ads');
  });
  expect(Object.keys(answer(group))).toEqual([
    'Lead source',
    'Session source',
    'Decided by',
    'Click ids in the link',
  ]);
});

it("leads to the business's own lead source rules in Settings", () => {
  show();
  const link = screen.getByRole('link', { name: 'Lead source rules' });
  expect(link.getAttribute('href')).toBe('/b/harbor/settings/lead-sources');
});

it("shows which of the business's own rules matched, only when one did", async () => {
  server.preview = (body) => ({
    ...previewOf(body.url),
    source: 'Spring promo',
    decidedBy: { kind: 'rule', ruleId: 'lsr_01k8e2wzr0e008000000000001', name: 'Spring promo' },
    rules: [
      {
        id: 'lsr_01k8e2wzr0e008000000000001',
        name: 'Spring promo',
        position: 1,
        source: 'Spring promo',
        decidesSource: true,
        tags: [{ id: 'tag_01k8e2wzr0e008000000000001', name: 'Promo' }],
        fieldWrites: [],
      },
    ],
  });
  const user = show();
  const group = await checking(user, 'https://www.example.com/offer?gclid=x');
  await waitFor(() => {
    expect(answer(group)['Lead source']).toBe('Spring promo');
  });
  expect(answer(group)['Your rules that match']).toBe(
    '1. Spring promoSource: Spring promo (used) · tags: Promo',
  );
  // The card stays short: the built-in rule's own step is on the page in Settings.
  expect(Object.keys(answer(group))).not.toContain('Built-in rule');
});
