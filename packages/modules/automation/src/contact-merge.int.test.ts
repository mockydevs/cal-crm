// Automation's part in a contact merge, against a migrated Postgres as crm_app: the merged
// contact's runs carry on as the kept contact's, a run in a workflow the kept contact is
// already in ends as contact_merged, and what runs listen for and what date triggers fired
// move with them. Then the merge against a workflow step on the same contact, on two
// connections both ways round: one waits for the other, and neither is a deadlock's victim.
import { randomUUID } from 'node:crypto';

import { runCommand, type Invocation } from '@repo/commands';
import { contactMerge, contactMergePreview } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import {
  contactBulkRoutes,
  contactMergeRoutes,
  type ContactMergeParticipant,
} from '@repo/module-crm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startHarness, waitsADay, type Harness, type Tenant } from '../test/workflows.js';
import { bulkWorkflows } from './bulk-enrol.js';
import { automationContactMerge, CONTACT_MERGED } from './contact-merge.js';
import { createRunStepCommand } from './runner.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const person = (tenant: Tenant): Invocation => ({
  context: { ...tenant, actorKind: 'user', correlationId: randomUUID() },
  permissions: 'all',
});

/** Merges `merged` into `kept` with the revisions the preview gives, as the dialog does. */
async function merge(
  tenant: Tenant,
  kept: string,
  merged: string,
  participants: readonly ContactMergeParticipant[],
) {
  const routes = contactMergeRoutes({ participants });
  const route = (id: string) => routes.find((each) => each.endpoint.operationId === id);
  const id = toPublicId('contact', kept);
  const mergeIds = [toPublicId('contact', merged)];
  const preview = contactMergePreview.parse(
    await route('previewContactMerge')?.run(
      {
        invocation: person(tenant),
        params: { id },
        query: { mergeIds: mergeIds.join(',') },
        body: undefined,
      },
      h.services,
    ),
  );
  const revisions = Object.fromEntries(preview.contacts.map((each) => [each.id, each.revision]));
  return {
    preview,
    merged: contactMerge.parse(
      await route('mergeContacts')?.run(
        { invocation: person(tenant), params: { id }, query: {}, body: { mergeIds, revisions } },
        h.services,
      ),
    ),
  };
}

const sql = <Row extends object>(tenant: Tenant, text: string, values: unknown[] = []) =>
  h.database.withTenant(tenant, (each) => each.query<Row>(text, values));

interface RunRow {
  id: string;
  automation_id: string;
  record_id: string;
  reentry_key: string;
  status: string;
  exit_reason: string | null;
}
const runsOf = (tenant: Tenant, automationId: string) =>
  sql<RunRow>(
    tenant,
    `select id, automation_id, record_id, reentry_key, status, exit_reason
     from automation.enrolments where automation_id = $1 order by id`,
    [automationId],
  );

