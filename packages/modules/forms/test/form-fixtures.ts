// What the forms module's Postgres tests share: a business with someone who may manage
// forms, the admin routes run as the server runs them, and the public handlers with a
// clock the test moves.
import { randomUUID } from 'node:crypto';

import { allowEveryone, type Invocation } from '@repo/commands';
import {
  DEFAULT_FORM_DEFINITION,
  fieldDefinition,
  form as formContract,
  type FieldDefinition,
  type Form,
  type FormDefinitionInput,
  type PublicFormSubmissionInput,
} from '@repo/contracts';
import { connectDatabase, type Database } from '@repo/db';
import { crmRoutes } from '@repo/module-crm';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, expect, inject } from 'vitest';

import {
  createFormRoutes,
  createPublicFormHandlers,
  type FormAdmission,
  type PublicFormHandlers,
  type PublicFormRequest,
} from '../src/index.js';

export const PUBLIC_URL = 'https://crm.example.test';
export const WEBSITE = 'https://www.example.com';
export const SECRET = 'forms-fixture-secret-of-at-least-32-bytes';

export interface FormFixture {
  readonly agency: { readonly id: string };
  readonly business: Awaited<ReturnType<TestDatabase['fixtures']['business']>>;
  /** Someone who may do everything in the business. */
  readonly manager: Invocation;
}

export interface Submitted {
  readonly admission: FormAdmission;
  readonly input: PublicFormSubmissionInput;
  readonly result: Awaited<ReturnType<PublicFormHandlers['submit']>>;
}

export interface FormSuite {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly fixture: () => Promise<FormFixture>;
  /** Runs an admin route of the forms module, as the given person or the manager. */
  readonly admin: (
    f: FormFixture,
    operationId: string,
    input?: { readonly params?: unknown; readonly query?: unknown; readonly body?: unknown },
    invocation?: Invocation,
  ) => Promise<unknown>;
  /** A form saved with this definition and these websites, and published. */
  readonly published: (
    f: FormFixture,
    definition?: FormDefinitionInput,
    origins?: readonly string[],
  ) => Promise<Form>;
  /** A contact custom field of the business. */
  readonly field: (
    f: FormFixture,
    key: string,
    valueType?: FieldDefinition['valueType'],
    choices?: readonly string[],
  ) => Promise<FieldDefinition>;
  /** The public handlers on the suite's clock, which starts now and moves only when told. */
  readonly handlers: PublicFormHandlers;
  /**
   * The same, as a second server process would have them: one process stores one
   * submission of a form at a time, so what two do at the same moment takes two.
   */
  readonly instance: PublicFormHandlers;
  readonly dropped: string[];
  /** Moves the suite's clock on. */
  readonly wait: (milliseconds: number) => void;
  /** The suite's clock, for handlers a test makes itself. */
  readonly now: () => number;
  /** A visitor's request as the transport describes it. */
  readonly visitor: (change?: Partial<PublicFormRequest>) => PublicFormRequest;
  /**
   * What a visitor does: load the form from an allowed website, take a few seconds, send.
   * The suite's clock is moved on by `after` between the two (three seconds by default).
   */
  readonly submit: (
    form: Pick<Form, 'publicKey'>,
    values: Readonly<Record<string, string | boolean>>,
    change?: Partial<PublicFormSubmissionInput> & {
      readonly after?: number;
      readonly origin?: string;
      readonly visitor?: Partial<PublicFormRequest>;
    },
  ) => Promise<Submitted>;
  /** Everything a submission can leave behind, counted. */
  readonly stored: (f: FormFixture) => Promise<{
    readonly submissions: number;
    readonly contacts: number;
    readonly consents: number;
    readonly events: number;
  }>;
}

