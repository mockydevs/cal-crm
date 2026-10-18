// Writers of more than one contact against each other, on separate connections as crm_app:
// a merge, a bulk action's batch and an import's batch. Each holds its contacts until it
// commits, and each takes them in id order, so whichever starts first, the other waits and
// both finish. Neither is chosen as a deadlock's victim (40P01), whatever order the person
// picked the contacts in or the file lists them in.
import { allowEveryone, runCommand, type Services } from '@repo/commands';
import { contactBulkAction, contactMergePreview, importJob } from '@repo/contracts';
import { connectDatabase } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type TestDatabase } from '@repo/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { detailOptions, waitingForLock } from '../../test/contact-details.js';
import {
  attribute,
  importApi,
  memoryFiles,
  runImportJob,
  uploadCsv,
  workspace,
  type Workspace,
} from '../../test/imports.js';
import { createTagCommand } from '../tags/tags.js';
import { contactBulkRoutes } from './bulk-routes.js';
import { createContactCommand } from './contacts.js';
import type { ContactMergeParticipant } from './merge.js';
import { contactMergeRoutes } from './merge-routes.js';

let database: TestDatabase;
let services: Services;
let files: ReturnType<typeof memoryFiles>;
beforeAll(async () => {
  database = await testDatabase(inject('databaseServer'));
  services = {
    db: connectDatabase({
      connectionString: database.url('crm_app'),
      onConnectionError: () => undefined,
    }),
    authorize: allowEveryone,
  };
  files = memoryFiles(services.db);
});
afterAll(async () => {
  await services.db.destroy();
  await database.close();
});

/** A promise and the function that settles it. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return {
    opened: promise,
    open: () => {
      resolve(undefined);
    },
  };
}

/** Whether a command finished without a deadlock: done, or refused for a reason of its own. */
const finished = (run: Promise<unknown>) =>
  run.then(
    () => 'done',
    (error: unknown) => {
      if ((error as { code?: string }).code === '40P01') return 'deadlock';
      return (error as { name?: string }).name ?? 'failed';
    },
  );

interface Pair {
  readonly space: Workspace;
  /** Public ids, the lower uuid first. */
  readonly low: string;
  readonly high: string;
  readonly email: Readonly<Record<'low' | 'high', string>>;
}

/** Two contacts of a new business, each with an email address. */
async function pair(): Promise<Pair> {
  const space = await workspace(database);
  const made = async (name: string) => {
    const email = `${name}.${String(Date.now())}@example.test`;
    const { id } = await runCommand(
      services,
      createContactCommand,
      { firstName: name, emails: [email] },
      space.owner,
    );
    return { id, email };
  };
  const [one, two] = [await made('one'), await made('two')];
  const uuid = (id: string) => parsePublicId('contact', id) ?? '';
  const [low, high] = uuid(one.id) < uuid(two.id) ? [one, two] : [two, one];
  return { space, low: low.id, high: high.id, email: { low: low.email, high: high.email } };
}

const PUBLISHED = '0198de17-876e-7000-aac7-9bc8ac229001';

/**
 * Starts a bulk "add to workflow" over the contacts in the order given, its first batch run
 * in the request. With `pause`, the first contact's enrolment waits for `held`, so the batch
 * holds the contacts it has taken until then.
 */
function bulk(
  where: Pair,
  ids: readonly string[],
  pause?: { readonly paused: () => void; readonly held: Promise<void> },
) {
  let calls = 0;
  const options = {
    ...detailOptions(),
    workflows: {
      resolve: () => Promise.resolve({ id: PUBLISHED }),
      enrol: async () => {
        calls += 1;
        if (calls === 1 && pause !== undefined) {
          pause.paused();
          await pause.held;
        }
        return 'started' as const;
      },
    },
  };
  const start = contactBulkRoutes(options).find(
    (each) => each.endpoint.operationId === 'bulkUpdateContacts',
  );
  if (start === undefined) throw new Error('Missing the bulk route.');
  return start
    .run(
      {
        invocation: where.space.system,
        params: {},
        query: {},
        body: {
          action: 'add_to_workflow',
          workflowId: toPublicId('automation', PUBLISHED),
          selection: { ids: [...ids] },
        },
      },
      services,
    )
    .then((result) => contactBulkAction.parse(result));
}

/** Merges the higher contact into the lower; a participant given can hold it, locked. */
async function merge(where: Pair, participants: readonly ContactMergeParticipant[] = []) {
  const [preview, run] = contactMergeRoutes({ participants });
  if (preview === undefined || run === undefined) throw new Error('Missing merge routes.');
  const { contacts } = contactMergePreview.parse(
    await preview.run(
      {
        invocation: where.space.owner,
        params: { id: where.low },
        query: { mergeIds: where.high },
        body: undefined,
      },
      services,
    ),
  );
  return run.run(
    {
      invocation: where.space.owner,
      params: { id: where.low },
      query: {},
      body: {
        mergeIds: [where.high],
        revisions: Object.fromEntries(contacts.map((each) => [each.id, each.revision])),
      },
    },
    services,
  );
}

