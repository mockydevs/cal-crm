// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import FiltersForm from '../list-filters-form';
import EmailVerificationCell from './list-cell';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const wrap = (element: ReactElement) => render(<I18nProvider i18n={i18n}>{element}</I18nProvider>);

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  control: HTMLElement,
  option: string,
): Promise<void> {
  await user.click(control);
  await user.click(await screen.findByRole('option', { name: option }));
}

function showForm(verification: boolean, value = {}) {
  const apply = vi.fn();
  wrap(
    <FiltersForm
      fields={[]}
      period
      verification={verification}
      value={value}
      onApply={apply}
      onCancel={() => undefined}
    />,
  );
  return { user: userEvent.setup(), apply };
}

describe("the contact list's Email verification filter", () => {
  it('offers the six results as the badge words them, and applies the ones ticked', async () => {
    const { user, apply } = showForm(true);
    const summary = await screen.findByText('Email verification', { selector: 'summary' });
    const group = summary.closest('details');
    if (group === null) throw new Error('The group is not drawn.');
    const ticks = within(group).getAllByRole('checkbox');
    expect(ticks.map((tick) => tick.parentElement?.textContent)).toEqual([
      'Verified',
      'Risky',
      'Invalid',
      'Unknown',
      'Not verified',
      'Excluded',
    ]);
    await user.click(within(group).getByRole('checkbox', { name: 'Invalid' }));
    await user.click(within(group).getByRole('checkbox', { name: 'Risky' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(apply).toHaveBeenCalledWith({
      emailVerification: { operator: 'any_of', values: ['invalid', 'risky'] },
    });
  });

  it('applies is empty, for contacts without an email address, with nothing to tick', async () => {
    const { user, apply } = showForm(true);
    await screen.findByText('Email verification', { selector: 'summary' });
    await choose(
      user,
      screen.getByRole('combobox', { name: 'Email verification is' }),
      'Is empty (no email address)',
    );
    expect(screen.queryByRole('checkbox', { name: 'Verified' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(apply).toHaveBeenCalledWith({
      emailVerification: { operator: 'is_empty', values: [] },
    });
  });

  it('opens with the condition the list has, and keeps it in view whatever the search', async () => {
    const { user } = showForm(true, {
      emailVerification: { operator: 'none_of', values: ['excluded'] },
    });
    await screen.findByText('Email verification', { selector: 'summary' });
    expect(screen.getByRole('combobox', { name: 'Email verification is' }).textContent).toContain(
      'Is none of',
    );
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Excluded' }).checked).toBe(true);
    await user.type(screen.getByRole('searchbox', { name: 'Search field' }), 'created');
    expect(screen.getByText('Email verification', { selector: 'summary' })).toBeDefined();
  });

  it('is found by its name, and is not offered on a list without it', async () => {
    const { user } = showForm(true);
    await user.type(await screen.findByRole('searchbox', { name: 'Search field' }), 'zzz');
    expect(screen.queryByText('Email verification', { selector: 'summary' })).toBeNull();
    expect(screen.getByText('No field matches this search.')).toBeDefined();
    cleanup();
    showForm(false);
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.queryByText('Email verification', { selector: 'summary' })).toBeNull();
  });
});

describe("the contact list's Email verification column", () => {
  it('words each result as the badge does, marking the ones that need a look', () => {
    wrap(
      <>
        <EmailVerificationCell state="valid" />
        <EmailVerificationCell state="invalid" />
        <EmailVerificationCell state="unchecked" />
      </>,
    );
    const verified = screen.getByText('Verified');
    const invalid = screen.getByText('Invalid');
    expect(screen.getByText('Not verified')).toBeDefined();
    expect(invalid.className).not.toBe(verified.className);
  });

  it('shows a dash for a contact without an email address, said in words to a screen reader', () => {
    wrap(<EmailVerificationCell state={null} />);
    expect(screen.getByText('—').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText('No email address').className).toContain('sr-only');
  });
});
