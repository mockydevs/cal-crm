// @vitest-environment jsdom
// The small controls the record forms share, and the list that puts a merge field into a
// message: each on its own, for what the forms' own tests don't reach.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { catalogOf, recordSetup } from '../e2e/automation-fixtures';
import { FilterEditor } from './automation-filter-editor';
import { emptyRow, type FilterRow } from './automation-filters';
import MergeInsert from './automation-merge-insert';
import {
  AddSelect,
  FieldSelect,
  insertedAt,
  MergeText,
  RowProblem,
  TypedValue,
} from './automation-record-controls';
import { sourceFields, writableFields, type FieldChoice } from './automation-record-rules';
import { SettingsDialog, type AutomationCatalogData } from './automation-step-dialog';
// Read before any test starts, so a test waits on React alone (see the builder's tests).
import './automation-tile';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const wrap = (children: ReactElement): ReactElement => (
  <I18nProvider i18n={i18n}>{children}</I18nProvider>
);
const fields = (): FieldChoice[] => writableFields(recordSetup);
const fieldAt = (path: string): FieldChoice => {
  const found = fields().find((each) => each.path === path);
  if (found === undefined) throw new Error(`No field at ${path}.`);
  return found;
};

describe('putting a merge field into text', () => {
  it('goes where the keyboard is, over what is selected, or at the end', () => {
    expect(insertedAt('Hi  there', '{{a}}', 3, 3)).toEqual({ text: 'Hi {{a}} there', caret: 8 });
    expect(insertedAt('Hi NAME there', '{{a}}', 3, 7)).toEqual({
      text: 'Hi {{a}} there',
      caret: 8,
    });
    expect(insertedAt('Hi', '{{a}}', null, null)).toEqual({ text: 'Hi{{a}}', caret: 7 });
    expect(insertedAt('Hi', '{{a}}', 1, null)).toEqual({ text: 'H{{a}}i', caret: 6 });
    // A place outside the text is the nearest place in it.
    expect(insertedAt('Hi', '{{a}}', 99, 2)).toEqual({ text: 'Hi{{a}}', caret: 7 });
    expect(insertedAt('Hi', '{{a}}', -4, -9)).toEqual({ text: '{{a}}Hi', caret: 5 });
  });

  it('is offered under a message, with the opportunity in hand and the custom values', () => {
    function Message(): ReactElement {
      const [text, setText] = useState('Hello , welcome');
      return wrap(
        <>
          <textarea
            id="message"
            aria-label="Message"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
          <MergeInsert
            setup={recordSetup}
            label="Message"
            targetId="message"
            value={text}
            onChange={setText}
          />
        </>,
      );
    }
    render(<Message />);
    const list = screen.getByRole('combobox', { name: 'Insert a field into: Message' });
    expect(
      within(list)
        .getAllByRole('group')
        .map((group) => group.getAttribute('label')),
    ).toEqual([
      'Contact',
      'Contact custom fields',
      'Contact: Wedding details',
      'Opportunity (found or created in this workflow)',
      'Appointment',
      "This lead's arrival",
      'Attribution (first)',
      'Attribution (latest)',
      'Custom values',
    ]);
    const message = screen.getByLabelText<HTMLTextAreaElement>('Message');
    message.setSelectionRange(6, 6);
    fireEvent.change(list, { target: { value: 'contact.firstName' } });
    expect(message.value).toBe('Hello {{contact.firstName}}, welcome');
    // The keyboard is back in the text, right after what was put in.
    expect(document.activeElement).toBe(message);
    expect(message.selectionStart).toBe(27);
    fireEvent.change(list, { target: { value: 'deal.name' } });
    expect(message.value).toBe('Hello {{contact.firstName}}{{deal.name}}, welcome');
    // Choosing nothing puts nothing in.
    fireEvent.change(list, { target: { value: '' } });
    expect(message.value).toBe('Hello {{contact.firstName}}{{deal.name}}, welcome');
  });

  it('adds to the end when the text has no box to read the keyboard from', () => {
    const changed = vi.fn();
    render(
      wrap(
        <MergeInsert
          setup={recordSetup}
          label="Subject"
          targetId="gone"
          value="Hi "
          onChange={changed}
        />,
      ),
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Insert a field into: Subject' }), {
      target: { value: 'contact.lastName' },
    });
    expect(changed).toHaveBeenCalledWith('Hi {{contact.lastName}}');
  });

  it("is in a message step's own panel, under the text it writes into", async () => {
    const saved = vi.fn();
    render(
      wrap(
        <SettingsDialog
          open
          onOpenChange={() => undefined}
          owner="step"
          presetType="sms.send"
          catalog={catalogOf(recordSetup) as AutomationCatalogData}
          setup={recordSetup}
          onSubmit={saved}
        />,
      ),
    );
    const user = userEvent.setup({ delay: null });
    await user.type(await screen.findByLabelText('Message'), 'Your quote for ');
    fireEvent.change(
      await screen.findByRole('combobox', { name: 'Insert a field into: Message' }),
      {
        target: { value: 'deal.name' },
      },
    );
    await user.click(screen.getByRole('button', { name: 'Save action' }));
    expect(saved.mock.lastCall?.[1]).toEqual({ message: 'Your quote for {{deal.name}}' });
  });
});

