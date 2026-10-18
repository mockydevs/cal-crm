// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Combobox, ComboboxMenu, type ComboboxMenuOption, type ComboboxOption } from './combobox';
import { Field, FieldDescription, FieldError, FieldLabel } from './field';
import { Form } from './form';

afterEach(cleanup);

const zones: readonly ComboboxOption[] = [
  { value: 'Africa/Nairobi', label: 'Africa/Nairobi', detail: 'GMT+3 · East Africa Time' },
  { value: 'America/New_York', label: 'America/New York', detail: 'GMT-4 · Eastern Time' },
  { value: 'Europe/London', label: 'Europe/London' },
];

function Picker({
  initial = null,
  onChange = () => undefined,
  errors = {},
  ...props
}: {
  readonly initial?: string | null;
  readonly onChange?: (value: string | null) => void;
  readonly errors?: Record<string, string>;
  readonly disabled?: boolean;
  readonly matches?: (option: ComboboxOption, typed: string) => boolean;
}): ReactElement {
  const [value, setValue] = useState(initial);
  return (
    <Form<Record<string, unknown>> errors={errors}>
      <Field name="timeZone">
        <FieldLabel>Time zone</FieldLabel>
        <Combobox
          options={zones}
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          empty="No time zones match."
          clearLabel="Clear time zone"
          placeholder="Search time zones"
          {...props}
        />
        <FieldDescription>Quiet hours follow it.</FieldDescription>
        <FieldError />
      </Field>
      <output data-testid="value">{value ?? 'none'}</output>
    </Form>
  );
}

const box = (): HTMLElement => screen.getByRole('combobox', { name: 'Time zone' });
const optionNames = (): (string | null)[] =>
  screen.getAllByRole('option').map((option) => option.getAttribute('data-value'));

