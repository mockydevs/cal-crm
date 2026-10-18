// @vitest-environment jsdom
// Assign owner, Find opportunity, Update opportunity and Update contact, through the step
// panel itself: what each form asks, what it saves (always something the contract's own
// schema accepts), and where what the checks found is said.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { automationStepTypes, type AutomationSetup } from '@repo/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, recordSetup } from '../e2e/automation-fixtures';
import { today } from './automation-record-rules';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';
// Read before any test starts, so a test waits on React alone (see the builder's tests).
import './automation-contact-fields';
import './automation-merge-insert';
import './automation-record-fields';
import './automation-tile';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

type StepType = 'owner.assign' | 'deal.find' | 'deal.update' | 'contact.update' | 'deal.move';

function open(
  type: StepType,
  stored?: {
    readonly config: Record<string, unknown>;
    readonly problems?: Record<string, string>;
  },
  setup: AutomationSetup = recordSetup,
) {
  const saved = vi.fn();
  render(
    <I18nProvider i18n={i18n}>
      <SettingsDialog
        open
        onOpenChange={() => undefined}
        owner="step"
        {...(stored === undefined
          ? { presetType: type }
          : {
              editing: { key: 'step:one', type, config: stored.config, problems: stored.problems },
            })}
        catalog={catalogOf(setup) as AutomationCatalogData}
        setup={setup}
        onSubmit={saved}
        onEditInJson={() => undefined}
      />
    </I18nProvider>,
  );
  const user = userEvent.setup({ delay: null });
  return {
    user,
    saved,
    save: async (): Promise<Record<string, unknown> | undefined> => {
      await user.click(screen.getByRole('button', { name: 'Save action' }));
      const config = saved.mock.lastCall?.[1] as Record<string, unknown> | undefined;
      // Whatever a form saves is something the contract's own schema accepts.
      if (config !== undefined)
        expect(automationStepTypes[type].config.safeParse(config).success).toBe(true);
      return config;
    },
  };
}

/** A row a test expects to be there. */
const at = (rows: readonly HTMLElement[], index: number): HTMLElement => {
  const row = rows[index];
  if (row === undefined) throw new Error(`There is no row ${String(index + 1)}.`);
  return row;
};
const box = (name: string): HTMLElement => screen.getByRole('combobox', { name });
const choose = (name: string, value: string): void => {
  fireEvent.change(box(name), { target: { value } });
};
const type = (name: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
};

