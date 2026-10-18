// Migration 0047 over an install that already has web chat widgets: a database is migrated
// up to the migration before it, widgets are stored as 0006 allowed them, and the runner
// applies 0047 as it does on an upgrade. No released code ever wrote a widget, so these
// rows stand for what an import or a repair by hand could have left.
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startPostgres, type Postgres } from '@repo/testing';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bootstrapFile, migrate, MigrationError } from './index.js';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const WEBCHAT = '0047_webchat.sql';

let postgres: Postgres;
let earlier: string;
beforeAll(async () => {
  postgres = await startPostgres({ bootstrapFile });
  // The migrations an install had before web chat sessions.
  earlier = await mkdtemp(join(tmpdir(), 'crm-before-webchat-'));
  for (const name of await readdir(migrationsDirectory))
    if (name < WEBCHAT) await cp(join(migrationsDirectory, name), join(earlier, name));
});
afterAll(async () => {
  await postgres.stop();
  await rm(earlier, { recursive: true, force: true });
});

/** A database at the migration before 0047, with one business, and a way to add widgets. */
async function installed(): Promise<{
  connectionString: string;
  owner: pg.Client;
  widget: (origins: string) => Promise<string>;
}> {
  const database = await postgres.createDatabase();
  const connectionString = postgres.url(database);
  const before = await migrate({ connectionString, directory: earlier });
  expect(before.applied).not.toContain(WEBCHAT);
  // crm_owner, as an import or a repair would write: it is not held to a tenant.
  const owner = new pg.Client({ connectionString });
  await owner.connect();
  const one = async (text: string, values: readonly unknown[] = []): Promise<string> => {
    const { rows } = await owner.query<{ id: string }>(text, [...values]);
    const [row] = rows;
    if (row === undefined) throw new Error(`No row: ${text}`);
    return row.id;
  };
  const agency = await one(
    "insert into tenancy.agencies (name, slug) values ('Agency', 'agency') returning id",
  );
  const business = await one(
    "insert into tenancy.businesses (agency_id, name, slug) values ($1, 'Business', 'business') returning id",
    [agency],
  );
  let widgets = 0;
  return {
    connectionString,
    owner,
    async widget(origins) {
      widgets += 1;
      const account = await one(
        "insert into messaging.channel_accounts (business_id, channel, name) values ($1, 'webchat', $2) returning id",
        [business, `Site ${String(widgets)}`],
      );
      return one(
        `insert into messaging.webchat_widgets (business_id, id, public_key, allowed_origins)
         values ($1, $2, $3, ${origins}) returning id`,
        [business, account, `pk_upgrade_widget_${String(widgets).padStart(6, '0')}`],
      );
    },
  };
}

it('keeps the widgets an install has, and holds them to the new bounds from then on', async () => {
  const { connectionString, owner, widget } = await installed();
  try {
    const none = await widget("'{}'");
    const two = await widget("'{https://example.com,https://www.example.com}'");
    const full = await widget(
      "array(select 'https://site-' || n || '.example.com' from generate_series(1, 20) n)",
    );

    const upgrade = await migrate({ connectionString });
    expect(upgrade.applied).toContain(WEBCHAT);

    const kept = await owner.query<{ id: string; origins: number }>(
      'select id, cardinality(allowed_origins) as origins from messaging.webchat_widgets order by created_at, id',
    );
    expect(kept.rows).toEqual([
      { id: none, origins: 0 },
      { id: two, origins: 2 },
      { id: full, origins: 20 },
    ]);
    // No session was made up for them.
    expect((await owner.query('select 1 from messaging.webchat_sessions')).rows).toEqual([]);
    await expect(
      owner.query("update messaging.webchat_widgets set allowed_origins = '{*}' where id = $1", [
        two,
      ]),
    ).rejects.toMatchObject({ constraint: 'webchat_widgets_origins_bounded' });
  } finally {
    await owner.end();
  }
});

it('stops, and changes nothing, when a stored widget lists what no website can be', async () => {
  const { connectionString, owner, widget } = await installed();
  try {
    // A wildcard would have admitted every website; the migration does not guess which
    // one was meant. The person upgrading sees the constraint and corrects the row.
    const wildcard = await widget("'{https://example.com,*}'");
    const failed = await migrate({ connectionString }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(MigrationError);
    expect(failed instanceof Error ? failed.message : '').toContain(WEBCHAT);
    // Nothing of 0047 stayed: no table, and the row is as it was.
    expect(
      (await owner.query("select to_regclass('messaging.webchat_sessions') as found")).rows,
    ).toEqual([{ found: null }]);
    expect(
      (
        await owner.query('select allowed_origins from messaging.webchat_widgets where id = $1', [
          wildcard,
        ])
      ).rows,
    ).toEqual([{ allowed_origins: ['https://example.com', '*'] }]);

    // Corrected, the same upgrade goes through.
    await owner.query(
      "update messaging.webchat_widgets set allowed_origins = '{https://example.com}' where id = $1",
      [wildcard],
    );
    expect((await migrate({ connectionString })).applied).toContain(WEBCHAT);
  } finally {
    await owner.end();
  }
});
