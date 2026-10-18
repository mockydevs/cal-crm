// The hosting guide cannot rot: a setting the server reads (config.ts) or the install
// passes (compose.yml) must be in docs/HOSTING.md, section 5, in this package's README,
// and, where an install sets it, in install.env.example. And the other way round: the
// guide and the example name no setting that does not exist.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { settingNames } from './config.js';

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

const guide = read('docs/HOSTING.md');
const compose = read('compose.yml');
const example = read('install.env.example');
const readme = read('apps/server/README.md');

/** What the Compose file or the image sets, so an install does not: guide, section 5.2. */
const SET_FOR_THE_INSTALL = [
  'NODE_ENV',
  'ROLE',
  'HOST',
  'PORT',
  'DASHBOARD_DIR',
  'DATABASE_APP_URL',
  'DATABASE_AUTH_URL',
  'DATABASE_WORKER_URL',
  'FILES_STORAGE',
  'FILES_DIR',
  'SHUTDOWN_TIMEOUT_MS',
  'MIGRATE_ON_START',
];
/** Refused in production, and in no install's settings: guide, section 5.3. */
const DEVELOPMENT_ONLY = ['DEV_TENANT_CONTEXT', 'DEV_SIGN_IN_LIMIT'];
/** Read by Docker Compose itself, not through a ${…} of the file. */
const READ_BY_COMPOSE = ['COMPOSE_PROFILES'];

const sorted = (names: Iterable<string>): string[] => [...new Set(names)].sort();

/** Every NAME the Compose file takes from the install's settings, as ${NAME…}. */
const interpolated = sorted(
  [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name ?? ''),
);

/** The settings section of the guide, and the names its tables' first cells hold. */
const section = guide.slice(guide.indexOf('## 5. Every setting'), guide.indexOf('## 6. '));
const documented = sorted(
  section
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]*)`/g)])
    .map(([, name]) => name ?? ''),
);

/** The names the example file sets, commented out or not. */
const exampled = sorted(
  [...example.matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name ?? ''),
);

describe('the hosting guide and the settings', () => {
  it('reads the files it checks', () => {
    expect(section.length).toBeGreaterThan(1000);
    expect(settingNames.length).toBeGreaterThan(20);
    expect(interpolated.length).toBeGreaterThan(20);
    expect(exampled.length).toBeGreaterThan(20);
  });

  it('documents every setting the server reads and every one the Compose file takes', () => {
    const missing = sorted([...settingNames, ...interpolated, ...READ_BY_COMPOSE]).filter(
      (name) => !documented.includes(name),
    );
    expect(missing, 'missing from docs/HOSTING.md, section 5').toEqual([]);
  });

  it('documents no setting that does not exist', () => {
    const known = new Set([...settingNames, ...interpolated, ...READ_BY_COMPOSE]);
    expect(documented.filter((name) => !known.has(name))).toEqual([]);
  });

  it('lists in install.env.example exactly what an install sets', () => {
    const settable = sorted([...interpolated, ...READ_BY_COMPOSE]);
    expect(
      settable.filter((name) => !exampled.includes(name)),
      'missing from the example',
    ).toEqual([]);
    expect(
      exampled.filter((name) => !settable.includes(name)),
      'in the example only',
    ).toEqual([]);
  });

  it('lets an install set every setting of the server, but for the ones named here', () => {
    // A setting added to config.ts must be passed by compose.yml (and so be in the example
    // file), or be added to one of the two lists above with a row in the guide saying why.
    const unreachable = settingNames.filter((name) => !interpolated.includes(name));
    expect(sorted(unreachable)).toEqual(sorted([...SET_FOR_THE_INSTALL, ...DEVELOPMENT_ONLY]));
  });

  it('keeps development settings out of an install', () => {
    for (const name of DEVELOPMENT_ONLY) {
      expect(compose).not.toContain(name);
      expect(example).not.toContain(name);
      expect(settingNames).toContain(name);
    }
  });

  it('says what production refuses, where config.ts refuses it', () => {
    for (const name of [
      'PUBLIC_URL',
      'AUTH_SECRET',
      'FILES_LINK_SECRET',
      'PUBLIC_INTAKE_SECRET',
      'SECRETS_KEYS',
      'SECRETS_PUBLIC_KEY',
      ...DEVELOPMENT_ONLY,
    ]) {
      const row = section.split('\n').find((line) => line.startsWith(`| \`${name}\``));
      expect(row, name).toMatch(/Refused/);
    }
  });

  it('has every setting of the server in this package’s README too', () => {
    expect(settingNames.filter((name) => !readme.includes(`\`${name}\``))).toEqual([]);
  });
});
