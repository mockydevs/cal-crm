// @vitest-environment jsdom
// "Start from a recipe": what the dialog starts with, what the choices give (a document the
// validator accepts in this business), the tags asked of the server first (the business's
// own tags of the lead sources, by key: never one made by name), and each way it can go
// wrong.
// And the two controls that read how a lead arrived: the lead sources a trigger starts for,
// and where an opportunity takes its source from.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import {
  leadSourceRecipeSources,
  leadSourceRecipeTags,
  validateAutomation,
  type AutomationSetup,
  type LeadSourceTags,
} from '@repo/contracts';
import { ApiError } from '@repo/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { automationOf, catalogOf, harborSetup } from '../e2e/automation-fixtures';
import {
  ownersOf,
  recipeDocument,
  recipes,
  recipeSources,
  recipeTagNames,
  reminderDocument,
  reminderStarterChoices,
  stagesOf,
  starterChoices,
  tagIdsOf,
  withCalendar,
  withPipeline,
} from './automation-recipe-rules';
import RecipesDialog from './automation-recipes';
import { DealSourceControl, LeadSourcesSetting } from './automation-source-fields';
import { loadAutomationWords } from './automation-words';

interface Server {
  calls: { operation: string; input: unknown }[];
  answer: (operation: string, input: unknown) => unknown;
}
const server = vi.hoisted((): Server => ({ calls: [], answer: () => undefined }));
vi.mock('./api', () => ({
  apiIn: () => ({
    request: (endpoint: { operationId: string }, input: unknown) => {
      server.calls.push({ operation: endpoint.operationId, input });
      return Promise.resolve().then(() => server.answer(endpoint.operationId, input));
    },
  }),
}));
vi.mock('./workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  server.calls = [];
  server.answer = () => undefined;
});
afterEach(cleanup);

const tagged: AutomationSetup = {
  ...harborSetup,
  tags: [
    ...harborSetup.tags,
    ...leadSourceRecipeTags().map((name, index) => ({ id: `tag_source_${String(index)}`, name })),
  ],
};
/**
 * What the server answers when asked for the recipe's tags: the business's own tag of each
 * lead source. The first was renamed by a person, and is still that lead source's tag.
 */
const ensured: LeadSourceTags = {
  items: leadSourceRecipeSources().map((source, index) => ({
    source,
    label: source,
    tag: {
      id: `tag_source_${String(index)}`,
      name: index === 0 ? 'Paid Google' : (leadSourceRecipeTags()[index] ?? ''),
      description: '',
      createdAt: '2026-10-13T09:00:00.000Z',
      updatedAt: '2026-10-13T09:00:00.000Z',
    },
  })),
};
/** The business once those tags are there, as the catalog then lists them. */
const renamed: AutomationSetup = {
  ...harborSetup,
  tags: [...harborSetup.tags, ...ensured.items.map((item) => item.tag)],
};
const team: AutomationSetup = {
  ...tagged,
  users: [...harborSetup.users, { id: 'usr_chris', name: 'Chris Vale' }],
  pipelines: [
    { id: 'pip_empty', name: 'Empty', stages: [] },
    ...harborSetup.pipelines,
    { id: 'pip_renewals', name: 'Renewals', stages: [{ id: 'stg_due', name: 'Due' }] },
  ],
};