describe('Combobox', () => {
  it("is a combobox named by its field's label and described by its hint, showing the choice", () => {
    render(<Picker initial="America/New_York" />);
    expect(box()).toHaveProperty('value', 'America/New York');
    expect(box().getAttribute('placeholder')).toBe('Search time zones');
    const described = (box().getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('Quiet hours follow it.');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('filters as you type and chooses the highlighted option with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: string | null) => void>();
    render(<Picker onChange={onChange} />);
    await user.click(box());
    const list = await screen.findByRole('listbox');
    expect(optionNames()).toEqual(['Africa/Nairobi', 'America/New_York', 'Europe/London']);
    // The list is outside the form, so a clipping panel can't cut it off.
    expect(list.closest('form')).toBeNull();
    expect(within(list).getByRole('option', { name: /Africa\/Nairobi/ }).textContent).toContain(
      'GMT+3 · East Africa Time',
    );

    await user.keyboard('lon');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Europe/London']);
    });
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('Europe/London');
    expect(box()).toHaveProperty('value', 'Europe/London');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    expect(document.activeElement).toBe(box());
  });

  it('moves through the whole list with the arrow keys when a choice is already made', async () => {
    const user = userEvent.setup();
    render(<Picker initial="Africa/Nairobi" />);
    box().focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    // The chosen option's name is in the box, and still every option is offered.
    expect(optionNames()).toHaveLength(3);
    expect(
      screen.getByRole('option', { name: /Africa\/Nairobi/ }).getAttribute('aria-selected'),
    ).toBe('true');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('America/New_York');
  });

  it('uses the rule it is given to decide what fits', async () => {
    const user = userEvent.setup();
    render(
      <Picker matches={(option, typed) => (option.detail ?? '').toLowerCase().includes(typed)} />,
    );
    await user.click(box());
    await user.keyboard('eastern');
    await waitFor(() => {
      expect(optionNames()).toEqual(['America/New_York']);
    });
  });

  it('says so when nothing fits, and chooses nothing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: string | null) => void>();
    render(<Picker onChange={onChange} />);
    await user.click(box());
    await user.keyboard('atlantis');
    expect(await screen.findByText('No time zones match.')).toBeDefined();
    expect(screen.queryAllByRole('option')).toEqual([]);
    await user.keyboard('{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Escape without changing the choice, and empties with its clear button', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: string | null) => void>();
    render(<Picker initial="Europe/London" onChange={onChange} />);
    await user.click(box());
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(box()).toHaveProperty('value', 'Europe/London');

    await user.click(screen.getByRole('button', { name: 'Clear time zone' }));
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(box()).toHaveProperty('value', '');
    expect(screen.getByTestId('value').textContent).toBe('none');
  });

  it('empties from the keyboard when the text is deleted', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(value: string | null) => void>();
    render(<Picker initial="Europe/London" onChange={onChange} />);
    box().focus();
    await user.keyboard('{Control>}a{/Control}{Backspace}');
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByTestId('value').textContent).toBe('none');
  });

  it("shows the field's error and marks the box invalid", () => {
    render(<Picker errors={{ timeZone: "This isn't a time zone this server knows." }} />);
    expect(screen.getByText("This isn't a time zone this server knows.")).toBeDefined();
    expect(box().getAttribute('aria-invalid')).toBe('true');
  });

  it('takes no input while disabled', async () => {
    const user = userEvent.setup();
    render(<Picker initial="Europe/London" disabled />);
    expect(box()).toHaveProperty('disabled', true);
    await user.click(box());
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

const places: readonly ComboboxMenuOption[] = [
  { value: 'harbor', label: 'Harbor Lights Events', detail: 'harbor-lights-events' },
  { value: 'lakeside', label: 'Lakeside Dental', detail: 'lakeside-dental' },
  { value: 'northwind', label: 'Northwind Weddings', detail: 'northwind-weddings' },
];

function Switcher({ onChoose }: { readonly onChoose: (value: string) => void }): ReactElement {
  return (
    <ComboboxMenu
      label="Business: Harbor Lights Events"
      options={places}
      value="harbor"
      onChoose={onChoose}
      searchLabel="Find a business"
      empty="No businesses match."
    >
      Harbor Lights Events
    </ComboboxMenu>
  );
}

describe('ComboboxMenu', () => {
  it('opens from its button with the keyboard in the search box, the current option marked', async () => {
    render(<Switcher onChoose={() => undefined} />);
    const button = screen.getByRole('combobox', { name: 'Business: Harbor Lights Events' });
    expect(screen.queryByRole('listbox')).toBeNull();

    await userEvent.click(button);

    // The popup is a dialog named after its search box, which is the combobox of the list.
    expect(await screen.findByRole('dialog', { name: 'Find a business' })).toBeDefined();
    const box = screen.getByRole('combobox', { name: 'Find a business' });
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((option) => option.getAttribute('data-value'))).toEqual([
      'harbor',
      'lakeside',
      'northwind',
    ]);
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    expect(options[1]?.textContent).toBe('Lakeside Dentallakeside-dental');
    for (const option of options) expect(option.className).toContain('min-h-11');
  });

  it('filters as you type, chooses with the keyboard and closes', async () => {
    const chosen = vi.fn();
    render(<Switcher onChoose={chosen} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Business: Harbor Lights Events' }));
    await screen.findByRole('listbox');

    await userEvent.keyboard('north');

    expect(
      screen.getAllByRole('option').map((option) => option.getAttribute('data-value')),
    ).toEqual(['northwind']);
    await userEvent.keyboard('{Enter}');

    expect(chosen.mock.calls).toEqual([['northwind']]);
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
  });

  it('moves through the list with the arrow keys', async () => {
    const chosen = vi.fn();
    render(<Switcher onChoose={chosen} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Business: Harbor Lights Events' }));
    await screen.findByRole('listbox');

    await userEvent.keyboard('{ArrowDown}{Enter}');

    expect(chosen.mock.calls).toEqual([['lakeside']]);
  });

  it('says when nothing fits, and gives the keyboard back to its button on Escape', async () => {
    render(<Switcher onChoose={() => undefined} />);
    const button = screen.getByRole('combobox', { name: 'Business: Harbor Lights Events' });
    await userEvent.click(button);
    await screen.findByRole('listbox');

    await userEvent.keyboard('zzz');
    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('No businesses match.')).toBeDefined();

    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });
});