describe('Assign owner', () => {
  it('assigns to one team member, found by searching', async () => {
    const { user, saved, save } = open('owner.assign');
    const search = await screen.findByRole('searchbox', { name: 'Search team members' });
    expect(screen.getByText('Nobody chosen yet.')).toBeDefined();
    expect(
      screen.getByText('With several, each contact goes to the next person in turn.'),
    ).toBeDefined();
    // Nothing chosen is said, and nothing is saved.
    await save();
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByText('Choose at least one team member.')).toBeDefined();
    expect(document.activeElement).toBe(search);

    await user.type(search, 'chr');
    expect(
      screen.getAllByRole('checkbox').map((each) => each.closest('label')?.textContent),
    ).toEqual(['Chris Marino']);
    await user.click(screen.getByRole('checkbox', { name: 'Chris Marino' }));
    expect(screen.getByText('1 chosen: every contact goes to them.')).toBeDefined();
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No team member matches.')).toBeDefined();
    expect(await save()).toEqual({ user: 'usr_chris' });
  });

  it('assigns in turn to several, only to unassigned contacts, and takes one off again', async () => {
    const { user, save } = open('owner.assign');
    await user.click(await screen.findByRole('checkbox', { name: 'Sam Okoye' }));
    await user.click(screen.getByRole('checkbox', { name: 'Dana Brooks' }));
    await user.click(screen.getByRole('checkbox', { name: 'Chris Marino' }));
    expect(
      screen.getByText('3 chosen: each contact goes to the next of them in turn.'),
    ).toBeDefined();
    // The chips are in the order they take turns: the order they were ticked.
    const chips = within(screen.getByRole('list', { name: 'Chosen team members' })).getAllByRole(
      'listitem',
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      '1. Sam Okoye',
      '2. Dana Brooks',
      '3. Chris Marino',
    ]);
    const only = screen.getByRole('switch', { name: 'Only apply to unassigned contacts' });
    expect(screen.getByText('A contact that already has an owner gets the new one.')).toBeDefined();
    await user.click(only);
    expect(screen.getByText('A contact that already has an owner keeps them.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove Dana Brooks' }));
    expect(await save()).toEqual({ users: ['usr_sam', 'usr_chris'], onlyIfUnassigned: true });
  });

  it('opens a saved step on who it names, a member the team lacks among them, and what the checks said', async () => {
    const { user, save } = open('owner.assign', {
      config: { users: ['Dana Brooks', 'usr_gone'], onlyIfUnassigned: true },
      problems: { 'users/1': 'usr_gone is not a team member of this business.' },
    });
    expect(
      await screen.findByText('usr_gone is not a team member of this business.'),
    ).toBeDefined();
    expect(
      screen.getByRole('switch', { name: 'Only apply to unassigned contacts' }),
    ).toHaveProperty('ariaChecked', 'true');
    const chips = within(screen.getByRole('list', { name: 'Chosen team members' })).getAllByRole(
      'listitem',
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      '1. Dana Brooks',
      '2. usr_gone (not found)',
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove usr_gone (not found)' }));
    await user.click(screen.getByRole('switch', { name: 'Only apply to unassigned contacts' }));
    // One member left is written as the one new owner; the tick is left out again.
    expect(await save()).toEqual({ user: 'usr_dana' });
  });

  it('stops at twenty, the most the contract lets one action share between', async () => {
    const many = Array.from({ length: 21 }, (_, index) => ({
      id: `usr_${String(index)}`,
      name: `Member ${String(index)}`,
    }));
    open(
      'owner.assign',
      { config: { users: many.slice(0, 20).map((each) => each.id) } },
      { ...recordSetup, users: many },
    );
    expect(
      await screen.findByText(
        'You have chosen 20, the most one action can share contacts between.',
      ),
    ).toBeDefined();
    expect(screen.getByRole('checkbox', { name: 'Member 20' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('checkbox', { name: 'Member 3' })).toHaveProperty('disabled', false);
  });

  it('says so when the business has no team members', async () => {
    open('owner.assign', undefined, { ...recordSetup, users: [] });
    expect(await screen.findByText('This business has no team members yet.')).toBeDefined();
  });
});

describe('Find opportunity', () => {
  it('finds the most recent with no filter, and adds each filter once', async () => {
    const { save } = open('deal.find');
    expect(
      await screen.findByText("No filter: any of the contact's opportunities can be found."),
    ).toBeDefined();
    const add = (): string[] =>
      within(box('Add filter'))
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(add()).toEqual([
      '+ Add filter',
      'Pipeline',
      'Pipeline stage',
      'Status',
      'Opportunity name',
      'Opportunity value',
      'Custom field',
    ]);
    choose('Add filter', 'pipeline');
    choose('Add filter', 'status');
    expect(add()).toEqual([
      '+ Add filter',
      'Pipeline stage',
      'Opportunity name',
      'Opportunity value',
      'Custom field',
    ]);
    choose('Status is', 'won');
    expect(await save()).toEqual({ pipeline: 'pip_sales', status: 'won' });
  });

  it('filters on stage, name, value and a custom field, and takes a filter away', async () => {
    const { user, save } = open('deal.find', { config: { which: 'oldest' } });
    await screen.findByRole('combobox', { name: 'Add filter' });
    for (const kind of ['stage', 'nameContains', 'value', 'customField'])
      choose('Add filter', kind);
    choose('Pipeline stage is', 'stg_quoted');
    type('Opportunity name contains', 'Wedding');
    choose('Opportunity value comparison', 'less_than');
    type('Opportunity value to compare with', '5000');
    choose('Custom field to compare', 'deal.custom.guests');
    type('Custom field equals', '120');
    // Every filter is in use: there is none left to add.
    choose('Add filter', 'pipeline');
    choose('Add filter', 'status');
    expect(screen.queryByRole('combobox', { name: 'Add filter' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove the filter: Status' }));
    await user.click(screen.getByRole('button', { name: 'Remove the filter: Pipeline' }));
    expect(await save()).toEqual({
      which: 'oldest',
      stage: 'stg_quoted',
      nameContains: 'Wedding',
      value: { operator: 'less_than', value: 5000 },
      customField: { field: 'deal.custom.guests', equals: 120 },
    });
  });

  it('keeps a filter being typed in sight while it is empty, and leaves it out of what is saved', async () => {
    const { user, save } = open('deal.find');
    choose('Add filter', 'nameContains');
    choose('Add filter', 'value');
    type('Opportunity value to compare with', '');
    expect(screen.getByLabelText('Opportunity name contains')).toBeDefined();
    // An unknown choice adds nothing.
    fireEvent.change(box('Add filter'), { target: { value: 'colour' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Remove the filter: Opportunity value' }));
    expect(await save()).toEqual({});
  });

  it('opens a saved step on its filters, what the business lacks, and what the checks said', async () => {
    open('deal.find', {
      config: {
        pipeline: 'pip_gone',
        stage: 'stg_quoted',
        status: 'lost',
        value: 'high',
        customField: 7,
      },
      problems: {
        pipeline: 'pip_gone is not a pipeline of this business.',
        nameContains: 'Too long.',
        'customField/field': 'deal.custom.gone is not a field.',
      },
    });
    expect(await screen.findByText('pip_gone is not a pipeline of this business.')).toBeDefined();
    expect(
      within(box('Pipeline is')).getByRole('option', { name: 'pip_gone (not found)' }),
    ).toBeDefined();
    expect(box('Pipeline is').getAttribute('aria-invalid')).toBe('true');
    // With no pipeline the business has, the stages of every pipeline are offered.
    expect(box('Pipeline stage is')).toHaveProperty('value', 'stg_quoted');
    expect(
      within(box('Pipeline stage is')).getByRole('option', { name: 'Sales · Quoted' }),
    ).toBeDefined();
    expect(box('Status is')).toHaveProperty('value', 'lost');
    expect(
      screen.getAllByText('This value is kept as it is written. Edit it in the JSON view.'),
    ).toHaveLength(2);
    expect(screen.getByText('deal.custom.gone is not a field.')).toBeDefined();
    // What was said of a filter that has no row is still said.
    expect(screen.getByText('Too long.')).toBeDefined();
  });

  it('offers no pipeline, stage or custom-field filter to a business that has none', async () => {
    open('deal.find', undefined, {
      ...recordSetup,
      pipelines: [],
      fields: { contact: [], deal: [] },
    });
    const add = await screen.findByRole('combobox', { name: 'Add filter' });
    expect(
      within(add)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['+ Add filter', 'Status', 'Opportunity name', 'Opportunity value']);
  });

  it('compares a custom field as its kind asks, and starts again when the field changes', async () => {
    const { save } = open('deal.find', {
      config: {
        customField: { field: 'deal.custom.gone', equals: 'x' },
        value: { operator: 'equals' },
      },
    });
    await screen.findByRole('combobox', { name: 'Custom field to compare' });
    expect(
      within(box('Custom field to compare')).getByRole('option', {
        name: 'deal.custom.gone (not found)',
      }),
    ).toBeDefined();
    choose('Custom field to compare', 'deal.custom.service');
    type('Custom field equals', 'video');
    type('Opportunity value to compare with', '250');
    expect(await save()).toEqual({
      customField: { field: 'deal.custom.service', equals: 'video' },
      value: { operator: 'equals', value: 250 },
    });
  });
});

describe('Update opportunity', () => {
  it('says which opportunity it acts on, and asks for at least one field', async () => {
    const { saved, save } = open('deal.update');
    expect(
      await screen.findByText(
        "Acts on the opportunity found or created earlier in this workflow; otherwise the contact's one open opportunity.",
      ),
    ).toBeDefined();
    expect(screen.getByText('Nothing is changed yet. Add the first field.')).toBeDefined();
    await save();
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByText('Add at least one field to change.')).toBeDefined();
    expect(document.activeElement).toBe(box('Add field'));
  });

  it('changes the name, value, owner, close date, source and status, each as a row', async () => {
    const { user, save } = open('deal.update');
    await screen.findByRole('combobox', { name: 'Add field' });
    for (const kind of ['name', 'value', 'owner', 'expectedCloseDate', 'source', 'status'])
      choose('Add field', kind);
    await user.type(screen.getByLabelText('Opportunity name is set to'), 'Renewal for ');
    choose('Insert a field into: Opportunity name is set to', 'contact.firstName');
    type('Opportunity value, the number', '900');
    choose('Owner is set to', 'usr_chris');
    type('Expected close date, how many', '2');
    choose('Expected close date, days or weeks', 'weeks');
    // A source starts as how the lead arrived; text is one of its other two choices.
    expect(box('Source is set to')).toHaveProperty('value', 'arrival');
    choose('Source is set to', 'text');
    type('Source is set to, the text', 'Referral');
    expect(
      screen.getByText(/^Reopen: an opportunity that was won or lost becomes open again\./),
    ).toBeDefined();
    expect(await save()).toEqual({
      name: 'Renewal for {{contact.firstName}}',
      amount: 900,
      owner: 'usr_chris',
      expectedCloseDate: { in: 'P2W' },
      source: 'Referral',
      status: 'open',
    });
  });

  it('takes the value from a contact number field or removes it, and sets or removes the owner and the date', async () => {
    const { user, save } = open('deal.update', {
      config: { amount: 900, owner: 'usr_dana', expectedCloseDate: '2026-12-01' },
    });
    await screen.findByRole('combobox', { name: 'Opportunity value is set to' });
    choose('Opportunity value is set to', 'field');
    expect(box('Opportunity value, the contact field')).toHaveProperty(
      'value',
      'contact.custom.budget',
    );
    choose('Opportunity value, the contact field', 'contact.custom.visits');
    choose('Owner is set to', '');
    type('Expected close date, the date', '2027-01-15');
    type('Expected close date, the date', '');
    expect(await save()).toEqual({
      amountFrom: 'contact.custom.visits',
      owner: null,
      expectedCloseDate: '2027-01-15',
    });

    choose('Opportunity value is set to', 'none');
    choose('Expected close date is set to', 'none');
    expect(await save()).toEqual({ amount: null, owner: null, expectedCloseDate: null });

    choose('Opportunity value is set to', 'number');
    choose('Expected close date is set to', 'date');
    expect(await save()).toEqual({ amount: 0, owner: null, expectedCloseDate: today() });
    choose('Expected close date is set to', 'in');
    type('Expected close date, how many', '');
    type('Expected close date, how many', '45');
    choose('Expected close date, days or weeks', 'days');
    // An emptied value keeps its row, to be typed into.
    type('Opportunity value, the number', '');
    type('Opportunity value, the number', '');
    expect(screen.getByLabelText('Opportunity value, the number')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove the change: Opportunity value' }));
    await user.click(screen.getByRole('button', { name: 'Remove the change: Owner' }));
    expect(await save()).toEqual({ expectedCloseDate: { in: 'P45D' } });
  });

  it("sets and empties the opportunity's custom fields, each once", async () => {
    const { user, save } = open('deal.update');
    const add = await screen.findByRole('combobox', { name: 'Add field' });
    expect(within(add).getByRole('option', { name: 'Status: reopen' })).toBeDefined();
    choose('Add field', 'field:deal.custom.service');
    choose('Add field', 'field:deal.custom.guests');
    expect(within(box('Add field')).queryByRole('option', { name: 'Service' })).toBeNull();
    type('Service is set to', 'video');
    type('Guests is set to', '120');
    await user.click(screen.getByRole('checkbox', { name: 'Empty it: Service' }));
    expect(screen.queryByLabelText('Service is set to')).toBeNull();
    expect(await save()).toEqual({
      fields: { 'deal.custom.service': null, 'deal.custom.guests': 120 },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Empty it: Service' }));
    await user.click(screen.getByRole('button', { name: 'Remove the change: Guests' }));
    expect(await save()).toEqual({ fields: { 'deal.custom.service': '' } });
    await user.click(screen.getByRole('button', { name: 'Remove the change: Service' }));
    choose('Add field', 'status');
    // An unknown choice adds nothing.
    fireEvent.change(box('Add field'), { target: { value: 'colour' } });
    expect(await save()).toEqual({ status: 'open' });
  });

  it('opens a saved step on what it changes, keeps what rows cannot hold, and says what the checks said', async () => {
    open('deal.update', {
      config: {
        name: null,
        source: 'Referral',
        owner: 'usr_gone',
        amountFrom: 'contact.custom.gone',
        expectedCloseDate: { in: 'P1M' },
        fields: { 'deal.custom.gone': ['a'], 'deal.custom.service': 'video' },
      },
      problems: {
        amountFrom: 'contact.custom.gone is not a field.',
        'fields/deal.custom.gone': 'deal.custom.gone is not a field.',
        status: 'Reopen is refused here.',
        fields: 'Expected an object.',
      },
    });
    expect(await screen.findByText('contact.custom.gone is not a field.')).toBeDefined();
    expect(
      within(box('Owner is set to')).getByRole('option', { name: 'usr_gone (not found)' }),
    ).toBeDefined();
    expect(
      within(box('Opportunity value, the contact field')).getByRole('option', {
        name: 'contact.custom.gone (not found)',
      }),
    ).toBeDefined();
    // The name set to nothing, a length of time in months, and a list: kept as written.
    expect(
      screen.getAllByText('This value is kept as it is written. Edit it in the JSON view.'),
    ).toHaveLength(3);
    expect(screen.getByText('deal.custom.gone is not a field.')).toBeDefined();
    expect(screen.getByText('Reopen is refused here.')).toBeDefined();
    expect(screen.getByText('Expected an object.')).toBeDefined();
  });

  it("keeps custom fields that aren't an object as they are written", async () => {
    open('deal.update', { config: { name: 'Renewal', fields: 'video' } });
    expect(
      await screen.findByText('This value is kept as it is written. Edit it in the JSON view.'),
    ).toBeDefined();
  });

  it('says which opportunity a Move opportunity step acts on too', async () => {
    open('deal.move');
    expect(
      await screen.findByText(/^Acts on the opportunity found or created earlier/),
    ).toBeDefined();
  });
});

describe('Update contact, in the panel', () => {
  it('asks for a field to set before it can be saved', async () => {
    const { saved, save } = open('contact.update');
    await screen.findByRole('button', { name: 'Add field' });
    await save();
    expect(saved).not.toHaveBeenCalled();
    expect(screen.getByText('Add at least one field to set.')).toBeDefined();
  });

  it('saves a copied field and a field set to now, without writing JSON', async () => {
    const { user, save } = open('contact.update');
    await user.click(await screen.findByRole('button', { name: 'Add field' }));
    choose('Field 1', 'contact.custom.lead_source_raw');
    choose('Set to, field 1', 'copy');
    choose('Copy from, field 1', 'contact.custom.utm_source');
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    choose('Field 2', 'contact.custom.first_enquiry');
    choose('Set to, field 2', 'now');
    await user.click(screen.getByRole('checkbox', { name: 'Only if empty, field 2' }));
    expect(await save()).toEqual({
      fields: {
        'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
        'contact.custom.first_enquiry': { set: { op: 'now' }, onlyIfEmpty: true },
      },
    });
  });

  it("puts the contract's own refusal under the row of the field it is about", async () => {
    const { saved, save } = open('contact.update', {
      config: {
        fields: { 'contact.firstName': 'Sam', 'contact.custom.event_date': { op: 'date_add' } },
      },
      problems: { 'fields/contact.firstName': 'contact.firstName is checked by the server.' },
    });
    expect(await screen.findByText('contact.firstName is checked by the server.')).toBeDefined();
    await save();
    // A date moved by no number of days is not something the contract accepts.
    expect(saved).not.toHaveBeenCalled();
    const rows = within(screen.getByRole('list', { name: 'Fields to set' })).getAllByRole(
      'listitem',
    );
    expect(within(at(rows, 0)).queryByText(/./, { selector: 'p.text-destructive' })).toBeNull();
    expect(within(at(rows, 1)).getByText(/./, { selector: 'p.text-destructive' })).toBeDefined();
    expect(document.activeElement).toBe(box('Field 1'));
    type('Days to add, field 2', '30');
    expect(await save()).toEqual({
      fields: {
        'contact.firstName': 'Sam',
        'contact.custom.event_date': { op: 'date_add', days: 30 },
      },
    });
  });
});
