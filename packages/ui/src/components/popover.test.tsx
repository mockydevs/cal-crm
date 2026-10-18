// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from './popover';

afterEach(cleanup);

/** A small panel of controls opened from a button, as a list's Sort is. */
function Sort(): ReactElement {
  return (
    <Popover>
      <PopoverTrigger>Sort</PopoverTrigger>
      <PopoverContent className="w-72">
        <PopoverTitle>Sort by</PopoverTitle>
        <button type="button">Clear</button>
      </PopoverContent>
    </Popover>
  );
}

describe('Popover', () => {
  it('opens from its button as a named panel on the card colours', async () => {
    render(<Sort />);
    const button = screen.getByRole('button', { name: 'Sort' });
    expect(button).toHaveProperty('ariaExpanded', 'false');

    await userEvent.click(button);

    const panel = await screen.findByRole('dialog', { name: 'Sort by' });
    expect(button).toHaveProperty('ariaExpanded', 'true');
    expect(panel.className).toContain('rounded-card');
    expect(panel.className).toContain('bg-popover');
    expect(panel.className).toContain('w-72');
    expect(screen.getByText('Sort by').className).toContain('font-medium');
  });

  it('closes on Escape and gives the keyboard back to its button', async () => {
    render(<Sort />);
    const button = screen.getByRole('button', { name: 'Sort' });
    await userEvent.click(button);
    await screen.findByRole('dialog', { name: 'Sort by' });

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(button);
  });
});