describe('a value typed for a field', () => {
  const typed = (field: FieldChoice | undefined, value: string | number | boolean) => {
    const changed = vi.fn();
    render(wrap(<TypedValue label="Value" field={field} value={value} onChange={changed} />));
    return changed;
  };

  it('is yes or no for a yes-or-no field, whatever the draft wrote', () => {
    const changed = typed(fieldAt('contact.custom.newsletter'), 'true');
    const box = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Value' });
    expect(box.value).toBe('true');
    fireEvent.change(box, { target: { value: 'false' } });
    expect(changed).toHaveBeenCalledWith(false);
  });

  it('is one of the choices, by its key, with a choice named by its label found', () => {
    typed(fieldAt('contact.custom.venue'), 'Hall');
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Value' }).value).toBe('hall');
    cleanup();
    typed(fieldAt('contact.custom.venue'), '');
    expect(screen.getByRole('option', { name: 'Choose a value' })).toBeDefined();
    cleanup();
    // A number where a choice goes is shown as what it is.
    typed(fieldAt('contact.custom.venue'), 7);
    expect(screen.getByRole('option', { name: '7 (not found)' })).toBeDefined();
  });

  it('is plain text for a choice with nothing to choose from, and for no field at all', () => {
    const changed = typed({ ...fieldAt('contact.custom.venue'), options: [] }, 'garden');
    fireEvent.change(screen.getByRole('textbox', { name: 'Value' }), { target: { value: 'hall' } });
    expect(changed).toHaveBeenCalledWith('hall');
    cleanup();
    typed(undefined, true);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Value' }).value).toBe('true');
  });

  it('is a date for a date field, showing the day of a date and time', () => {
    const changed = typed(fieldAt('contact.custom.event_date'), '2026-12-01T09:00:00+03:00');
    const box = screen.getByLabelText<HTMLInputElement>('Value');
    expect(box.value).toBe('2026-12-01');
    fireEvent.change(box, { target: { value: '2026-12-02' } });
    expect(changed).toHaveBeenCalledWith('2026-12-02');
    cleanup();
    typed(fieldAt('contact.custom.event_date'), 5);
    expect(screen.getByLabelText<HTMLInputElement>('Value').value).toBe('');
  });
});