describe('the rules of the recipes', () => {
  it('starts from the first pipeline that has a stage, and shares leads between a team', () => {
    expect(starterChoices(harborSetup)).toEqual({
      pipeline: 'pip_sales',
      stage: 'stg_new',
      owners: 'usr_dana',
    });
    expect(starterChoices(team)?.owners).toBe('everyone');
    expect(starterChoices(team)?.pipeline).toBe('pip_sales');
    expect(starterChoices({ ...harborSetup, users: [] })?.owners).toBe('none');
    expect(starterChoices({ ...harborSetup, pipelines: [] })).toBeUndefined();
    expect(
      starterChoices({
        ...harborSetup,
        pipelines: [{ id: 'pip_empty', name: 'Empty', stages: [] }],
      }),
    ).toBeUndefined();
  });

  it('takes the first stage of another pipeline, and names the owners by id', () => {
    const start = starterChoices(team);
    if (start === undefined) throw new Error('No starter.');
    expect(withPipeline(start, 'pip_renewals', team)).toMatchObject({
      pipeline: 'pip_renewals',
      stage: 'stg_due',
    });
    expect(withPipeline(start, 'pip_gone', team).stage).toBe('');
    expect(stagesOf(team, 'pip_gone')).toEqual([]);
    expect(ownersOf('none', team)).toEqual([]);
    expect(ownersOf('everyone', team)).toEqual(['usr_dana', 'usr_chris']);
    expect(ownersOf('usr_chris', team)).toEqual(['usr_chris']);
    expect(ownersOf('usr_gone', team)).toEqual([]);
  });

  it('asks for the tags by the lead source’s key, and names each by the id it is answered', () => {
    expect(recipeSources()).toEqual([
      'google_ads',
      'facebook_ads',
      'instagram_ads',
      'organic_search',
    ]);
    expect(recipeTagNames()).toBe(
      'Source: Google Ads, Source: Facebook Ads, Source: Instagram Ads, Source: Organic Search',
    );
    expect(tagIdsOf(ensured)).toEqual({
      google_ads: 'tag_source_0',
      facebook_ads: 'tag_source_1',
      instagram_ads: 'tag_source_2',
      organic_search: 'tag_source_3',
    });
    // A lead source the recipe has no branch for is left out, whatever the server sends.
    expect(
      tagIdsOf({
        items: [{ ...(ensured.items[0] ?? raise()), source: 'direct' }],
      }),
    ).toEqual({});
    // By id the document is valid although a person renamed a tag; by name it is not, which
    // is why the recipe never names its tags.
    const start = starterChoices(renamed);
    if (start === undefined) throw new Error('No starter.');
    const byId = validateAutomation(
      recipeDocument(start, renamed, 'Recipe', tagIdsOf(ensured)),
      renamed,
    );
    expect(byId.errors).toEqual([]);
    expect(byId.document?.steps['tag_google_ads']?.config).toEqual({ tag: 'tag_source_0' });
    // Everything else adds no tag: no "Source: Other" for a direct lead.
    expect(Object.keys(byId.document?.steps ?? {}).filter((key) => key.startsWith('tag_'))).toEqual(
      ['tag_google_ads', 'tag_facebook_ads', 'tag_instagram_ads', 'tag_organic_search'],
    );
    expect(
      validateAutomation(recipeDocument(start, renamed, 'Recipe'), renamed).errors.map(
        (issue) => issue.code,
      ),
    ).toEqual(['unknown_reference']);
  });

  it('gives a document the validator accepts in a business that has the tags', () => {
    for (const owners of ['none', 'everyone', 'usr_dana'] as const) {
      const start = starterChoices(team);
      if (start === undefined) throw new Error('No starter.');
      const result = validateAutomation(
        recipeDocument({ ...start, owners }, team, 'Tag and route leads by source'),
        team,
      );
      expect([owners, result.errors, result.warnings]).toEqual([owners, [], []]);
      expect(Object.keys(result.document?.steps ?? {}).includes('assign_owner')).toBe(
        owners !== 'none',
      );
    }
    expect(recipes.map((recipe) => recipe.key)).toEqual(['lead_source', 'appointment_reminders']);
  });

  it('starts the reminders on the calendar the address names, with a text when one can go', () => {
    expect(reminderStarterChoices(harborSetup, 'cal_consult')).toEqual({
      calendars: ['cal_consult'],
      text: true,
    });
    // A calendar the business does not have is not chosen: every calendar is.
    expect(reminderStarterChoices(harborSetup, 'cal_gone').calendars).toEqual([]);
    expect(reminderStarterChoices(harborSetup).calendars).toEqual([]);
    const noSms = { ...harborSetup, channels: { ...harborSetup.channels, sms: false } };
    expect(reminderStarterChoices(noSms).text).toBe(false);
    const start = reminderStarterChoices(harborSetup);
    expect(withCalendar(start, 'cal_consult', true).calendars).toEqual(['cal_consult']);
    expect(
      withCalendar(withCalendar(start, 'cal_consult', true), 'cal_consult', false).calendars,
    ).toEqual([]);
  });

  it('gives a reminders document the validator accepts, and never a text without a number', () => {
    const chosen = { calendars: ['cal_consult', 'cal_gone'], text: true };
    const result = validateAutomation(
      reminderDocument(chosen, harborSetup, 'Appointment reminders'),
      harborSetup,
    );
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers).toEqual([
      { id: 'booked', type: 'appointment.booked', config: { calendar: 'cal_consult' } },
    ]);
    expect(result.document?.steps['text_hour_before']?.type).toBe('sms.send');
    const noSms = { ...harborSetup, channels: { ...harborSetup.channels, sms: false } };
    const withoutText = reminderDocument(chosen, noSms, 'Appointment reminders');
    expect(withoutText.steps['text_hour_before']).toBeUndefined();
    expect(validateAutomation(withoutText, noSms).errors).toEqual([]);
  });
});