describe('runs', () => {
  it("carry on as the kept contact's, unless it is in that workflow already", async () => {
    const tenant = await h.business();
    const both = await h.publish(tenant);
    const kept = await h.enrol(tenant, 'Kept');
    const only = await h.publish(tenant, { ...waitsADay, name: 'Second' });
    const merged = await h.enrol(tenant, 'Merged');
    const [keptRun] = await runsOf(tenant, both.automationId);
    const [mergedOnly] = await runsOf(tenant, only.automationId);
    if (keptRun === undefined || mergedOnly === undefined) throw new Error('Expected runs.');
    // What the run in the second workflow listens for and waits on, and a date trigger's
    // bookkeeping for both contacts: one day both have, one only the merged contact has.
    await sql(
      tenant,
      `insert into automation.event_waits (business_id, enrolment_id, event_type, kind, record_id)
       values (app.business_id(), $1, 'message.received', 'reply', $2)`,
      [mergedOnly.id, merged.contactId],
    );
    await sql(
      tenant,
      `insert into automation.manual_actions
         (business_id, automation_id, contact_id, enrolment_id, kind, step_key)
       values (app.business_id(), $1, $2, $3, 'call', 'call')`,
      [only.automationId, merged.contactId, mergedOnly.id],
    );
    await sql(
      tenant,
      `insert into automation.trigger_firings
         (business_id, automation_id, trigger_id, record_id, occurrence)
       values (app.business_id(), $1, 'birthday', $2, '2026-10-01'),
              (app.business_id(), $1, 'birthday', $3, '2026-10-01'),
              (app.business_id(), $1, 'birthday', $3, '2026-10-02')`,
      [both.automationId, kept.contactId, merged.contactId],
    );
    await sql(
      tenant,
      `insert into automation.trigger_evaluations
         (business_id, automation_id, event_id, event_type, reason, record_id, trigger_id)
       values (app.business_id(), $1, $2, 'contact.created', 'filter_mismatch', $3, 'created'),
              (app.business_id(), $1, $2, 'contact.created', 'filter_mismatch', $4, 'created'),
              (app.business_id(), $1, $5, 'contact.created', 'filter_mismatch', $4, 'created')`,
      [both.automationId, kept.eventId, kept.contactId, merged.contactId, merged.eventId],
    );

    const { preview, merged: result } = await merge(tenant, kept.contactId, merged.contactId, [
      automationContactMerge,
    ]);

    expect(preview.moved['automation']).toMatchObject({
      runs: 2,
      waits: 1,
      triggerFirings: 2,
      triggerEvaluations: 2,
      manualActions: 1,
    });
    expect(result.moved['automation']).toEqual({
      runs: 2,
      runsEnded: 1,
      waits: 1,
      triggerFirings: 1,
      triggerEvaluations: 1,
      manualActions: 1,
    });
    expect(await runsOf(tenant, both.automationId)).toEqual([
      expect.objectContaining({ id: keptRun.id, record_id: kept.contactId, status: 'running' }),
      expect.objectContaining({
        record_id: kept.contactId,
        reentry_key: kept.contactId,
        status: 'exited',
        exit_reason: CONTACT_MERGED,
      }),
    ]);
    expect(await runsOf(tenant, only.automationId)).toEqual([
      expect.objectContaining({
        id: mergedOnly.id,
        record_id: kept.contactId,
        reentry_key: kept.contactId,
        status: 'running',
      }),
    ]);
    expect(await h.events(tenant, 'automation.run.stopped')).toEqual([
      expect.objectContaining({
        payload: { automationId: both.id, reason: CONTACT_MERGED },
      }),
    ]);
    expect(
      await sql(
        tenant,
        `select (select count(*)::int from automation.event_waits where record_id = $1) as waits,
           (select count(*)::int from automation.manual_actions where contact_id = $1) as actions,
           (select count(*)::int from automation.trigger_firings where record_id = $1) as firings,
           (select count(*)::int from automation.trigger_evaluations where record_id = $1)
             as evaluations,
           (select count(*)::int from automation.trigger_firings where record_id = $2)
             + (select count(*)::int from automation.trigger_evaluations where record_id = $2)
             as left_behind`,
        [kept.contactId, merged.contactId],
      ),
    ).toEqual([{ waits: 1, actions: 1, firings: 2, evaluations: 2, left_behind: 0 }]);
    // The moved run goes on: its wait ends a day later and its next step runs.
    expect(await h.step(tenant, mergedOnly.id, new Date(Date.now() + 2 * 86_400_000))).toBe('ran');
    expect(await h.differences()).toEqual([]);
  });

  it('leaves every run where it was when the merge fails after it', async () => {
    const tenant = await h.business();
    const workflow = await h.publish(tenant);
    const kept = await h.enrol(tenant, 'Kept');
    const merged = await h.enrol(tenant, 'Merged');
    const failing: ContactMergeParticipant = {
      name: 'failing',
      merge: () => Promise.reject(new Error('A later module failed.')),
    };
    await expect(
      merge(tenant, kept.contactId, merged.contactId, [automationContactMerge, failing]),
    ).rejects.toThrow('A later module failed.');
    expect(
      (await runsOf(tenant, workflow.automationId)).map((run) => [run.record_id, run.status]),
    ).toEqual([
      [kept.contactId, 'running'],
      [merged.contactId, 'running'],
    ]);
    expect(await h.events(tenant, 'automation.run.stopped')).toEqual([]);
  });
});