describe('the lists of a row', () => {
  it('names nothing chosen, and keeps what was chosen when nothing is picked', () => {
    const changed = vi.fn();
    render(
      wrap(
        <FieldSelect
          label="Field"
          value=""
          fields={fields()}
          blank="Choose a field"
          onChange={changed}
        />,
      ),
    );
    const box = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Field' });
    expect(box.value).toBe('');
    expect(within(box).getByRole('option', { name: 'Choose a field' })).toBeDefined();
    fireEvent.change(box, { target: { value: 'contact.email' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(changed.mock.calls).toEqual([['contact.email']]);
    expect(box.hasAttribute('data-field-control')).toBe(false);
  });

  it('offers what can be added, adds what is chosen, and is gone when nothing is left', () => {
    const added = vi.fn();
    const { rerender } = render(
      wrap(
        <AddSelect
          control
          label="Add filter"
          choices={[{ value: 'status', label: 'Status' }]}
          onAdd={added}
        />,
      ),
    );
    const box = screen.getByRole('combobox', { name: 'Add filter' });
    expect(box.hasAttribute('data-field-control')).toBe(true);
    fireEvent.change(box, { target: { value: 'status' } });
    fireEvent.change(box, { target: { value: '' } });
    expect(added.mock.calls).toEqual([['status']]);
    rerender(wrap(<AddSelect label="Add filter" choices={[]} onAdd={added} />));
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('says nothing under a row that has nothing wrong', () => {
    const { container } = render(
      wrap(
        <>
          <RowProblem>{undefined}</RowProblem>
          <RowProblem>{''}</RowProblem>
          <RowProblem>{null}</RowProblem>
        </>,
      ),
    );
    expect(container.textContent).toBe('');
  });

  it('takes a merge field into a line of text where the keyboard is', async () => {
    function Line(): ReactElement {
      const [text, setText] = useState('Dear ');
      return wrap(
        <MergeText
          label="Name"
          value={text}
          fields={sourceFields(recordSetup, true)}
          onChange={setText}
        />,
      );
    }
    render(<Line />);
    const user = userEvent.setup({ delay: null });
    const box = screen.getByLabelText<HTMLInputElement>('Name');
    await user.type(box, 'X');
    box.setSelectionRange(5, 6);
    fireEvent.change(screen.getByRole('combobox', { name: 'Insert a field into: Name' }), {
      target: { value: 'contact.firstName' },
    });
    expect(box.value).toBe('Dear {{contact.firstName}}');
    expect(document.activeElement).toBe(box);
  });
});

describe('the fields of a condition', () => {
  it("lists the opportunity's under what they are read from, and words a comparison by the field", async () => {
    function Rows(): ReactElement {
      const [rows, setRows] = useState<readonly FilterRow[]>([emptyRow]);
      return wrap(
        <>
          <FilterEditor
            rows={rows}
            setup={recordSetup}
            problems={[]}
            noun="condition"
            onChange={setRows}
          />
          <output aria-label="Rows">{JSON.stringify(rows)}</output>
        </>,
      );
    }
    render(<Rows />);
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('combobox', { name: 'Field of condition 1' }));
    const heading = await screen.findByRole('option', {
      name: 'Opportunity (found or created in this workflow)',
    });
    // The heading is there to read, not to choose.
    expect(
      heading.getAttribute('aria-disabled') ?? heading.getAttribute('data-disabled'),
    ).not.toBeNull();
    // A contact's custom fields in a folder come under it, each by the name it was given.
    const names = screen.getAllByRole('option').map((option) => option.textContent);
    const folder = names.indexOf('Contact: Wedding details');
    expect(names.slice(folder, folder + 3)).toEqual([
      'Contact: Wedding details',
      'Dietary requirements',
      'Number of guests',
    ]);
    expect(names.filter((name) => name === 'Contact: Wedding details')).toHaveLength(1);
    expect(names).toContain('Deposit paid');
    for (const name of [
      'Opportunity name',
      'Pipeline stage',
      'Pipeline',
      'Status',
      'Opportunity value',
      'Opportunity source',
    ])
      expect(screen.getByRole('option', { name })).toBeDefined();
    await user.click(screen.getByRole('option', { name: 'Opportunity source' }));
    await user.click(screen.getByRole('combobox', { name: 'Comparison of condition 1' }));
    expect(await screen.findByRole('option', { name: 'Contains' })).toBeDefined();
    await user.click(screen.getByRole('option', { name: 'Contains' }));
    // What is stored is the operator the engine knows.
    expect(screen.getByLabelText('Rows').textContent).toBe(
      '[{"field":"deal.source","operator":"includes"}]',
    );
    await user.click(screen.getByRole('combobox', { name: 'Field of condition 1' }));
    await user.click(await screen.findByRole('option', { name: 'Tag' }));
    await user.click(screen.getByRole('combobox', { name: 'Comparison of condition 1' }));
    expect(await screen.findByRole('option', { name: 'Includes' })).toBeDefined();
    expect(screen.getByRole('option', { name: 'Does not include' })).toBeDefined();
  });
});
