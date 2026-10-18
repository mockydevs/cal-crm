// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import ManageFieldsForm from './manage-fields-form';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

type Key = 'name' | 'email' | 'fld_budget' | 'fld_venue' | 'fld_guests';
const choices = [
  { key: 'name', label: 'Contact name' },
  { key: 'email', label: 'Email' },
  { key: 'fld_budget', label: 'Budget' },
  { key: 'fld_venue', label: 'Venue type', group: 'Event details' },
  { key: 'fld_guests', label: 'Guests', group: 'Event details' },
] as const;
const isField = (key: Key) => key.startsWith('fld_');

function draw(value: readonly Key[], max = 2) {
  const applied = vi.fn<(columns: Key[]) => void>();
  render(
    <I18nProvider i18n={i18n}>
      <ManageFieldsForm<Key>
        choices={choices}
        value={value}
        limit={{ max, applies: isField }}
        onApply={applied}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );
  return applied;
}

describe('Manage fields with custom fields', () => {
  it('offers the fields not shown, the ungrouped first and the rest under their folder', () => {
    draw(['name', 'email']);
    const adding = screen.getByRole('region', { name: 'Add fields' });
    expect(
      within(adding)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['Budget', 'Venue type', 'Guests']);
    const folder = within(adding).getByText('Event details').closest('details');
    expect(folder?.open).toBe(true);
    expect(within(folder ?? adding).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('adds fields in the order ticked, after the columns shown', async () => {
    const applied = draw(['name', 'email']);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Guests' }));
    await user.click(screen.getByRole('checkbox', { name: 'Budget' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(applied).toHaveBeenCalledWith(['name', 'email', 'fld_guests', 'fld_budget']);
  });

  it('stops adding custom fields at the limit until one is taken away', async () => {
    draw(['name', 'fld_budget'], 2);
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Venue type' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Guests' }).disabled).toBe(true);
    expect(
      screen.getByText('The table shows at most 2 custom fields. Take one away to add another.'),
    ).toBeTruthy();
    // Built-in columns are never limited, and a field already shown can be taken away.
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Email' }).disabled).toBe(false);
    await user.click(screen.getByRole('checkbox', { name: 'Budget' }));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Guests' }).disabled).toBe(false);
  });

  it('finds a field in a folder by searching', async () => {
    draw(['name']);
    const user = userEvent.setup();
    await user.type(screen.getByRole('searchbox', { name: 'Search fields' }), 'gue');
    const adding = screen.getByRole('region', { name: 'Add fields' });
    expect(within(adding).getAllByRole('checkbox')).toHaveLength(1);
    expect(within(adding).getByRole('checkbox', { name: 'Guests' })).toBeTruthy();
  });
});
