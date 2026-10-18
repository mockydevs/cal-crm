import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { clockOf, quietHoursDefaults, quietHoursRevision } from './quiet-hours-values.js';

const source = (path: string): Promise<string> =>
  readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

it('shows a stored time as hours and minutes', () => {
  expect(clockOf('21:00:00')).toBe('21:00');
  expect(clockOf('08:05:59.123')).toBe('08:05');
  expect(clockOf('00:00')).toBe('00:00');
});

it('uses the defaults the table and the send check use for a business with no settings', async () => {
  expect(quietHoursDefaults).toEqual({
    quietHoursEnabled: true,
    quietHoursStart: '21:00',
    quietHoursEnd: '08:00',
    contactDailyLimit: 10,
  });
  const table = await source('../../../db/migrations/0006_messaging.sql');
  expect(table).toContain('quiet_hours_enabled boolean not null default true');
  expect(table).toContain(`quiet_hours_start time not null default '21:00'`);
  expect(table).toContain(`quiet_hours_end time not null default '08:00'`);
  expect(await source('../../../db/migrations/0032_outbound_dispatch.sql')).toContain(
    'contact_daily_limit integer not null default 10',
  );
  // What outbound.ts falls back to when there is no settings row.
  const policy = await source('outbound.ts');
  expect(policy).toContain('coalesce(s.quiet_hours_enabled,true)');
  expect(policy).toContain(`coalesce(s.quiet_hours_start,'21:00'::time)`);
  expect(policy).toContain(`coalesce(s.quiet_hours_end,'08:00'::time)`);
  expect(policy).toContain('coalesce(s.contact_daily_limit,10)');
});

it('names each combination of values with its own revision', () => {
  const base = quietHoursRevision(quietHoursDefaults);
  expect(base).toMatch(/^[0-9a-f]{64}$/);
  expect(quietHoursRevision({ ...quietHoursDefaults })).toBe(base);
  const others = [
    { ...quietHoursDefaults, quietHoursEnabled: false },
    { ...quietHoursDefaults, quietHoursStart: '22:00' },
    { ...quietHoursDefaults, quietHoursEnd: '07:00' },
    { ...quietHoursDefaults, contactDailyLimit: 11 },
    // Swapped times are a different window.
    { ...quietHoursDefaults, quietHoursStart: '08:00', quietHoursEnd: '21:00' },
  ].map(quietHoursRevision);
  expect(new Set([base, ...others]).size).toBe(6);
});
