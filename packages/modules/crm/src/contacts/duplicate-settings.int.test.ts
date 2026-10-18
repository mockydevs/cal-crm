// Settings → Business Profile → Contact Deduplication Preferences against a migrated
// Postgres: reading and saving them, and the order they give a form's or a booking's
// details (intake) and an import's rows. With nothing saved, both match as they did before
// the preferences existed.
import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { createContactInput, duplicateSettings, importPreview } from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { ConflictError, ForbiddenError, ValidationError } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as z from 'zod';

import {
  attribute,
  importApi,
  memoryFiles,
  uploadCsv,
  workspace,
  type Workspace,
} from '../../test/imports.js';
import { contactDuplicateRoutes } from './duplicate-routes.js';
import { updateDuplicateSettingsCommand } from './duplicate-settings.js';
import { intakeContact } from './intake.js';

let database: TestDatabase;
let db: Database;
let services: Services;
let files: ReturnType<typeof memoryFiles>;
let imports: ReturnType<typeof importApi>;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  services = { db, authorize: allowEveryone };
  files = memoryFiles(db);
  imports = importApi(services, files);
});
afterAll(async () => {
  await db.destroy();
  await database.close();
});

async function read(who: Invocation) {
  const route = contactDuplicateRoutes.find(
    (each) => each.endpoint.operationId === 'getDuplicateSettings',
  );
  if (route === undefined) throw new Error('No settings route.');
  return duplicateSettings.parse(
    await route.run({ invocation: who, params: {}, query: {}, body: undefined }, services),
  );
}

async function choose(
  space: Workspace,
  primary: 'email' | 'phone',
  secondary: 'email' | 'phone' | null,
) {
  const { revision } = await read(space.owner);
  return runCommand(
    services,
    updateDuplicateSettingsCommand,
    { primary, secondary, revision },
    space.owner,
  );
}

/** A contact holding these addresses, as an earlier lead left it. */
async function holder(space: Workspace, email?: string, phone?: string): Promise<string> {
  const contact = await database.fixtures.contact(space.owner.context, {
    firstName: 'Held',
    ...(email === undefined ? {} : { email }),
  });
  if (phone !== undefined)
    await database.withTenant(space.owner.context, (sql) =>
      sql.query(
        `insert into crm.contact_identities (business_id, contact_id, kind, value, value_normalized)
         values (app.business_id(), $1, 'phone', $2, $2)`,
        [contact.id, phone],
      ),
    );
  return contact.id;
}

