import type { IntegrationActivity } from '@repo/contracts';
import { describe, expect, it } from 'vitest';

import {
  integrationsWorldOf,
  integrationConnectionId,
  listOf,
} from '../../e2e/integrations-fixtures';
import {
  anyConnecting,
  chipsOf,
  firstCursors,
  guideUrl,
  isConnected,
  lastCheckedOf,
  newestFirst,
  outcomeOf,
  shownOf,
} from './rules';

const { entries } = listOf(integrationsWorldOf());
const textOf = (entry: { readonly name: string; readonly description: string }): string =>
  `${entry.name} ${entry.description}`;
const keys = (list: readonly { readonly key: string }[]): string[] => list.map((each) => each.key);

describe('the chips above the grid', () => {
  it('offers All and Connected, then only the categories that have a card, in order', () => {
    expect(chipsOf(entries)).toEqual([
      'all',
      'connected',
      'calendar_email',
      'phone_messaging',
      'ai',
      'payments_accounting',
      'ecommerce',
      'productivity',
      'forms',
      'developers',
    ]);
    expect(chipsOf([])).toEqual(['all', 'connected']);
  });

  it('counts a connection that needs someone as connected, and one still checking as not', () => {
    const states = new Map(entries.map((each) => [each.key, isConnected(each)]));
    expect(states.get('slack')).toBe(true);
    expect(states.get('quickbooks')).toBe(true);
    expect(states.get('shopify')).toBe(false);
    expect(states.get('typeform')).toBe(false);
  });
});

describe('which cards show', () => {
  it('keeps the order served and filters by chip', () => {
    expect(keys(shownOf(entries, 'all', '', textOf))).toEqual(keys(entries));
    expect(keys(shownOf(entries, 'connected', '', textOf))).toEqual([
      'google_calendar',
      'mailboxes',
      'twilio',
      'quickbooks',
      'xero',
      'slack',
    ]);
    expect(keys(shownOf(entries, 'productivity', '', textOf))).toEqual(['slack', 'notion']);
  });

  it('searches the name and the description, whatever the case, within the chip', () => {
    expect(keys(shownOf(entries, 'all', '  TWILIO ', textOf))).toEqual(['twilio']);
    expect(keys(shownOf(entries, 'all', 'mailbox', textOf))).toEqual(['mailboxes']);
    expect(keys(shownOf(entries, 'developers', 'twilio', textOf))).toEqual([]);
  });
});

describe('the rest of what the page works out', () => {
  it('links an operator guide to the project’s docs on GitHub', () => {
    expect(guideUrl('docs/HOSTING.md#51-what-you-set')).toBe(
      'https://github.com/mockydevs/cal-crm/blob/main/docs/HOSTING.md#51-what-you-set',
    );
    expect(guideUrl('/docs/HOSTING.md')).toBe(
      'https://github.com/mockydevs/cal-crm/blob/main/docs/HOSTING.md',
    );
  });

  it('reads only the outcomes the callback sends', () => {
    expect(outcomeOf('connected')).toBe('connected');
    expect(outcomeOf('scopes_missing')).toBe('scopes_missing');
    expect(outcomeOf('hacked')).toBeUndefined();
    expect(outcomeOf(undefined)).toBeUndefined();
  });

  it('says whether any card is still checking its account', () => {
    expect(anyConnecting(entries)).toBe(true);
    expect(anyConnecting(entries.filter((each) => each.key !== 'shopify'))).toBe(false);
  });

  it('takes the latest check, good or bad', () => {
    const at = (iso: string | null) => ({ lastOkAt: iso, lastErrorAt: null });
    expect(lastCheckedOf(at(null))).toBeNull();
    expect(
      lastCheckedOf({
        lastOkAt: '2026-10-17T09:00:00.000Z',
        lastErrorAt: '2026-10-18T09:00:00.000Z',
      }),
    ).toBe('2026-10-18T09:00:00.000Z');
    expect(
      lastCheckedOf({
        lastOkAt: '2026-10-18T09:00:00.000Z',
        lastErrorAt: '2026-10-17T09:00:00.000Z',
      }),
    ).toBe('2026-10-18T09:00:00.000Z');
  });
});

describe('older activity', () => {
  const one = integrationConnectionId(1);
  const two = integrationConnectionId(2);
  const event = (connectionId: string, at: string): IntegrationActivity => ({
    connectionId,
    at,
    kind: 'check_ok',
    errorCode: null,
    detail: null,
  });

  it('asks each account for what came before the oldest of its own shown', () => {
    const shown = [
      event(one, '2026-10-18T09:00:00.000Z'),
      event(two, '2026-10-17T09:00:00.000Z'),
      event(one, '2026-10-16T09:00:00.000Z'),
    ];
    expect(firstCursors([one, two], shown)).toEqual([
      { connectionId: one, before: '2026-10-16T09:00:00.000Z' },
      { connectionId: two, before: '2026-10-17T09:00:00.000Z' },
    ]);
  });

  it('asks an account with nothing shown from the oldest shown, and nobody when none is', () => {
    const shown = [event(one, '2026-10-18T09:00:00.000Z')];
    expect(firstCursors([one, two], shown)).toEqual([
      { connectionId: one, before: '2026-10-18T09:00:00.000Z' },
      { connectionId: two, before: '2026-10-18T09:00:00.000Z' },
    ]);
    expect(firstCursors([one, two], [])).toEqual([]);
  });

  it('sorts what accounts sent newest first', () => {
    const merged = newestFirst([
      event(one, '2026-10-16T09:00:00.000Z'),
      event(two, '2026-10-18T09:00:00.000Z'),
      event(one, '2026-10-17T09:00:00.000Z'),
    ]);
    expect(merged.map((each) => each.at)).toEqual([
      '2026-10-18T09:00:00.000Z',
      '2026-10-17T09:00:00.000Z',
      '2026-10-16T09:00:00.000Z',
    ]);
  });
});