export function formSuite(): FormSuite {
  let database: TestDatabase;
  let db: Database;
  let handlers: PublicFormHandlers;
  let instance: PublicFormHandlers;
  let clock = Date.now();
  const dropped: string[] = [];
  beforeAll(async () => {
    database = await testDatabase(inject('databaseServer'));
    db = connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    });
    handlers = createPublicFormHandlers({
      db,
      secret: SECRET,
      now: () => clock,
      onDropped: (reason) => dropped.push(reason),
    });
    instance = createPublicFormHandlers({ db, secret: SECRET, now: () => clock });
  });
  afterAll(async () => {
    await db.destroy();
    await database.close();
  });

  async function fixture(): Promise<FormFixture> {
    const agency = await database.fixtures.agency();
    const business = await database.fixtures.business(agency.id);
    const user = await database.fixtures.user();
    return {
      agency,
      business,
      manager: {
        context: {
          ...business.context,
          actorKind: 'user',
          actorId: user.id,
          userId: user.id,
          correlationId: randomUUID(),
        },
        permissions: 'all',
      },
    };
  }

  const admin: FormSuite['admin'] = async (f, operationId, input = {}, invocation = f.manager) => {
    const route = createFormRoutes(PUBLIC_URL).find(
      (candidate) => candidate.endpoint.operationId === operationId,
    );
    if (route === undefined) throw new Error(`Missing ${operationId} route.`);
    // Each request has its own correlation id, as the server gives it.
    return route.run(
      {
        invocation: {
          ...invocation,
          context: { ...invocation.context, correlationId: randomUUID() },
        },
        params: input.params ?? {},
        query: input.query ?? {},
        body: input.body,
      },
      { db, authorize: allowEveryone },
    );
  };

  const published: FormSuite['published'] = async (
    f,
    definition = DEFAULT_FORM_DEFINITION,
    origins = [WEBSITE],
  ) => {
    const draft = formContract.parse(await admin(f, 'createForm', { body: { name: 'Enquiry' } }));
    const saved = formContract.parse(
      await admin(f, 'updateForm', {
        params: { id: draft.id },
        body: { name: 'Enquiry', definition, allowedOrigins: origins, revision: draft.revision },
      }),
    );
    return formContract.parse(
      await admin(f, 'publishForm', {
        params: { id: saved.id },
        body: { revision: saved.revision },
      }),
    );
  };

  const field: FormSuite['field'] = async (f, key, valueType = 'text', choices = []) => {
    const route = crmRoutes.find((each) => each.endpoint.operationId === 'createField');
    if (route === undefined) throw new Error('Missing createField route.');
    return fieldDefinition.parse(
      await route.run(
        {
          invocation: f.manager,
          params: {},
          query: {},
          body: {
            key,
            label: key,
            objectKey: 'contact',
            valueType,
            description: 'A contact field a form fills.',
            currency: null,
            options: choices.map((choice) => ({
              key: choice,
              label: choice,
              description: '',
              archived: false,
            })),
            aiFillSources: [],
            aiOverwrite: 'ask',
            archived: false,
          },
        },
        { db, authorize: allowEveryone },
      ),
    );
  };

  const visitor: FormSuite['visitor'] = (change = {}) => ({
    requestId: randomUUID(),
    ipAddress: '203.0.113.10',
    userAgent: 'Browser/1.0',
    ...change,
  });

  const submit: FormSuite['submit'] = async (form, values, change = {}) => {
    const { after = 3000, origin = WEBSITE, visitor: who, ...rest } = change;
    const admission = await handlers.admit(form.publicKey, origin);
    if (admission === undefined) throw new Error('The form did not admit this website.');
    const shown = await handlers.form(admission, visitor(who));
    if (shown.outcome !== 'ok') throw new Error(`The form was not shown: ${shown.outcome}.`);
    clock += after;
    const input: PublicFormSubmissionInput = {
      clientSubmissionId: randomUUID(),
      renderToken: shown.form.renderToken,
      values,
      consents: {},
      trap: '',
      ...rest,
    };
    return { admission, input, result: await handlers.submit(admission, input, visitor(who)) };
  };

  const stored: FormSuite['stored'] = (f) =>
    database.withTenant(f.business.context, async (sql) => {
      const count = async (text: string): Promise<number> =>
        (await sql.one<{ n: number }>(`select count(*)::integer as n from ${text}`)).n;
      return {
        submissions: await count('forms.submissions'),
        contacts: await count('crm.contacts'),
        consents: await count('messaging.consents'),
        events: await count("events.events where type = 'form.submitted'"),
      };
    });

  return {
    get database() {
      return database;
    },
    get db() {
      return db;
    },
    fixture,
    admin,
    published,
    field,
    get handlers() {
      return handlers;
    },
    get instance() {
      return instance;
    },
    dropped,
    wait(milliseconds) {
      clock += milliseconds;
    },
    now: () => clock,
    visitor,
    submit,
    stored,
  };
}

/** Whether a session of this database waits for a lock in a statement like the one given. */
export function untilWaiting(
  database: TestDatabase,
  statement: string,
  sessions = 1,
  timeout = 10_000,
): Promise<void> {
  return expect
    .poll(
      () =>
        // Another role's wait events are hidden from crm_app, so the superuser watches.
        database.as('postgres', async (sql) => {
          const row = await sql.one<{ waiting: number }>(
            "select count(*)::integer as waiting from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike $1",
            [statement],
          );
          return row.waiting;
        }),
      { timeout, interval: 50 },
    )
    .toBe(sessions);
}

export const settled = <T>(
  attempt: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  attempt.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
