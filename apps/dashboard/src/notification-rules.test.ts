import { describe, expect, it } from 'vitest';
import { bellCount, notificationPlace, timeAgo } from './notification-rules';

describe('the number on the bell', () => {
  it('is nothing before the count is known and when everything is read', () => {
    expect(bellCount(undefined)).toBeUndefined();
    expect(bellCount({ unread: 0, more: false })).toBeUndefined();
  });

  it('is the count, with a plus when the server stopped counting', () => {
    expect(bellCount({ unread: 3, more: false })).toBe('3');
    expect(bellCount({ unread: 99, more: false })).toBe('99');
    expect(bellCount({ unread: 99, more: true })).toBe('99+');
  });
});

describe('the page a notification opens', () => {
  it('opens the conversation or the workflow it names', () => {
    expect(
      notificationPlace({ kind: 'conversation', id: 'cvn_01k8e2wzr0e008000000000001' }),
    ).toEqual({
      to: '/b/$slug/inbox',
      search: { conversation: 'cvn_01k8e2wzr0e008000000000001' },
    });
    expect(notificationPlace({ kind: 'automation', id: 'aut_01k8e2wzr0e008000000000002' })).toEqual(
      { to: '/b/$slug/automations', search: { automation: 'aut_01k8e2wzr0e008000000000002' } },
    );
  });

  it('opens the list for what has no page of its own', () => {
    expect(notificationPlace({ kind: 'task', id: 'task_01k8e2wzr0e008000000000003' })).toEqual({
      to: '/b/$slug/tasks',
    });
    expect(
      notificationPlace({ kind: 'appointment', id: 'appt_01k8e2wzr0e008000000000004' }),
    ).toEqual({
      to: '/b/$slug/calendar',
      search: { appointment: 'appt_01k8e2wzr0e008000000000004' },
    });
    expect(notificationPlace({ kind: 'form', id: 'form_01k8e2wzr0e008000000000005' })).toEqual({
      to: '/b/$slug/settings/forms',
    });
    expect(notificationPlace({ kind: 'ai_settings' })).toEqual({
      to: '/b/$slug/settings/ai-models',
    });
    expect(notificationPlace({ kind: 'integrations' })).toEqual({
      to: '/b/$slug/settings/integrations',
    });
  });
});

describe('how long ago', () => {
  const now = Date.UTC(2026, 9, 11, 12, 0, 0);
  const at = (msBefore: number): string => new Date(now - msBefore).toISOString();

  it('uses the largest whole unit', () => {
    expect(timeAgo(at(20_000), now, 'en')).toBe('this minute');
    expect(timeAgo(at(5 * 60_000), now, 'en')).toBe('5 minutes ago');
    expect(timeAgo(at(3 * 3_600_000 + 59 * 60_000), now, 'en')).toBe('3 hours ago');
    expect(timeAgo(at(24 * 3_600_000), now, 'en')).toBe('yesterday');
    expect(timeAgo(at(9 * 24 * 3_600_000), now, 'en')).toBe('9 days ago');
  });

  it('never speaks of the future when a clock is ahead', () => {
    expect(timeAgo(at(-60_000), now, 'en')).toBe('this minute');
  });
});