describe('the preferences', () => {
  it('are email first and nothing second until someone saves them, and anyone may read them', async () => {
    const space = await workspace(database);
    expect(await read(space.as([]))).toMatchObject({
      primary: 'email',
      secondary: null,
      canManage: false,
    });
    expect(await read(space.owner)).toMatchObject({ canManage: true });
  });

  it('are saved by whoever may change the business profile, from the revision they read', async () => {
    const space = await workspace(database);
    const { revision } = await read(space.owner);
    const saved = await runCommand(
      services,
      updateDuplicateSettingsCommand,
      { primary: 'phone', secondary: 'email', revision },
      space.as(['business.profile']),
    );
    expect(saved).toMatchObject({ primary: 'phone', secondary: 'email' });
    expect(await read(space.owner)).toEqual(saved);

    await expect(
      runCommand(
        services,
        updateDuplicateSettingsCommand,
        { primary: 'email', secondary: null, revision },
        space.owner,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      runCommand(
        services,
        updateDuplicateSettingsCommand,
        { primary: 'email', secondary: null, revision: saved.revision },
        space.as(['contacts.manage']),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runCommand(
        services,
        updateDuplicateSettingsCommand,
        { primary: 'email', secondary: 'email', revision: saved.revision },
        space.owner,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('tell the timeline of a change, and of nothing when nothing changed', async () => {
    const space = await workspace(database);
    await choose(space, 'phone', null);
    await choose(space, 'phone', null);
    const events = await database.as('crm_owner', (sql) =>
      sql.query<{ payload: unknown }>(
        `select payload from events.events
         where business_id = $1 and type = 'duplicate_settings.updated'`,
        [space.businessId],
      ),
    );
    expect(events.map((event) => event.payload)).toEqual([{ primary: 'phone', secondary: null }]);
  });
});

describe('the order details from a form or a booking are matched in', () => {
  const input = z.strictObject({
    emails: createContactInput.shape.emails.unwrap().optional(),
    phones: createContactInput.shape.phones.unwrap().optional(),
  });
  const intake = defineCommand({
    name: 'test.contact.intake',
    permission: 'contacts.manage',
    input,
    handle: intakeContact,
  });
  const arrive = async (space: Workspace, details: z.input<typeof input>) =>
    (await runCommand(services, intake, details, space.system)).contactId;

  const EMAIL = 'maya@example.test';
  // Not one of 555-0100 to 555-0199, which are fiction and never matched on.
  const PHONE = '+12124567890';

  it('is unchanged with nothing saved: the email address, and the phone only when no email was given', async () => {
    const space = await workspace(database);
    const byEmail = await holder(space, EMAIL);
    const byPhone = await holder(space, undefined, PHONE);

    expect(await arrive(space, { emails: [EMAIL], phones: [PHONE] })).toBe(byEmail);
    expect(await arrive(space, { phones: [PHONE] })).toBe(byPhone);
    const made = await arrive(space, { emails: ['new@example.test'], phones: [PHONE] });
    expect([byEmail, byPhone]).not.toContain(made);
  });

  it('tries the phone number after the email address when phone is the secondary field', async () => {
    const space = await workspace(database);
    await choose(space, 'email', 'phone');
    const byEmail = await holder(space, EMAIL);
    const byPhone = await holder(space, undefined, PHONE);

    expect(await arrive(space, { emails: [EMAIL], phones: [PHONE] })).toBe(byEmail);
    expect(await arrive(space, { emails: ['new@example.test'], phones: [PHONE] })).toBe(byPhone);
  });

  it('starts with the phone number when it is the primary field', async () => {
    const space = await workspace(database);
    await choose(space, 'phone', null);
    const byEmail = await holder(space, EMAIL);
    const byPhone = await holder(space, undefined, PHONE);

    expect(await arrive(space, { emails: [EMAIL], phones: [PHONE] })).toBe(byPhone);
    expect(await arrive(space, { emails: [EMAIL] })).toBe(byEmail);
    // A phone number that finds nobody, with no secondary field: a new contact.
    const made = await arrive(space, { emails: [EMAIL], phones: ['+12124567891'] });
    expect([byEmail, byPhone]).not.toContain(made);
    // A fictional number is never matched on, so the email address is all that was given.
    expect(await arrive(space, { emails: [EMAIL], phones: ['+12125550123'] })).toBe(byEmail);
  });

  it('tries the email address after the phone number when email is the secondary field', async () => {
    const space = await workspace(database);
    await choose(space, 'phone', 'email');
    const byEmail = await holder(space, EMAIL);
    const byPhone = await holder(space, undefined, PHONE);

    expect(await arrive(space, { emails: [EMAIL], phones: [PHONE] })).toBe(byPhone);
    expect(await arrive(space, { emails: [EMAIL], phones: ['+12124567891'] })).toBe(byEmail);
  });
});

describe('the order an import reads a row’s addresses in', () => {
  const mapping = [
    { column: 0, target: attribute('firstName') },
    { column: 1, target: attribute('email') },
    { column: 2, target: attribute('phone') },
  ];
  const preview = async (space: Workspace, csv: string) => {
    const file = await uploadCsv(files, services, space.owner, csv);
    return importPreview.parse(
      await imports.call('previewImport', space.owner, {
        body: { fileId: file.id, object: 'contact', mode: 'create_and_update', mapping },
      }),
    ).rows;
  };
  const CSV = 'First,Email,Phone\r\nMaya,maya@example.test,+12125550142\r\n';

  it('is unchanged with nothing saved: the email address first, then the phone number', async () => {
    const space = await workspace(database);
    await holder(space, 'maya@example.test');
    await holder(space, undefined, '+12125550142');
    const [split] = await preview(space, CSV);
    expect(split?.outcome).toBe('fail');
    expect(split?.issues.map(({ column, code }) => ({ column, code }))).toEqual([
      { column: 2, code: 'taken' },
    ]);

    // The phone number's contact, the only one: found though the email address finds nobody.
    const other = await workspace(database);
    await holder(other, undefined, '+12125550142');
    const [found] = await preview(other, CSV);
    expect(found).toMatchObject({ outcome: 'update', issues: [] });
  });

  it('starts with the phone number when it is the primary field, and still looks at both', async () => {
    const space = await workspace(database);
    await choose(space, 'phone', null);
    await holder(space, 'maya@example.test');
    await holder(space, undefined, '+12125550142');
    const [split] = await preview(space, CSV);
    expect(split?.issues.map(({ column, code }) => ({ column, code }))).toEqual([
      { column: 1, code: 'taken' },
    ]);

    const other = await workspace(database);
    await choose(other, 'phone', null);
    await holder(other, 'maya@example.test');
    const [found] = await preview(other, CSV);
    expect(found).toMatchObject({ outcome: 'update', issues: [] });
  });
});