/** A merge that waits, its contacts locked, until it is let go. */
function pausedMerge(where: Pair) {
  const paused = gate();
  const held = gate();
  const running = finished(
    merge(where, [
      {
        name: 'pause',
        merge: async () => {
          paused.open();
          await held.opened;
          return {};
        },
      },
    ]),
  );
  return { paused: paused.opened, release: held.open, running };
}

/**
 * Starts an import that updates the two contacts, the higher one's row first, and adds a
 * tag to each. Another connection holds the tag FOR UPDATE until `release`: the import's
 * first row stops at the tag (its foreign key check), holding the contacts it has taken.
 */
async function blockedImport(where: Pair) {
  const { space } = where;
  const tag = await runCommand(
    services,
    createTagCommand,
    { name: `import ${String(Date.now())}`, description: '' },
    space.owner,
  );
  const blocking = gate();
  const held = gate();
  const blocker = database.as('crm_owner', async (sql) => {
    await sql.query('select id from crm.tags where id = $1 for update', [
      parsePublicId('tag', tag.id),
    ]);
    blocking.open();
    await held.opened;
  });
  await blocking.opened;
  const file = await uploadCsv(
    files,
    services,
    space.owner,
    `Email\r\n${where.email.high}\r\n${where.email.low}\r\n`,
  );
  const job = importJob.parse(
    await importApi(services, files).call('startImport', space.owner, {
      body: {
        fileId: file.id,
        object: 'contact',
        mode: 'update',
        mapping: [{ column: 0, target: attribute('email') }],
        tagIds: [tag.id],
      },
    }),
  );
  const running = finished(runImportJob(services, files, space.system, job.id));
  return {
    running,
    release: async () => {
      held.open();
      await blocker;
    },
  };
}

/** Each run's own, and none of them a deadlock's victim. */
const noDeadlock = (outcome: Record<string, string>) => {
  for (const value of Object.values(outcome)) expect(value).not.toBe('deadlock');
};

describe('a merge against a bulk action', () => {
  it('the batch first, over the contacts newest first: the merge waits, and both finish', async () => {
    const where = await pair();
    const paused = gate();
    const held = gate();
    const bulking = finished(
      bulk(where, [where.high, where.low], { paused: paused.open, held: held.opened }),
    );
    await paused.opened;
    const merging = finished(merge(where));
    await waitingForLock(database);
    held.open();
    const outcome = { bulk: await bulking, merge: await merging };
    noDeadlock(outcome);
    expect(outcome).toEqual({ bulk: 'done', merge: 'done' });
  });

  it('the merge first: the batch waits, and both finish', async () => {
    const where = await pair();
    const merging = pausedMerge(where);
    await merging.paused;
    const bulking = finished(bulk(where, [where.high, where.low]));
    await waitingForLock(database);
    merging.release();
    const outcome = { bulk: await bulking, merge: await merging.running };
    noDeadlock(outcome);
    expect(outcome).toEqual({ bulk: 'done', merge: 'done' });
  });
});

describe('a merge against an import', () => {
  it('the batch first, its rows newest first: the merge waits, and both finish', async () => {
    const where = await pair();
    const importing = await blockedImport(where);
    await waitingForLock(database);
    const merging = finished(merge(where));
    await waitingForLock(database, 2);
    await importing.release();
    const outcome = { import: await importing.running, merge: await merging };
    noDeadlock(outcome);
    // The import changed both contacts while the merge waited, so the merge may be told
    // to reload; that is an answer of its own, not a deadlock.
    expect(outcome.import).toBe('done');
    expect(['done', 'ConflictError']).toContain(outcome.merge);
  });

  it('the merge first: the batch waits, and both finish', async () => {
    const where = await pair();
    const merging = pausedMerge(where);
    await merging.paused;
    const file = await uploadCsv(
      files,
      services,
      where.space.owner,
      `Email\r\n${where.email.high}\r\n${where.email.low}\r\n`,
    );
    const job = importJob.parse(
      await importApi(services, files).call('startImport', where.space.owner, {
        body: {
          fileId: file.id,
          object: 'contact',
          mode: 'update',
          mapping: [{ column: 0, target: attribute('email') }],
        },
      }),
    );
    const importing = finished(runImportJob(services, files, where.space.system, job.id));
    await waitingForLock(database);
    merging.release();
    const outcome = { import: await importing, merge: await merging.running };
    noDeadlock(outcome);
    expect(outcome).toEqual({ import: 'done', merge: 'done' });
  });
});

describe('a bulk action against another', () => {
  it.each([
    ['newest first', 'oldest first'],
    ['oldest first', 'newest first'],
  ] as const)(
    'the first over the contacts %s, the second %s: the second waits, and both finish',
    async (firstOrder, secondOrder) => {
      const where = await pair();
      const order = (named: string) =>
        named === 'newest first' ? [where.high, where.low] : [where.low, where.high];
      const paused = gate();
      const held = gate();
      const first = finished(
        bulk(where, order(firstOrder), { paused: paused.open, held: held.opened }),
      );
      await paused.opened;
      const second = finished(bulk(where, order(secondOrder)));
      await waitingForLock(database);
      held.open();
      const outcome = { first: await first, second: await second };
      noDeadlock(outcome);
      expect(outcome).toEqual({ first: 'done', second: 'done' });
    },
  );
});
