// @vitest-environment jsdom
// "Update contact" as rows: each way a field can be set, what each writes to the step's
// `fields`, and what stays in sight when a stored value is one rows can't hold.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { automationStepTypes } from '@repo/contracts';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordSetup } from '../e2e/automation-fixtures';
import { ContactFieldChanges } from './automation-contact-fields';
import { today } from './automation-record-rules';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

function show(
  start: Readonly<Record<string, unknown>> = {},
  problems: Readonly<Record<string, string>> = {},
): { saved: () => Readonly<Record<string, unknown>>; user: ReturnType<typeof userEvent.setup> } {
  let latest = start;
  function Harness(): ReactElement {
    const [values, setValues] = useState(start);
    return (
      <I18nProvider i18n={i18n}>
        <ContactFieldChanges
          value={values}
          setup={recordSetup}
          problems={problems}
          onChange={(next) => {
            latest = next;
            setValues(next);
          }}
        />
      </I18nProvider>
    );
  }
  render(<Harness />);
  return { saved: () => latest, user: userEvent.setup({ delay: null }) };
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
/** What the rows hold is what the contract's own schema accepts. */
const accepted = (fields: unknown): boolean =>
  automationStepTypes['contact.update'].config.safeParse({ fields }).success;

describe('the rows of Update contact', () => {
  it('starts with no row, adds the first field, and sets it to a typed value', async () => {
    const { saved, user } = show();
    expect(screen.getByText('No field is set yet. Add the first one.')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(saved()).toEqual({ 'contact.firstName': '' });
    await user.type(screen.getByLabelText('Value, field 1'), 'Grace');
    expect(saved()).toEqual({ 'contact.firstName': 'Grace' });
    // The fields are under their headings, and a field of several choices is not offered.
    const groups = within(box('Field 1')).getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('label'))).toEqual([
      'Contact',
      'Contact custom fields',
      'Contact: Wedding details',
    ]);
    // A field the business named is listed by that name, under its folder.
    expect(
      groups.map((group) =>
        within(group)
          .getAllByRole('option')
          .map((option) => option.textContent),
      )[2],
    ).toEqual(['Dietary requirements', 'Number of guests']);
    expect(within(box('Field 1')).queryByRole('option', { name: 'Services' })).toBeNull();
    expect(accepted(saved())).toBe(true);
  });

  it('types a value as the kind of the field asks', async () => {
    const { saved, user } = show({ 'contact.firstName': 'Grace' });
    choose('Field 1', 'contact.custom.newsletter');
    expect(saved()).toEqual({ 'contact.custom.newsletter': true });
    choose('Value, field 1', 'false');
    expect(saved()).toEqual({ 'contact.custom.newsletter': false });

    choose('Field 1', 'contact.custom.venue');
    expect(saved()).toEqual({ 'contact.custom.venue': 'garden' });
    choose('Value, field 1', 'hall');
    expect(saved()).toEqual({ 'contact.custom.venue': 'hall' });

    choose('Field 1', 'contact.custom.budget');
    expect(saved()).toEqual({ 'contact.custom.budget': 0 });
    type('Value, field 1', '1250.5');
    expect(saved()).toEqual({ 'contact.custom.budget': 1250.5 });
    type('Value, field 1', '');
    expect(saved()).toEqual({ 'contact.custom.budget': '' });

    choose('Field 1', 'contact.custom.event_date');
    expect(saved()).toEqual({ 'contact.custom.event_date': today() });
    type('Value, field 1', '2026-12-01');
    expect(saved()).toEqual({ 'contact.custom.event_date': '2026-12-01' });

    choose('Field 1', 'contact.custom.notes');
    await user.type(screen.getByLabelText('Value, field 1'), 'First line{enter}Second line');
    expect(saved()).toEqual({ 'contact.custom.notes': 'First line\nSecond line' });
    expect(accepted(saved())).toBe(true);
  });

  it('copies another field, the contact’s or the opportunity’s in hand', () => {
    const { saved } = show({ 'contact.custom.lead_source_raw': '' });
    choose('Set to, field 1', 'copy');
    expect(saved()).toEqual({ 'contact.custom.lead_source_raw': '{{contact.firstName}}' });
    choose('Copy from, field 1', 'contact.custom.utm_source');
    expect(saved()).toEqual({ 'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}' });
    const from = box('Copy from, field 1');
    expect(
      within(from)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual([
      'Contact',
      'Contact custom fields',
      'Contact: Wedding details',
      'Opportunity (found or created in this workflow)',
      "This lead's arrival",
      'Attribution (first)',
      'Attribution (latest)',
    ]);
    expect(within(from).getByRole('option', { name: 'Deposit paid' })).toBeDefined();
    // A field is not copied into itself.
    expect(within(from).queryByRole('option', { name: 'Lead source raw' })).toBeNull();
    choose('Copy from, field 1', 'deal.source');
    expect(saved()).toEqual({ 'contact.custom.lead_source_raw': '{{deal.source}}' });
    expect(accepted(saved())).toBe(true);
  });

  it('writes text with merge fields, putting a field in where the keyboard is', async () => {
    const { saved, user } = show({ 'contact.custom.lead_source_raw': 'Ads' });
    choose('Set to, field 1', 'text');
    // Plain text stays what it was: it only gains the list that inserts a field.
    expect(saved()).toEqual({ 'contact.custom.lead_source_raw': 'Ads' });
    const text = screen.getByLabelText<HTMLInputElement>('Text, field 1');
    expect(text.value).toBe('Ads');
    await user.type(text, ' from ');
    choose('Insert a field into: Text, field 1', 'contact.custom.utm_source');
    expect(saved()).toEqual({
      'contact.custom.lead_source_raw': 'Ads from {{contact.custom.utm_source}}',
    });
    expect(document.activeElement).toBe(screen.getByLabelText('Text, field 1'));
    choose('Insert a field into: Text, field 1', 'custom_values.sample_reel_url');
    expect(saved()['contact.custom.lead_source_raw']).toBe(
      'Ads from {{contact.custom.utm_source}}{{custom_values.sample_reel_url}}',
    );
    expect(box('Set to, field 1')).toHaveProperty('value', 'text');
    // A plain value holds no merge field: turned back to one, the row starts again.
    choose('Set to, field 1', 'value');
    expect(saved()).toEqual({ 'contact.custom.lead_source_raw': '' });
  });

  it('turns a copied field into text, and a number into empty text', () => {
    const { saved } = show({
      'contact.custom.lead_source_raw': '{{contact.custom.utm_source}}',
      'contact.custom.budget': 5,
    });
    expect(box('Set to, field 1')).toHaveProperty('value', 'copy');
    choose('Set to, field 1', 'text');
    expect(screen.getByLabelText<HTMLInputElement>('Text, field 1').value).toBe(
      '{{contact.custom.utm_source}}',
    );
    expect(screen.queryByRole('combobox', { name: 'Copy from, field 1' })).toBeNull();
    choose('Set to, field 2', 'text');
    expect(saved()['contact.custom.budget']).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Text, field 2').value).toBe('');
  });

  it('sets a date to now, or to a date moved by days', () => {
    const { saved } = show({ 'contact.custom.first_enquiry': '2026-01-01' });
    choose('Set to, field 1', 'now');
    expect(saved()).toEqual({ 'contact.custom.first_enquiry': { op: 'now' } });
    expect(
      screen.getByText("The moment the action runs, in the workflow's time zone."),
    ).toBeDefined();

    choose('Set to, field 1', 'date_add');
    expect(saved()).toEqual({ 'contact.custom.first_enquiry': { op: 'date_add', days: 1 } });
    type('Days to add, field 1', '365');
    expect(saved()).toEqual({ 'contact.custom.first_enquiry': { op: 'date_add', days: 365 } });
    choose('Count from, field 1', 'date');
    expect(saved()).toEqual({
      'contact.custom.first_enquiry': { op: 'date_add', value: today(), days: 365 },
    });
    type('Date, field 1', '2026-12-01');
    type('Date, field 1', '');
    expect(saved()).toEqual({
      'contact.custom.first_enquiry': { op: 'date_add', value: '2026-12-01', days: 365 },
    });
    choose('Count from, field 1', 'contact.custom.event_date');
    type('Days to add, field 1', '-2');
    expect(saved()).toEqual({
      'contact.custom.first_enquiry': {
        op: 'date_add',
        field: 'contact.custom.event_date',
        days: -2,
      },
    });
    expect(accepted(saved())).toBe(true);
    type('Days to add, field 1', '');
    expect(saved()).toEqual({
      'contact.custom.first_enquiry': { op: 'date_add', field: 'contact.custom.event_date' },
    });
    choose('Count from, field 1', 'now');
    expect(saved()).toEqual({ 'contact.custom.first_enquiry': { op: 'date_add' } });
  });

  it('calculates a number from numbers and number fields', () => {
    const { saved } = show({ 'contact.custom.visits': 0 });
    choose('Set to, field 1', 'math');
    expect(saved()).toEqual({
      'contact.custom.visits': {
        op: 'math',
        left: 'contact.custom.visits',
        operator: '+',
        right: 1,
      },
    });
    choose('Operation, field 1', '*');
    type('Second number, field 1: the number', '2');
    choose('First number, field 1', 'contact.custom.budget');
    expect(saved()).toEqual({
      'contact.custom.visits': {
        op: 'math',
        left: 'contact.custom.budget',
        operator: '*',
        right: 2,
      },
    });
    expect(accepted(saved())).toBe(true);
    choose('First number, field 1', '#');
    type('First number, field 1: the number', '');
    expect(saved()['contact.custom.visits']).toEqual({ op: 'math', operator: '*', right: 2 });
    choose('Second number, field 1', 'contact.custom.visits');
    expect(screen.queryByLabelText('Second number, field 1: the number')).toBeNull();
    // An operation the list lacks changes nothing.
    fireEvent.change(box('Operation, field 1'), { target: { value: '%' } });
    expect(saved()['contact.custom.visits']).toMatchObject({ operator: '*' });
  });

  it('empties a field, and writes only when it is empty', async () => {
    const { saved, user } = show({ 'contact.firstName': 'Grace', 'contact.lastName': 'Hopper' });
    await user.click(screen.getByRole('checkbox', { name: 'Only if empty, field 1' }));
    expect(saved()).toEqual({
      'contact.firstName': { set: 'Grace', onlyIfEmpty: true },
      'contact.lastName': 'Hopper',
    });
    expect(accepted(saved())).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Only if empty, field 1' }));
    choose('Set to, field 2', 'clear');
    expect(saved()).toEqual({ 'contact.firstName': 'Grace', 'contact.lastName': null });
    // Emptying a field is not something to do "only if empty".
    expect(screen.queryByRole('checkbox', { name: 'Only if empty, field 2' })).toBeNull();
    // An email address is replaced, never emptied.
    choose('Field 1', 'contact.email');
    expect(
      within(box('Set to, field 1')).queryByRole('option', { name: 'Empty the field' }),
    ).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove field 2' }));
    expect(saved()).toEqual({ 'contact.email': '' });
  });

  it('offers each field once, and stops adding when every field has a row', async () => {
    const bare = { ...recordSetup, fields: { contact: [], deal: [] } };
    let latest: Readonly<Record<string, unknown>> = {};
    function Harness(): ReactElement {
      const [values, setValues] = useState<Readonly<Record<string, unknown>>>({});
      return (
        <I18nProvider i18n={i18n}>
          <ContactFieldChanges
            value={values}
            setup={bare}
            onChange={(next) => {
              latest = next;
              setValues(next);
            }}
          />
        </I18nProvider>
      );
    }
    render(<Harness />);
    const user = userEvent.setup({ delay: null });
    for (let added = 0; added < 4; added += 1)
      await user.click(screen.getByRole('button', { name: 'Add field' }));
    expect(Object.keys(latest)).toEqual([
      'contact.firstName',
      'contact.lastName',
      'contact.email',
      'contact.phone',
    ]);
    expect(
      within(box('Field 2'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Last name']);
    expect(screen.getByRole('button', { name: 'Add field' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Every field the action can set has a row.')).toBeDefined();
    // A choice the list lacks changes nothing.
    fireEvent.change(box('Field 2'), { target: { value: 'contact.shoe_size' } });
    fireEvent.change(box('Set to, field 2'), { target: { value: 'math' } });
    expect(Object.keys(latest)).toHaveLength(4);
  });
});

describe('what the rows keep in sight', () => {
  it('says what the checks found under the row of the field it is about', () => {
    show(
      { 'contact.firstName': 'Grace', 'contact.custom.budget': 'lots' },
      { 'contact.custom.budget': 'contact.custom.budget holds numbers; compare it with a number.' },
    );
    const rows = screen.getAllByRole('listitem');
    expect(within(at(rows, 0)).queryByText(/holds numbers/)).toBeNull();
    expect(within(at(rows, 1)).getByText(/holds numbers/)).toBeDefined();
    expect(box('Field 2').getAttribute('aria-invalid')).toBe('true');
    // Text a number field holds is shown as it is, never hidden behind an empty number box.
    expect(screen.getByLabelText<HTMLInputElement>('Value, field 2').value).toBe('lots');
  });

  it('keeps a field the business lacks, and a value rows cannot hold, as they are written', async () => {
    const odd = {
      op: 'date_add',
      field: 'contact.custom.event_date',
      value: '2026-12-01',
      days: 1,
    };
    const { saved, user } = show({
      'contact.custom.retired': 'Keep this',
      'contact.custom.event_date': odd,
      'contact.custom.first_enquiry': { op: 'date_add', field: 'contact.custom.gone', days: 2 },
      'contact.custom.visits': { op: 'math', left: 'contact.custom.gone', operator: '+', right: 1 },
      'contact.custom.venue': 'marquee',
      'contact.custom.lead_source_raw': '{{contact.custom.gone}}',
    });
    expect(
      within(box('Field 1')).getByRole('option', { name: 'contact.custom.retired (not found)' }),
    ).toBeDefined();
    expect(box('Set to, field 2')).toHaveProperty('value', 'other');
    expect(
      screen.getByText('This value is kept as it is written. Edit it in the JSON view.'),
    ).toBeDefined();
    expect(
      within(box('Count from, field 3')).getByRole('option', {
        name: 'contact.custom.gone (not found)',
      }),
    ).toBeDefined();
    expect(
      within(box('First number, field 4')).getByRole('option', {
        name: 'contact.custom.gone (not found)',
      }),
    ).toBeDefined();
    expect(
      within(box('Value, field 5')).getByRole('option', { name: 'marquee (not found)' }),
    ).toBeDefined();
    expect(
      within(box('Copy from, field 6')).getByRole('option', {
        name: 'contact.custom.gone (not found)',
      }),
    ).toBeDefined();
    await user.click(screen.getByRole('checkbox', { name: 'Only if empty, field 2' }));
    expect(saved()['contact.custom.event_date']).toEqual({ set: odd, onlyIfEmpty: true });
    expect(saved()['contact.custom.retired']).toBe('Keep this');
  });

  it.each([null, [], 'invalid saved setting', 7])(
    'refuses to replace an unavailable saved setting %#',
    (value) => {
      const onChange = vi.fn();
      render(
        <I18nProvider i18n={i18n}>
          <ContactFieldChanges value={value} setup={recordSetup} onChange={onChange} />
        </I18nProvider>,
      );
      expect(screen.getByRole('alert').textContent).toBe(
        'This saved setting is unavailable. Its value will be kept.',
      );
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(onChange).not.toHaveBeenCalled();
    },
  );
});
