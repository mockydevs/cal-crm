// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandDialog, type CommandGroup } from './command';

afterEach(cleanup);

interface Place {
  readonly id: string;
  readonly name: string;
}

const places: readonly Place[] = [
  { id: 'contacts', name: 'Contacts' },
  { id: 'deals', name: 'Deals' },
  { id: 'reports', name: 'Reports' },
];

/** A bar over three places, filtered as the app filters them. */
function Bar({
  onSelect,
  onOpenChange = () => undefined,
}: {
  readonly onSelect: (place: Place) => void;
  readonly onOpenChange?: (open: boolean) => void;
}): ReactElement {
  const [typed, setTyped] = useState('');
  const shown = places.filter((place) => place.name.toLowerCase().includes(typed.toLowerCase()));
  const groups: CommandGroup<Place>[] =
    shown.length === 0 ? [] : [{ label: 'Go to', items: shown }];
  return (
    <CommandDialog
      open
      onOpenChange={onOpenChange}
      label="Command bar"
      inputLabel="Search or go to"
      placeholder="Search…"
      value={typed}
      onValueChange={setTyped}
      groups={groups}
      itemKey={(place) => place.id}
      itemText={(place) => place.name}
      renderItem={(place) => place.name}
      onSelect={onSelect}
      empty={`Nothing found for “${typed}”.`}
      hint="Up and down arrows choose, Enter goes, Escape closes."
      closeLabel="Close"
    />
  );
}

describe('CommandDialog', () => {
  it('is a named dialog with the search box focused, its keys described, and its groups', async () => {
    render(<Bar onSelect={() => undefined} />);

    const dialog = screen.getByRole('dialog', { name: 'Command bar' });
    const box = within(dialog).getByRole('combobox', { name: 'Search or go to' });
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });
    const hint = document.getElementById(box.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('Up and down arrows choose, Enter goes, Escape closes.');
    within(dialog).getByRole('group', { name: 'Go to' });
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Contacts', 'Deals', 'Reports']);
  });

  it('follows the highlighted item on Enter: the first, or the one the arrows moved to', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(place: Place) => void>();
    render(<Bar onSelect={onSelect} />);
    const box = screen.getByRole('combobox', { name: 'Search or go to' });
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });

    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onSelect.mock.calls.map(([place]) => place.id)).toEqual(['contacts', 'reports']);
  });

  it('shows what the app found for what is typed, or says nothing was', async () => {
    const user = userEvent.setup();
    render(<Bar onSelect={() => undefined} />);
    const box = screen.getByRole('combobox', { name: 'Search or go to' });

    await user.type(box, 'dea');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Deals']);
    await user.type(box, 'x');
    expect(screen.queryAllByRole('option')).toEqual([]);
    screen.getByText('Nothing found for “deax”.');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Bar onSelect={() => undefined} onOpenChange={onOpenChange} />);
    const box = screen.getByRole('combobox', { name: 'Search or go to' });
    await waitFor(() => {
      expect(document.activeElement).toBe(box);
    });

    await user.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });
});