/** A promise and the function that settles it. */
function gate(): { readonly opened: Promise<void>; open(): void } {
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

/** Waits until some session of this database waits on a lock. */
async function someoneWaits(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await h.database.as('postgres', (each) =>
      each.query<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`,
      ),
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Fixture timeout: nobody waited on a lock.');
}

describe('a merge against a workflow step on the same contact', () => {
  // A task step reads the contact's owner's membership with its run's row held and before it
  // locks the contact to add the task: the hook below holds the step right there.
  async function scene() {
    const tenant = await h.business();
    await h.publish(tenant, {
      name: 'Follow up',
      triggers: [{ id: 'created', type: 'contact.created', config: {} }],
      start: 'follow',
      steps: { follow: { type: 'task.create', config: { title: 'Call back' } } },
    });
    const owner = await h.database.fixtures.user();
    const kept = await h.enrol(tenant, 'Kept');
    const merged = await h.enrol(tenant, 'Merged');
    await sql(tenant, 'update crm.contacts set owner_user_id = $1 where id = any($2::uuid[])', [
      owner.id,
      [kept.contactId, merged.contactId],
    ]);
    return { tenant, kept, merged };
  }

  function pausingStep(held: Promise<void>, paused: () => void) {
    return createRunStepCommand({
      tasks: {
        actorNames: {},
        assignees: {
          resolve: () => Promise.resolve(null),
          read: () => Promise.resolve({ items: [], nextCursor: null }),
          memberships: async () => {
            paused();
            await held;
            return new Map<string, string>();
          },
        },
      },
      smsAvailable: true,
      appointmentLinks: { manageUrl: () => Promise.resolve('https://crm.example.test/a') },
    });
  }

  const stepOf = async (
    tenant: Tenant,
    enrolmentId: string,
    held: Promise<void>,
    paused: () => void,
  ) => {
    const { sequence } = await h.run(tenant, enrolmentId);
    return runCommand(
      h.services,
      pausingStep(held, paused),
      { enrolmentId, sequence },
      // Steps are the engine's: they run as the system, as the worker runs them.
      { context: { ...tenant, correlationId: randomUUID() }, permissions: 'all' },
    );
  };

  it.each(['kept', 'merged'] as const)(
    "the %s contact's step first: the merge waits for its run, and both finish",
    async (which) => {
      const { tenant, kept, merged } = await scene();
      const held = gate();
      const paused = gate();
      const [enrolmentId] = (which === 'kept' ? kept : merged).enrolments;
      if (enrolmentId === undefined) throw new Error('Expected a run.');
      const stepping = finished(
        stepOf(tenant, enrolmentId, held.opened, () => {
          paused.open();
        }),
      );
      // A step that ends before it reaches the hook would leave the test waiting for it.
      await Promise.race([
        paused.opened,
        stepping.then((outcome) => Promise.reject(new Error(`The step ended: ${outcome}.`))),
      ]);
      const merging = finished(
        merge(tenant, kept.contactId, merged.contactId, [automationContactMerge]),
      );
      await someoneWaits();
      held.open();
      expect(await stepping).toBe('done');
      expect(await merging).toBe('done');
    },
  );

  it.each(['kept', 'merged'] as const)(
    "the merge first: the %s contact's step waits, then runs as the kept contact's",
    async (which) => {
      const { tenant, kept, merged } = await scene();
      const held = gate();
      const paused = gate();
      const [enrolmentId] = (which === 'kept' ? kept : merged).enrolments;
      if (enrolmentId === undefined) throw new Error('Expected a run.');
      const merging = finished(
        merge(tenant, kept.contactId, merged.contactId, [
          automationContactMerge,
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
      await paused.opened;
      const stepping = finished(stepOf(tenant, enrolmentId, Promise.resolve(), () => undefined));
      await someoneWaits();
      held.open();
      expect(await merging).toBe('done');
      expect(await stepping).toBe('done');
    },
  );
});

describe('a merge against a bulk "Add to workflow" batch of the same contacts', () => {
  /**
   * Starts the bulk action over both contacts; its first enrolment waits for `held`, with the
   * batch holding both contacts, once `paused` is called.
   */
  function bulk(
    tenant: Tenant,
    workflowId: string,
    contacts: readonly string[],
    pause?: { readonly paused: () => void; readonly held: Promise<void> },
  ) {
    let calls = 0;
    const start = contactBulkRoutes({
      actorNames: {},
      assignees: {
        resolve: () => Promise.resolve(null),
        memberships: () => Promise.resolve(new Map<string, string>()),
      },
      workflows: {
        ...bulkWorkflows,
        async enrol(trx, invocation, workflow, contactId) {
          calls += 1;
          if (calls === 1 && pause !== undefined) {
            pause.paused();
            await pause.held;
          }
          return bulkWorkflows.enrol(trx, invocation, workflow, contactId);
        },
      },
    }).find((each) => each.endpoint.operationId === 'bulkUpdateContacts');
    if (start === undefined) throw new Error('Missing the bulk route.');
    return start.run(
      {
        invocation: person(tenant),
        params: {},
        query: {},
        body: { action: 'add_to_workflow', workflowId, selection: { ids: [...contacts] } },
      },
      h.services,
    );
  }

  async function scene() {
    const tenant = await h.business();
    const workflow = await h.publish(tenant, { ...waitsADay, name: 'Bulk' });
    const kept = await h.contact(tenant, 'Kept');
    const merged = await h.contact(tenant, 'Merged');
    return { tenant, workflow, kept, merged };
  }

  it('the batch first: the merge waits for it, and both finish', async () => {
    const { tenant, workflow, kept, merged } = await scene();
    const held = gate();
    const paused = gate();
    const bulking = finished(
      bulk(tenant, workflow.id, [kept.contact, merged.contact], {
        paused: () => {
          paused.open();
        },
        held: held.opened,
      }),
    );
    await Promise.race([
      paused.opened,
      bulking.then((outcome) => Promise.reject(new Error(`The batch ended: ${outcome}.`))),
    ]);
    const merging = finished(
      merge(tenant, kept.contactId, merged.contactId, [automationContactMerge]),
    );
    await someoneWaits();
    held.open();
    expect({ bulk: await bulking, merge: await merging }).toEqual({ bulk: 'done', merge: 'done' });
    // Both were enrolled; the merged contact's run ended as a duplicate of the kept one's.
    expect((await runsOf(tenant, workflow.automationId)).map((run) => run.status).sort()).toEqual([
      'exited',
      'running',
    ]);
  });

  it('the merge first: the batch waits for it, and both finish', async () => {
    const { tenant, workflow, kept, merged } = await scene();
    const held = gate();
    const paused = gate();
    const merging = finished(
      merge(tenant, kept.contactId, merged.contactId, [
        automationContactMerge,
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
    await paused.opened;
    const bulking = finished(bulk(tenant, workflow.id, [kept.contact, merged.contact]));
    await someoneWaits();
    held.open();
    expect({ bulk: await bulking, merge: await merging }).toEqual({ bulk: 'done', merge: 'done' });
  });
});
