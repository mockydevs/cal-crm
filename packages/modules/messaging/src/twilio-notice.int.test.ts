// twilio-signature.ts is a port of functions of the Twilio Node.js SDK, which is under the
// MIT licence: its notice must go wherever the code goes. The image ships this package's
// compiled files, so the notice has to be in the compiled file too, whole. This runs with
// the integration tests because they run after the build (turbo.json); it needs no database.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, it } from 'vitest';

const sdk = path.dirname(createRequire(import.meta.url).resolve('twilio/package.json'));

/** The lines of a licence text, without the blank ones. */
const linesOf = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

/** The text of the first comment that starts with an exclamation mark, as tools keep it. */
function noticeOf(source: string): string[] {
  const start = source.indexOf('/*!');
  const end = source.indexOf('*/', start);
  if (start !== 0 || end < 0) throw new Error('The file does not begin with its notice.');
  return linesOf(source.slice(start + 3, end).replaceAll(/^\s*\* ?/gm, ''));
}

it.each(['src/twilio-signature.ts', 'dist/twilio-signature.js'])(
  "%s begins with the SDK's whole licence, word for word",
  async (file) => {
    const licence = linesOf(await readFile(path.join(sdk, 'LICENSE'), 'utf8'));
    expect(licence[0]).toBe('MIT License');
    expect(licence.length).toBeGreaterThan(10);
    const notice = noticeOf(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    const from = notice.indexOf('MIT License');
    expect(notice.slice(from, from + licence.length)).toEqual(licence);
    // And it names the version the port was made from, which is the one installed.
    const installed: unknown = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
    expect(installed).toMatchObject({ license: 'MIT' });
    const version =
      installed !== null && typeof installed === 'object' && 'version' in installed
        ? String(installed.version)
        : '';
    expect(notice.join(' ')).toContain(`version ${version}`);
  },
);
