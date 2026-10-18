import { spawnSync } from 'node:child_process';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';
import { renderHttpScenario } from './capacity-profile.js';

const profile = {
  users: 1_000_000,
  staffPercent: 20,
  staffReadsPerMinute: 6,
  publicReadsPerMinute: 2,
  publicCacheHitPercent: 90,
  zones: 3,
};

it('prepares a syntactically valid k6 scenario that defaults to a small local test', () => {
  const script = renderHttpScenario({
    profile,
    origin: 'http://127.0.0.1:3000',
    environment: 'local',
    fixtureFile: './capacity-fixtures.json',
    duration: '30s',
  });
  const result = spawnSync(process.execPath, ['--check', '--input-type=module'], {
    input: script,
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  expect(script).toContain("CAPACITY_USERS || '10'");
  expect(script).toContain('constant-vus');
  expect(script).toContain('idInTest');
  expect(script).toContain('200');
});

it('refuses unsafe origins and invalid duration before generating a runnable test', () => {
  const valid = {
    profile,
    origin: 'http://127.0.0.1:3000',
    environment: 'local' as const,
    fixtureFile: './capacity-fixtures.json',
    duration: '30s',
  };
  for (const origin of [
    'https://crm.example.test',
    'http://user:secret@127.0.0.1:3000',
    'file:///etc/passwd',
    'http://127.0.0.1:3000/another',
  ])
    expect(() => renderHttpScenario({ ...valid, origin })).toThrow();
  expect(() => renderHttpScenario({ ...valid, duration: '0s' })).toThrow();
  expect(() => renderHttpScenario({ ...valid, duration: 'ten minutes' })).toThrow();
  expect(() =>
    renderHttpScenario({
      ...valid,
      origin: 'https://capacity.example.test',
      environment: 'isolated-staging',
    }),
  ).not.toThrow();
});

it('loads identity data inside SharedArray factories rather than duplicating it in every virtual user', () => {
  const source = renderHttpScenario({
    profile,
    origin: 'http://127.0.0.1:3000',
    environment: 'local',
    fixtureFile: './capacity-fixtures.json',
    duration: '30s',
  })
    .replaceAll(/^import .*;$/gm, '')
    .replace('export const options', 'const options')
    .replace('export default function', 'function visit');
  const cache = new Map<string, unknown[]>();
  let reads = 0;
  // k6 documents that a named SharedArray calls its factory once and shares the data.
  function SharedArray(name: string, load: () => unknown[]): unknown[] {
    const value = cache.get(name) ?? load();
    cache.set(name, value);
    return value;
  }
  const fixture = {
    staff: [
      { userId: 'one', businessId: 'biz_one', cookie: 'fixture=one' },
      { userId: 'two', businessId: 'biz_two', cookie: 'fixture=two' },
    ],
    pages: ['/landing'],
  };
  for (let index = 0; index < 100; index += 1)
    new Script(source).runInNewContext({
      __ENV: {},
      SharedArray,
      open: () => {
        reads += 1;
        return JSON.stringify(fixture);
      },
    });
  expect(reads).toBe(2);
});

it('keeps native reads on the configured origin and assigns a distinct session to each staff user', () => {
  const source = renderHttpScenario({
    profile,
    origin: 'http://127.0.0.1:3000',
    environment: 'local',
    fixtureFile: './capacity-fixtures.json',
    duration: '30s',
  })
    .replaceAll(/^import .*;$/gm, '')
    .replace('export const options', 'const options')
    .replace('export default function', 'function visit');
  const staff = Array.from({ length: 20 }, (_, index) => ({
    userId: `user-${String(index)}`,
    businessId: `business-${String(index)}`,
    cookie: `fixture=${String(index)}`,
  }));
  const sessions: string[] = [];
  let publicReads = 0;
  function SharedArray(_name: string, load: () => unknown[]): unknown[] {
    return load();
  }
  for (let index = 0; index < 100; index += 1)
    new Script(`${source}\nvisit();`).runInNewContext({
      __ENV: { CAPACITY_USERS: '100' },
      SharedArray,
      open: () => JSON.stringify({ staff, pages: ['/landing'] }),
      exec: { vu: { idInTest: index + 1 }, scenario: { iterationInTest: index } },
      http: {
        get: (url: string, options: { redirects?: number; headers?: Record<string, string> }) => {
          expect(new URL(url).origin).toBe('http://127.0.0.1:3000');
          expect(options.redirects).toBe(0);
          const cookie = options.headers?.['Cookie'];
          if (cookie === undefined) publicReads += 1;
          else sessions.push(cookie);
          return { status: 200 };
        },
      },
      check: () => true,
      sleep: () => undefined,
    });
  expect(publicReads).toBe(80);
  expect(sessions).toEqual(staff.map((actor) => actor.cookie));
});
