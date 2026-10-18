// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu';

afterEach(cleanup);

/** A menu of two places, as the business switcher has; `inside` puts its popup there. */
function Places({ inside = false }: { readonly inside?: boolean }): ReactElement {
  const bannerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={bannerRef} data-testid="banner">
      <DropdownMenu>
        <DropdownMenuTrigger>Business</DropdownMenuTrigger>
        <DropdownMenuContent {...(inside ? { container: bannerRef } : {})} className="w-72">
          <DropdownMenuLinkItem href="#agency">All businesses</DropdownMenuLinkItem>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Businesses</DropdownMenuLabel>
            <DropdownMenuLinkItem href="#harbor">Harbor Lights Events</DropdownMenuLinkItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

describe('DropdownMenu', () => {
  it('opens from its button, with each place a link at least 40px tall', async () => {
    render(<Places />);
    const button = screen.getByRole('button', { name: 'Business' });
    expect(button).toHaveProperty('ariaExpanded', 'false');

    await userEvent.click(button);

    const menu = await screen.findByRole('menu');
    expect(button).toHaveProperty('ariaExpanded', 'true');
    expect(menu.className).toContain('rounded-card');
    expect(menu.className).toContain('w-72');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'All businesses',
      'Harbor Lights Events',
    ]);
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['#agency', '#harbor']);
    for (const item of items) expect(item.className).toContain('min-h-10');
    expect(within(menu).getByText('Businesses').className).toContain('text-muted-foreground');
    expect(within(menu).getByRole('separator').className).toContain('bg-border');
  });

  it('closes on Escape, giving the focus back to its button', async () => {
    render(<Places />);
    const button = screen.getByRole('button', { name: 'Business' });
    await userEvent.click(button);
    await screen.findByRole('menu');

    await userEvent.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(document.activeElement).toBe(button);
    expect(button).toHaveProperty('ariaExpanded', 'false');
  });

  it('closes once a link is followed', async () => {
    render(<Places />);
    await userEvent.click(screen.getByRole('button', { name: 'Business' }));

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Harbor Lights Events' }));

    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
    expect(window.location.hash).toBe('#harbor');
  });

  it('does what an action says and closes, as tall as a link', async () => {
    const leave = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Your account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onClick={leave}>Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Your account' }));
    const item = await screen.findByRole('menuitem', { name: 'Sign out' });
    expect(item.className).toContain('min-h-10');
    expect(item.className).toContain('lg:min-h-9');

    await userEvent.click(item);

    expect(leave).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  it('leaves a disabled action alone', async () => {
    const leave = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Your account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled onClick={leave}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Your account' }));

    await userEvent.click(await screen.findByRole('menuitem', { name: 'Sign out' }));

    expect(leave).not.toHaveBeenCalled();
    expect(screen.getByRole('menu')).toBeDefined();
  });

  it('opens in the element it is given, such as one in its landmark', async () => {
    render(<Places inside />);
    await userEvent.click(screen.getByRole('button', { name: 'Business' }));

    expect(screen.getByTestId('banner').contains(await screen.findByRole('menu'))).toBe(true);
  });

  it('opens at the end of the page otherwise', async () => {
    render(<Places />);
    await userEvent.click(screen.getByRole('button', { name: 'Business' }));

    expect(screen.getByTestId('banner').contains(await screen.findByRole('menu'))).toBe(false);
  });
});
