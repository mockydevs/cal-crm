// @vitest-environment jsdom
// The compact trigger editor: only the filters that
// are set are on the panel, a source filter is chips and a list to search, a stored source
// filter survives opening and saving, a draft form is named as a draft, and a form's
// questions are fields a filter can read.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { AutomationSetup } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, harborSetup } from '../e2e/automation-fixtures';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';

beforeAll(async () => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  Element.prototype.scrollIntoView = vi.fn();
  await import('./automation-trigger-filters-panel');
  await import('./automation-filter-editor');
});
afterEach(cleanup);

const setup: AutomationSetup = {
  ...harborSetup,
  forms: [
    {
      id: 'form_enquiry',
      name: 'Event enquiry',
      questions: [
        {
          key: 'service_interest',
          label: 'Service interest',
          type: 'single_choice',
          options: [
            { key: 'dj', label: 'DJ' },
            { key: 'photo', label: 'Photo booth' },
          ],
        },
        { key: 'guests', label: 'Guests', type: 'number', options: [] },
      ],
    },
  ],
};

/** The business's forms as its API lists them: the published one, a draft, an archived one. */
const client = {
  request: vi.fn((_endpoint: unknown, input: { query: { archived: string } }) =>
    Promise.resolve({
      canManage: true,
      nextCursor: null,
      items:
        input.query.archived === 'true'
          ? [{ id: 'form_2019', name: 'Open day 2019', status: 'archived' }]
          : [
              { id: 'form_enquiry', name: 'Event enquiry', status: 'published' },
              { id: 'form_wedding', name: 'Wedding demo', status: 'draft' },
            ],
    }),
  ),
} as unknown as Client;

function open(
  config: Record<string, unknown>,
  more: { condition?: unknown; client?: Client; problems?: Record<string, string> } = {},
) {
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="trigger"
        editing={{
          key: 'trigger:enquiry',
          type: 'form.submitted',
          config,
          condition: more.condition,
          problems: more.problems,
        }}
        catalog={catalogOf(setup) as AutomationCatalogData}
        setup={setup}
        client={more.client}
        onSubmit={saved}
      />
    </I18nProvider>,
  );
  return { saved, user: userEvent.setup({ delay: null }) };
}
const panel = (): Promise<HTMLElement> => screen.findByRole('dialog', { name: 'Form submitted' });
const save = async (user: ReturnType<typeof userEvent.setup>): Promise<void> => {
  await user.click(screen.getByRole('button', { name: 'Save trigger' }));
};