function raise(): never {
  throw new Error('The fixture has no such item.');
}

function showDialog(
  onCreated = vi.fn(),
  initial?: { recipe: 'appointment_reminders'; calendar?: string },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <I18nProvider i18n={i18n}>
        <RecipesDialog
          open
          onOpenChange={onOpenChange}
          onCreated={onCreated}
          {...(initial === undefined ? {} : { initial })}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onCreated, onOpenChange, user: userEvent.setup() };
}

/** Opens the dialog on the lead source recipe, as a person picks it from the list. */
async function showLeadSource(onCreated = vi.fn()) {
  const shown = showDialog(onCreated);
  await shown.user.click(
    await screen.findByRole('button', { name: 'Tag and route leads by source' }),
  );
  return shown;
}

const calls = (operation: string) =>
  server.calls.filter((call) => call.operation === operation).map((call) => call.input);

describe('the recipes dialog', () => {
  it('fetches its own words without replacing any', async () => {
    await expect(loadAutomationWords()).resolves.toBeUndefined();
    const locale = i18n.locale;
    i18n.activate('xx');
    await expect(loadAutomationWords()).resolves.toBeUndefined();
    i18n.activate(locale);
  });

  it('says what the recipe does, asks for the tags, then makes the draft, and opens it', async () => {
    server.answer = (operation) => {
      if (operation === 'getAutomationCatalog')
        return catalogOf({ ...team, tags: harborSetup.tags });
      if (operation === 'ensureLeadSourceTags') return ensured;
      return { automation: automationOf() };
    };
    const { user, onCreated, onOpenChange } = await showLeadSource();
    expect(
      await screen.findByRole('heading', { name: 'Tag and route leads by source' }),
    ).toBeDefined();
    expect(screen.getByText('Starts when any form is submitted.')).toBeDefined();
    expect(
      screen.getByText(
        'Takes a branch for each of Google Ads, Facebook Ads, Instagram Ads, Organic Search, and one for everything else.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        'Adds the tag of that source, such as “Source: Google Ads”: the same tag your forms add. Everything else gets no tag here.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "It adds the tags your forms add for these sources (Source: Google Ads, Source: Facebook Ads, Source: Instagram Ads, Source: Organic Search). One that isn't here yet is made first, in the “Lead source” tag group; no second copy is ever made.",
      ),
    ).toBeDefined();
    const pipeline = screen.getByLabelText('Pipeline for the new opportunities');
    expect(pipeline).toHaveProperty('value', 'pip_sales');
    expect(document.activeElement).toBe(pipeline);
    fireEvent.change(pipeline, { target: { value: 'pip_renewals' } });
    expect(screen.getByLabelText('Stage they start in')).toHaveProperty('value', 'stg_due');
    fireEvent.change(pipeline, { target: { value: 'pip_sales' } });
    fireEvent.change(screen.getByLabelText('Stage they start in'), {
      target: { value: 'stg_quoted' },
    });
    const owners = screen.getByLabelText(/^Who new leads go to/);
    expect(owners).toHaveProperty('value', 'everyone');
    fireEvent.change(owners, { target: { value: 'usr_chris' } });
    await user.click(screen.getByRole('button', { name: 'Create the draft' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    // No tag is made by name: the server is asked once, by key, and its ids are used.
    expect(calls('createTag')).toEqual([]);
    expect(calls('ensureLeadSourceTags')).toEqual([
      { body: { sources: ['google_ads', 'facebook_ads', 'instagram_ads', 'organic_search'] } },
    ]);
    const [made] = calls('createAutomation') as { body: { document: Record<string, unknown> } }[];
    expect(
      ['tag_google_ads', 'tag_facebook_ads', 'tag_instagram_ads', 'tag_organic_search'].map(
        (key) => (made?.body.document['steps'] as Record<string, { config: unknown }>)[key]?.config,
      ),
    ).toEqual([
      { tag: 'tag_source_0' },
      { tag: 'tag_source_1' },
      { tag: 'tag_source_2' },
      { tag: 'tag_source_3' },
    ]);
    expect(made?.body.document['steps']).not.toHaveProperty('tag_other');
    expect(made?.body.document['name']).toBe('Tag and route leads by source');
    expect(
      (made?.body.document['steps'] as Record<string, { config: unknown }>)['assign_owner']?.config,
    ).toEqual({
      user: 'usr_chris',
      onlyIfUnassigned: true,
    });
    expect(
      (made?.body.document['steps'] as Record<string, { config: unknown }>)['create_opportunity']
        ?.config,
    ).toEqual({ pipeline: 'pip_sales', stage: 'stg_quoted', source: { from: 'arrival' } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('offers one person where the team is one, and leaves the owner step out when asked', async () => {
    server.answer = (operation) =>
      operation === 'getAutomationCatalog'
        ? catalogOf(tagged)
        : operation === 'ensureLeadSourceTags'
          ? ensured
          : { automation: automationOf() };
    const { user, onCreated } = await showLeadSource();
    const owners = await screen.findByLabelText(/^Who new leads go to/);
    expect(
      within(owners).queryByRole('option', { name: 'Everyone on the team, in turn' }),
    ).toBeNull();
    fireEvent.change(owners, { target: { value: 'none' } });
    await user.click(screen.getByRole('button', { name: 'Create the draft' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(calls('createTag')).toEqual([]);
    const [made] = calls('createAutomation') as { body: { document: { steps: object } } }[];
    expect(Object.keys(made?.body.document.steps ?? {})).not.toContain('assign_owner');
  });

  it('says so when the business has no pipeline, and creates nothing', async () => {
    server.answer = () => catalogOf({ ...tagged, pipelines: [] });
    const { user, onOpenChange } = await showLeadSource();
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This recipe opens an opportunity, and this business has no pipeline with a stage yet. Add a pipeline in Opportunities first.',
    );
    expect(screen.getByRole('button', { name: 'Create the draft' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each([
    [
      new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 }),
      "You don't have permission to create workflows or to add tags. Ask someone who manages workflows and tags to start this recipe.",
    ],
    [
      new ApiError({
        type: 'about:blank',
        title: 'Invalid',
        status: 422,
        errors: [{ path: '/name', code: 'taken', message: 'That name is taken.' }],
      }),
      'That name is taken.',
    ],
    [
      new ApiError({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'Try later.',
      }),
      'Try later.',
    ],
    [
      new ApiError({ type: 'about:blank', title: 'Error', status: 500 }),
      "We couldn't create the workflow. Try again.",
    ],
    [new Error('offline'), "We couldn't reach the server. Check your connection and try again."],
  ])('says what went wrong when it cannot be made: %#', async (error, words) => {
    server.answer = (operation) => {
      if (operation === 'getAutomationCatalog') return catalogOf(harborSetup);
      throw error;
    };
    const { user, onCreated } = await showLeadSource();
    await user.click(await screen.findByRole('button', { name: 'Create the draft' }));
    expect(await screen.findByText(words)).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('offers to try again when what the business has cannot be read', async () => {
    let fails = true;
    server.answer = () => {
      if (fails) throw new Error('offline');
      return catalogOf(tagged);
    };
    const { user } = showDialog();
    expect(
      await screen.findByText("We couldn't load what this business has to choose from."),
    ).toBeDefined();
    fails = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Appointment reminders' })).toBeDefined();
  });

  it('lists the recipes, opens one, and comes back to the list', async () => {
    server.answer = () => catalogOf(tagged);
    const { user } = showDialog();
    const first = await screen.findByRole('button', { name: 'Tag and route leads by source' });
    // The list arrives after the dialog opened: the keyboard comes to the first recipe.
    expect(document.activeElement).toBe(first);
    expect(
      screen.getByRole('button', {
        name: 'Appointment reminders',
        description:
          'Fewer no-shows: reminds people of the appointment they booked, a day and an hour before.',
      }),
    ).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Appointment reminders' }));
    expect(screen.getByRole('heading', { name: 'Appointment reminders' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: '← All recipes' }));
    expect(screen.getByRole('button', { name: 'Tag and route leads by source' })).toBeDefined();
  });

  it('makes the reminders for the calendar the address names, with the text', async () => {
    const team = {
      ...harborSetup,
      calendars: [...harborSetup.calendars, { id: 'cal_tour', name: 'Venue tour' }],
    };
    server.answer = (operation) =>
      operation === 'getAutomationCatalog' ? catalogOf(team) : { automation: automationOf() };
    const { user, onCreated, onOpenChange } = showDialog(vi.fn(), {
      recipe: 'appointment_reminders',
      calendar: 'cal_tour',
    });
    expect(await screen.findByRole('heading', { name: 'Appointment reminders' })).toBeDefined();
    expect(
      screen.getByText(
        'A reschedule moves both reminders; a cancellation or a no-show stops them.',
      ),
    ).toBeDefined();
    const calendars = screen.getByRole('group', { name: 'Calendars it reminds for' });
    const tour = within(calendars).getByLabelText('Venue tour');
    expect(tour).toHaveProperty('checked', true);
    expect(within(calendars).getByLabelText('Consultation')).toHaveProperty('checked', false);
    expect(document.activeElement).toBe(within(calendars).getByLabelText('Consultation'));
    await user.click(within(calendars).getByLabelText('Consultation'));
    const text = screen.getByLabelText('Also send a text an hour before');
    expect(text).toHaveProperty('checked', true);
    expect(text).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Create the draft' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const [made] = calls('createAutomation') as {
      body: { document: { name: string; triggers: unknown; steps: Record<string, unknown> } };
    }[];
    expect(made?.body.document.name).toBe('Appointment reminders');
    expect(made?.body.document.triggers).toEqual([
      { id: 'booked', type: 'appointment.booked', config: { calendar: 'cal_tour' } },
      { id: 'booked_2', type: 'appointment.booked', config: { calendar: 'cal_consult' } },
    ]);
    expect(Object.keys(made?.body.document.steps ?? {})).toContain('text_hour_before');
    // No tag is asked for: this recipe needs none.
    expect(calls('ensureLeadSourceTags')).toEqual([]);
  });

  it('offers no text without a number, and says the reminders need a mailbox', async () => {
    server.answer = (operation) =>
      operation === 'getAutomationCatalog'
        ? catalogOf({ ...harborSetup, channels: { email: false, sms: false, whatsapp: false } })
        : { automation: automationOf() };
    const { user, onCreated } = showDialog(vi.fn(), { recipe: 'appointment_reminders' });
    const text = await screen.findByLabelText('Also send a text an hour before');
    expect(text).toHaveProperty('disabled', true);
    expect(text).toHaveProperty('checked', false);
    expect(
      screen.getByText(
        'Connect a phone number in Settings → Phone System to send texts. You can add the text step later.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "This business has no mailbox connected, so the reminders can't be sent yet. The draft is made all the same: connect a mailbox in Settings → Email Services before you publish it.",
      ),
    ).toBeDefined();
    // No calendar ticked: every calendar.
    await user.click(screen.getByRole('button', { name: 'Create the draft' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    const [made] = calls('createAutomation') as {
      body: { document: { triggers: unknown; steps: Record<string, unknown> } };
    }[];
    expect(made?.body.document.triggers).toEqual([
      { id: 'booked', type: 'appointment.booked', config: {} },
    ]);
    expect(Object.keys(made?.body.document.steps ?? {})).not.toContain('text_hour_before');
  });

  it('says why the reminders could not be made', async () => {
    server.answer = (operation) => {
      if (operation === 'getAutomationCatalog') return catalogOf(harborSetup);
      throw new ApiError({ type: 'about:blank', title: 'Forbidden', status: 403 });
    };
    const { user, onCreated } = showDialog(vi.fn(), { recipe: 'appointment_reminders' });
    await user.click(await screen.findByRole('button', { name: 'Create the draft' }));
    expect(
      await screen.findByText(
        "You don't have permission to create workflows. Ask someone who manages workflows to start this recipe.",
      ),
    ).toBeDefined();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

function Sources({ start }: { readonly start: unknown }): ReactElement {
  const [value, setValue] = useState(start);
  return (
    <I18nProvider i18n={i18n}>
      <LeadSourcesSetting
        id="sources"
        label="Lead source is any of"
        value={value}
        onChange={setValue}
      />
      <output data-testid="saved">{JSON.stringify(value ?? null)}</output>
    </I18nProvider>
  );
}
const saved = (): unknown => JSON.parse(screen.getByTestId('saved').textContent);

describe('the lead sources a trigger starts for', () => {
  it('ticks the built-in names, keeps one of the business own, and adds another', async () => {
    const user = userEvent.setup();
    render(<Sources start={['Spring flyer']} />);
    const group = screen.getByRole('group', { name: 'Lead source is any of' });
    expect(within(group).getAllByRole('checkbox')).toHaveLength(21);
    expect(within(group).getByLabelText('Spring flyer (your own)')).toHaveProperty('checked', true);
    await user.click(within(group).getByLabelText('Google Ads'));
    await user.click(within(group).getByLabelText('Facebook Ads'));
    expect(saved()).toEqual(['Spring flyer', 'Google Ads', 'Facebook Ads']);
    await user.click(within(group).getByLabelText('Google Ads'));
    await user.click(within(group).getByLabelText('Spring flyer (your own)'));
    expect(saved()).toEqual(['Facebook Ads']);
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toHaveProperty('disabled', true);
    await user.type(screen.getByLabelText('Another lead source'), 'Trade show{Enter}');
    expect(saved()).toEqual(['Facebook Ads', 'Trade show']);
    await user.type(screen.getByLabelText('Another lead source'), 'Billboard');
    await user.click(add);
    expect(saved()).toEqual(['Facebook Ads', 'Trade show', 'Billboard']);
    expect(screen.getByLabelText('Another lead source')).toHaveProperty('value', '');
    // Another key does nothing, and Enter on nothing adds nothing.
    await user.type(screen.getByLabelText('Another lead source'), 'x{Backspace}{Enter}');
    expect(saved()).toHaveLength(3);
    for (const name of ['Facebook Ads', 'Trade show (your own)', 'Billboard (your own)'])
      await user.click(within(group).getByLabelText(name));
    expect(saved()).toBeNull();
  });

  it('takes no more than a trigger can list', () => {
    const many = Array.from({ length: 20 }, (_, index) => `Source ${String(index + 1)}`);
    render(<Sources start={many} />);
    expect(screen.getByText('That is the most a trigger can list.')).toBeDefined();
    expect(screen.getByLabelText('Google Ads')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Source 1 (your own)')).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Another lead source')).toHaveProperty('disabled', true);
    fireEvent.keyDown(screen.getByLabelText('Another lead source'), { key: 'Enter' });
    expect(saved()).toHaveLength(20);
  });
});

function Source({
  start,
  updating = false,
}: {
  readonly start: unknown;
  readonly updating?: boolean;
}): ReactElement {
  const [value, setValue] = useState(start);
  return (
    <I18nProvider i18n={i18n}>
      <DealSourceControl
        id="source"
        label="Opportunity source"
        value={value}
        setup={harborSetup}
        updating={updating}
        onChange={setValue}
      />
      <output data-testid="saved">{JSON.stringify(value === undefined ? 'unset' : value)}</output>
    </I18nProvider>
  );
}

describe("where an opportunity's source comes from", () => {
  it('is how they arrived unless text is written or none is chosen', async () => {
    const user = userEvent.setup();
    render(<Source start={undefined} />);
    const list = screen.getByRole('combobox', { name: 'Opportunity source' });
    expect(list).toHaveProperty('value', 'arrival');
    expect(within(list).getByRole('option', { name: 'No source' })).toBeDefined();
    fireEvent.change(list, { target: { value: 'text' } });
    expect(saved()).toBe('');
    await user.type(screen.getByLabelText('Opportunity source, the text'), 'Referral from ');
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Insert a field into: Opportunity source, the text' }),
      { target: { value: 'trigger.attribution.source' } },
    );
    expect(saved()).toBe('Referral from {{trigger.attribution.source}}');
    fireEvent.change(list, { target: { value: 'none' } });
    expect(saved()).toBeNull();
    expect(screen.queryByLabelText('Opportunity source, the text')).toBeNull();
    fireEvent.change(list, { target: { value: 'arrival' } });
    expect(saved()).toEqual({ from: 'arrival' });
  });

  it('says "remove it" on an update, and keeps what it cannot show as written', () => {
    render(<Source start="Website" updating />);
    const list = screen.getByRole('combobox', { name: 'Opportunity source' });
    expect(list).toHaveProperty('value', 'text');
    expect(within(list).getByRole('option', { name: 'No source (remove it)' })).toBeDefined();
    cleanup();
    render(<Source start={{ from: 'elsewhere' }} />);
    expect(screen.queryByRole('combobox', { name: 'Opportunity source' })).toBeNull();
  });

  it('has no id of its own inside a row', () => {
    render(
      <I18nProvider i18n={i18n}>
        <DealSourceControl
          label="Source is set to"
          value={null}
          setup={harborSetup}
          invalid
          onChange={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('combobox', { name: 'Source is set to' })).toHaveProperty(
      'value',
      'none',
    );
  });
});
