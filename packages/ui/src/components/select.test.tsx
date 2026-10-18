// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Field, FieldError, FieldLabel } from './field';
import { Form } from './form';
import { Select } from './select';

afterEach(cleanup);

function Example({
  onSubmit,
  errors = {},
}: {
  readonly onSubmit: (values: Record<string, unknown>) => void;
  readonly errors?: Record<string, string>;
}) {
  return (
    <Form<Record<string, unknown>> onFormSubmit={onSubmit} errors={errors}>
      <Field name="timezone">
        <FieldLabel>Time zone</FieldLabel>
        <Select defaultValue="Europe/London">
          <option value="Africa/Nairobi">Nairobi</option>
          <option value="Europe/London">London</option>
        </Select>
        <FieldError />
      </Field>
      <button type="submit">Save</button>
    </Form>
  );
}

describe('themed Select', () => {
  it('keeps closed-trigger keyboard typeahead working for controlled values', async () => {
    function Controlled() {
      const [value, setValue] = useState('date');
      return (
        <Select aria-label="Order" value={value} onValueChange={setValue}>
          <option value="date">Newest</option>
          <option value="name">Name</option>
        </Select>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Order' });
    trigger.focus();
    await userEvent.keyboard('na');
    expect(trigger.textContent).toBe('Name');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('retains an explicit unavailable choice when async validation removes the old option', async () => {
    function Controlled() {
      const [value, setValue] = useState('');
      const [rejected, setRejected] = useState(false);
      return (
        <>
          <Select aria-label="Assignee" value={value} onValueChange={setValue}>
            <option value="">Unassigned</option>
            {rejected ? (
              <option value="unavailable" disabled>
                Choose a person
              </option>
            ) : (
              <option value="member">Jordan</option>
            )}
          </Select>
          <button
            onClick={() => {
              setRejected(true);
              setValue('unavailable');
            }}
          >
            Reject assignee
          </button>
        </>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Assignee' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Jordan' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reject assignee' }));
    expect(trigger.textContent).toBe('Choose a person');
  });

  it('preserves field labels and submits the chosen value with its field name', async () => {
    const sent: unknown[] = [];
    render(<Example onSubmit={(values) => sent.push(values)} />);
    const trigger = screen.getByRole('combobox', { name: 'Time zone' });
    expect(trigger.textContent).toBe('London');
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Nairobi' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sent).toEqual([{ timezone: 'Africa/Nairobi' }]);
  });

  it('portals its themed list outside a clipping parent and restores focus on Escape', async () => {
    const { container } = render(
      <div style={{ overflow: 'hidden', height: 44 }}>
        <label>
          Outcome
          <Select value="open">
            <option value="open">Open</option>
            <option value="won">Won</option>
          </Select>
        </label>
      </div>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Outcome' });
    await userEvent.click(trigger);
    const list = await screen.findByRole('listbox');
    expect(container.contains(list)).toBe(false);
    expect(screen.getByRole('option', { name: 'Open' }).className).toContain(
      'data-highlighted:bg-accent',
    );
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('supports keyboard selection, controlled updates, empty values and disabled options', async () => {
    function Controlled() {
      const [value, setValue] = useState('');
      return (
        <label>
          Order
          <Select value={value} onValueChange={setValue}>
            <option value="">Default order</option>
            <option value="blocked" disabled>
              Unavailable
            </option>
            <option value="name">Name</option>
          </Select>
        </label>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Order' });
    expect(trigger.textContent).toBe('Default order');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    const list = screen.getByRole('listbox');
    expect(
      within(list).getByRole('option', { name: 'Unavailable' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await userEvent.keyboard('{End}{Enter}');
    expect(trigger.textContent).toBe('Name');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('exposes server errors on the visible control', () => {
    render(<Example onSubmit={() => undefined} errors={{ timezone: 'Choose a time zone.' }} />);
    const trigger = screen.getByRole('combobox', { name: 'Time zone' });
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    const ids = (trigger.getAttribute('aria-describedby') ?? '').split(' ');
    expect(
      ids.some((id) => document.getElementById(id)?.textContent === 'Choose a time zone.'),
    ).toBe(true);
  });

  it('keeps multiple choices selected, and serializes all of them in the form', async () => {
    const sent: unknown[] = [];
    render(
      <Form<Record<string, unknown>> onFormSubmit={(values) => sent.push(values)}>
        <Field name="services">
          <FieldLabel>Services</FieldLabel>
          <Select multiple defaultValue={['photo']}>
            <option value="photo">Photo</option>
            <option value="video">Video</option>
          </Select>
        </Field>
        <button type="submit">Save</button>
      </Form>,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Services' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Video' }));
    expect(screen.getByRole('option', { name: 'Photo' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('option', { name: 'Video' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(sent).toEqual([{ services: ['photo', 'video'] }]);
  });

  it('does not open an empty menu and enables itself when choices arrive', async () => {
    const { rerender } = render(
      <label>
        Pipeline
        <Select value="" disabled={false}>
          {[]}
        </Select>
      </label>,
    );
    expect(screen.getByRole('combobox', { name: 'Pipeline' })).toHaveProperty('disabled', true);
    rerender(
      <label>
        Pipeline
        <Select value="sales">
          <option value="sales">Sales</option>
        </Select>
      </label>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Pipeline' });
    expect(trigger).toHaveProperty('disabled', false);
    await userEvent.click(trigger);
    expect(await screen.findByRole('option', { name: 'Sales' })).toBeDefined();
  });

  it('retains a controlled value until its owner applies the new choice', async () => {
    const chosen: string[] = [];
    const { rerender } = render(
      <Select
        aria-label="Sort"
        value="newest"
        onValueChange={(value) => {
          chosen.push(value);
        }}
      >
        <>
          <option value="newest">Newest</option> <option value="name">Name</option>
        </>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole('option', { name: 'Name' }));
    expect(chosen).toEqual(['name']);
    expect(trigger.textContent).toBe('Newest');
    rerender(
      <Select aria-label="Sort" value="name">
        <option value="name">Name</option>
      </Select>,
    );
    expect(trigger.textContent).toBe('Name');
    rerender(
      <Select aria-label="Sort" value="removed">
        <option value="name">Name</option>
      </Select>,
    );
    expect(trigger.textContent).toBe('—');
  });

  it('selects and clears multiple choices without mutating the controlled array', async () => {
    function Controlled() {
      const [value, setValue] = useState<readonly string[]>(() => Object.freeze([]));
      return (
        <Select aria-label="Services" multiple value={value} onValueChange={setValue}>
          <option value="photo">Photo</option>
          <option value="video">Video</option>
        </Select>
      );
    }
    render(<Controlled />);
    const trigger = screen.getByRole('combobox', { name: 'Services' });
    expect(trigger.textContent).toBe('—');
    await userEvent.click(trigger);
    const photo = await screen.findByRole('option', { name: 'Photo' });
    await userEvent.click(photo);
    expect(trigger.textContent).toBe('Photo');
    await userEvent.click(photo);
    expect(trigger.textContent).toBe('—');
  });

  it('uses the first choice by default and keeps a disabled control unavailable', async () => {
    const { rerender } = render(
      <Select aria-label="Sort">
        <option value="newest">Newest</option>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Sort' }).textContent).toBe('Newest');
    rerender(
      <Select aria-label="Sort" disabled>
        <option value="newest">Newest</option>
      </Select>,
    );
    const trigger = screen.getByRole('combobox', { name: 'Sort' });
    await userEvent.click(trigger);
    expect(trigger).toHaveProperty('disabled', true);
    expect(screen.queryByRole('listbox')).toBeNull();
    rerender(
      <Select key="multiple" aria-label="Sort" multiple>
        <option value="newest">Newest</option>
      </Select>,
    );
    expect(screen.getByRole('combobox', { name: 'Sort' }).textContent).toBe('—');
  });

  it('rejects choices with missing values and non-option elements', () => {
    expect(() =>
      render(
        <Select>
          <option>Missing value</option>
        </Select>,
      ),
    ).toThrow('explicit value');
    expect(() =>
      render(
        <Select>
          <div>Wrong choice element</div>
        </Select>,
      ),
    ).toThrow('must be options');
  });
});