describe('a form trigger, compact', () => {
  it('opens on the form and no source lists: any source, until a filter is added', async () => {
    const { saved, user } = open({ form: 'form_enquiry' });
    const dialog = await panel();
    const filters = await within(dialog).findByRole('group', { name: 'Filters' });
    expect(
      await within(dialog).findByRole('button', { name: 'Form: Event enquiry' }),
    ).toBeDefined();
    expect(filters.textContent).toContain('No filters applied');
    // Not one lead source or session source is on the panel.
    expect(within(dialog).queryByText('Google Ads')).toBeNull();
    expect(within(dialog).queryByText('Paid Search')).toBeNull();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    await save(user);
    expect(saved).toHaveBeenCalledWith(
      'form.submitted',
      { form: 'form_enquiry' },
      { label: undefined, condition: undefined },
    );
  });

  it('adds a lead source filter from the menu, as chips with a list that is searched', async () => {
    const { saved, user } = open({ form: 'form_enquiry' });
    const dialog = await panel();
    await user.click(await within(dialog).findByRole('button', { name: 'Add filters' }));
    expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual([
      'Lead source',
      'Session source',
      'An answer on the form',
      'Another field',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Lead source' }));
    const row = within(
      await within(dialog).findByRole('list', { name: 'Source filters' }),
    ).getByRole('listitem');
    expect(row.textContent).toContain(
      'Nothing is chosen yet, so this filter lets every lead through.',
    );
    await user.click(within(row).getByRole('button', { name: /^Lead source is any of: / }));
    const search = await screen.findByRole('combobox', { name: 'Search or type a lead source' });
    await user.type(search, 'goo');
    // The built-in name that fits, and what was typed as a name of the business's own.
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Google Ads',
      'Add “goo”',
    ]);
    await user.keyboard('{Enter}');
    // One of the business's own names, typed.
    await user.clear(search);
    await user.type(search, 'Radio spot');
    await user.click(await screen.findByRole('option', { name: 'Add “Radio spot”' }));
    await user.keyboard('{Escape}');
    const chips = within(row).getByRole('list', { name: 'Lead source is any of' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual(['Google Ads', 'Radio spot']);
    await user.click(within(chips).getByRole('button', { name: 'Remove Radio spot' }));
    await save(user);
    expect(saved).toHaveBeenCalledWith(
      'form.submitted',
      { form: 'form_enquiry', sources: ['Google Ads'] },
      { label: undefined, condition: undefined },
    );
  });

  it('keeps a stored source filter through opening and saving, and drops it only when removed', async () => {
    const stored = {
      form: 'form_enquiry',
      sources: ['Google Ads', 'Billboard'],
      sessionSources: ['paid_search'],
    };
    const first = open(stored);
    let dialog = await panel();
    const list = await within(dialog).findByRole('list', { name: 'Source filters' });
    expect(
      within(within(list).getByRole('list', { name: 'Lead source is any of' }))
        .getAllByRole('listitem')
        .map((chip) => chip.textContent),
    ).toEqual(['Google Ads', 'Billboard']);
    expect(
      within(within(list).getByRole('list', { name: 'Session source is any of' })).getByText(
        'Paid Search',
      ),
    ).toBeDefined();
    await save(first.user);
    expect(first.saved).toHaveBeenCalledWith('form.submitted', stored, {
      label: undefined,
      condition: undefined,
    });
    cleanup();

    const second = open(stored);
    dialog = await panel();
    await second.user.click(
      await within(dialog).findByRole('button', {
        name: 'Remove filter: Session source is any of',
      }),
    );
    await save(second.user);
    expect(second.saved).toHaveBeenCalledWith(
      'form.submitted',
      { form: 'form_enquiry', sources: ['Google Ads', 'Billboard'] },
      { label: undefined, condition: undefined },
    );
  });

  it('filters on an answer of the form, typed by the question: "Service interest is DJ"', async () => {
    const { saved, user } = open({ form: 'form_enquiry' });
    const dialog = await panel();
    await user.click(await within(dialog).findByRole('button', { name: 'Add filters' }));
    await user.click(await screen.findByRole('menuitem', { name: 'An answer on the form' }));
    const rows = await within(dialog).findByRole('list', { name: 'Filters' });
    expect(within(rows).getByRole('combobox', { name: 'Field of filter 1' }).textContent).toBe(
      'Service interest',
    );
    await user.click(within(rows).getByRole('combobox', { name: 'Value of filter 1' }));
    await user.click(await screen.findByRole('option', { name: 'DJ' }));
    await save(user);
    expect(saved).toHaveBeenCalledWith(
      'form.submitted',
      { form: 'form_enquiry' },
      {
        label: undefined,
        condition: { field: 'trigger.answers.service_interest', operator: 'equals', value: 'dj' },
      },
    );
  });

  it('names a draft form as a draft, in its own words, and can still be saved', async () => {
    const { saved, user } = open(
      { form: 'form_wedding' },
      { client, problems: { form: 'There\'s no form "form_wedding".' } },
    );
    const dialog = await panel();
    expect(await within(dialog).findByRole('button', { name: 'Form: Wedding demo' })).toBeDefined();
    expect(
      within(dialog).getByText('This form is a draft. Publish it to receive submissions.'),
    ).toBeDefined();
    // The checks' "no such form" is not said of a form that exists.
    expect(within(dialog).queryByText(/There's no form/)).toBeNull();
    expect(within(dialog).queryByText(/not found/)).toBeNull();
    // A draft is offered with its mark; an archived form is not offered.
    await user.click(within(dialog).getByRole('button', { name: 'Form: Wedding demo' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Any form',
      'Event enquiry',
      'Wedding demoDraft',
    ]);
    await user.keyboard('{Escape}');
    await save(user);
    expect(saved).toHaveBeenCalledWith(
      'form.submitted',
      { form: 'form_wedding' },
      { label: undefined, condition: undefined },
    );
  });

  it('tells a form that is gone from an archived one, and shows what the checks said of it', async () => {
    const gone = open(
      { form: 'form_elsewhere' },
      { client, problems: { form: 'There\'s no form "form_elsewhere".' } },
    );
    let dialog = await panel();
    expect(
      await within(dialog).findByText(
        'This business has no form with this name or ID. Choose another form.',
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Form: form_elsewhere (not found)' }),
    ).toBeDefined();
    // Choosing any form clears it.
    await gone.user.click(
      within(dialog).getByRole('button', { name: 'Form: form_elsewhere (not found)' }),
    );
    await gone.user.click(await screen.findByRole('option', { name: 'Any form' }));
    await waitFor(() => {
      expect(within(dialog).queryByText(/no form with this name/)).toBeNull();
    });
    cleanup();

    open({ form: 'form_2019' }, { client });
    dialog = await panel();
    expect(
      await within(dialog).findByText(
        'This form is archived. Restore and publish it to receive submissions.',
      ),
    ).toBeDefined();
    expect(
      within(dialog).getByRole('button', { name: 'Form: Open day 2019 (archived)' }),
    ).toBeDefined();
  });
});
