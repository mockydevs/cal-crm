// @vitest-environment jsdom
// The Reminders line in a calendar's Notifications: it opens "Appointment reminders" on the
// workflows list with this calendar chosen, and asks a calendar not saved yet to be saved.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { automationsSearch } from './automation-search';
import { RemindersHint } from './calendar-reminders-hint';

// The link as the router would write it: its route, its slug and its search.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    search,
  }: {
    to: string;
    params: { slug: string };
    search: Record<string, string>;
    children: ReactNode;
  }) => (
    <a href={`${to.replace('$slug', params.slug)}?${new URLSearchParams(search).toString()}`}>
      {children}
    </a>
  ),
}));

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const shown = (calendarId: string | undefined) =>
  render(
    <I18nProvider i18n={i18n}>
      <RemindersHint businessSlug="harbor" calendarId={calendarId} className="note" />
    </I18nProvider>,
  );

describe('the reminders line of a calendar', () => {
  it('links to the reminders recipe with the calendar chosen', () => {
    shown('cal_consult');
    expect(screen.getByRole('heading', { name: 'Reminders' })).toBeDefined();
    const link = screen.getByRole('link', { name: 'Create reminder workflow' });
    expect(link.getAttribute('href')).toBe(
      '/b/harbor/automations?recipe=appointment_reminders&calendar=cal_consult',
    );
  });

  it('asks for the calendar to be saved first when it has no id yet', () => {
    shown(undefined);
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByText('Save the calendar first, then create its reminder workflow here.'),
    ).toBeDefined();
  });
});

describe('the address that opens a recipe', () => {
  it('keeps the recipe and a calendar id, and drops anything else', () => {
    const calendar = 'cal_01h455vb4pex5vsknk084sn02q';
    expect(automationsSearch({ recipe: 'appointment_reminders', calendar })).toEqual({
      recipe: 'appointment_reminders',
      calendar,
    });
    expect(automationsSearch({ recipe: 'appointment_reminders', calendar: 'nope' })).toEqual({
      recipe: 'appointment_reminders',
    });
    expect(automationsSearch({ recipe: 'something_else' })).toEqual({});
    // An open workflow or the Deleted list wins over a recipe.
    expect(automationsSearch({ list: 'deleted', recipe: 'appointment_reminders' })).toEqual({
      list: 'deleted',
    });
  });
});
