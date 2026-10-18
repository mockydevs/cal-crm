import type { FirstStart } from '@repo/module-auth';
import { describe, expect, it, vi } from 'vitest';

import { announceFirstAdmin } from './first-admin.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const answering = (start: FirstStart) => ({ firstAdminLink: () => Promise.resolve(start) });

describe('announceFirstAdmin', () => {
  it('prints the setup link while nobody runs the agency', async () => {
    const log = logger();

    await announceFirstAdmin(
      answering({ kind: 'link', url: 'https://crm.example.test/setup?token=abc' }),
      log,
    );

    expect(log.info).toHaveBeenCalledWith(
      { setupLink: 'https://crm.example.test/setup?token=abc' },
      expect.stringContaining('Open the setup link to create the first admin'),
    );
  });

  it('says nothing once someone runs the agency', async () => {
    const log = logger();

    await announceFirstAdmin(answering({ kind: 'admin_exists' }), log);

    expect([log.info, log.warn, log.error].flatMap((each) => each.mock.calls)).toEqual([]);
  });

  it('warns when the install step hasn’t made the agency', async () => {
    const log = logger();

    await announceFirstAdmin(answering({ kind: 'no_agency' }), log);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no agency yet'));
  });

  it('logs a failure to check, and carries on', async () => {
    const log = logger();
    const failure = new Error('database down');

    await announceFirstAdmin({ firstAdminLink: () => Promise.reject(failure) }, log);

    expect(log.error).toHaveBeenCalledWith({ err: failure }, 'checking for the first admin failed');
  });
});
