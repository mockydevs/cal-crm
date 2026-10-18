// Contacts → Bulk Actions → "Add to workflow", through the CRM's own bulk action with the
// engine's enrolment behind it: only a published workflow that is not paused, each contact
// enrolled once at a time, again only where re-entry allows, each skip with its reason.
import { randomUUID } from 'node:crypto';

import { contactBulkItemList } from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { contactBulkRoutes } from '@repo/module-crm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { bulkWorkflows } from './bulk-enrol.js';
import { startHarness, waitsADay, type Harness, type Tenant } from '../test/workflows.js';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const routes = contactBulkRoutes({
  actorNames: {},
  assignees: {
    resolve: () => Promise.resolve(null),
    memberships: () => Promise.resolve(new Map<string, string>()),
  },
  workflows: bulkWorkflows,
});
const route = (operationId: string) => {
  const found = routes.find((each) => each.endpoint.operationId === operationId);
  if (found === undefined) throw new Error(`Missing ${operationId}`);
  return found;
};
const as = (tenant: Tenant) => ({
  context: { ...tenant, correlationId: randomUUID() },
  permissions: 'all' as const,
});
const addTo = (tenant: Tenant, workflowId: string, ids: readonly string[]) =>
  route('bulkUpdateContacts').run(
    {
      invocation: as(tenant),
      params: {},
      query: {},
      body: { action: 'add_to_workflow', workflowId, selection: { ids } },
    },
    h.services,
  ) as Promise<{ id: string; done: number; skipped: number }>;
const reasons = async (tenant: Tenant, actionId: string) =>
  contactBulkItemList
    .parse(
      await route('listContactBulkActionItems').run(
        { invocation: as(tenant), params: { id: actionId }, query: {}, body: undefined },
        h.services,
      ),
    )
    .items.map((item) => item.reason?.code ?? item.outcome);

const runsOf = (tenant: Tenant, contactId: string) =>
  withTenant(h.db, tenant, (trx) =>
    trx
      .selectFrom('automation.enrolments')
      .select(['id', 'status', 'trigger_event_id', 'state'])
      .where('record_id', '=', contactId)
      .orderBy('id')
      .execute(),
  );

it('enrols each contact once at a time, by the rules a trigger keeps', async () => {
  const tenant = await h.business();
  const published = await h.publish(tenant, {
    ...waitsADay,
    settings: { reEnrollment: 'after_finished', timezone: 'business' },
  });
  const ada = await h.contact(tenant, 'Ada');
  const grace = await h.contact(tenant, 'Grace');
  // Grace is in it already, through her own event.
  await h.match(tenant, grace.eventId);
  const action = await addTo(tenant, published.id, [ada.contact, grace.contact]);
  expect(action).toMatchObject({ done: 1, skipped: 1 });
  expect(await reasons(tenant, action.id)).toEqual(['done', 'already_in_workflow']);
  const [run] = await runsOf(tenant, ada.contactId);
  // A run with no event behind it, which goes on as any other.
  expect(run).toMatchObject({
    status: 'running',
    trigger_event_id: null,
    state: { addedBy: 'bulk_action', sequence: 0 },
  });
  expect(await h.step(tenant, run?.id ?? '')).toBe('ran');
});

it('skips a contact that went through a workflow that takes a contact once', async () => {
  const tenant = await h.business();
  const once = await h.publish(tenant, {
    name: 'Once',
    triggers: [{ id: 'created', type: 'contact.created', config: {} }],
    start: 'tag',
    steps: { tag: { type: 'wait', config: { duration: 'PT1M' } } },
    settings: { reEnrollment: 'never', timezone: 'business' },
  });
  const ada = await h.enrol(tenant, 'Ada');
  const [first] = ada.enrolments;
  await h.step(tenant, first ?? '');
  await h.step(tenant, first ?? '', new Date(Date.now() + 120_000));
  expect((await h.run(tenant, first ?? '')).status).toBe('completed');
  const action = await addTo(tenant, once.id, [ada.contact]);
  expect(await reasons(tenant, action.id)).toEqual(['reentry_not_allowed']);
});

it('takes only a published workflow that is not paused', async () => {
  const tenant = await h.business();
  const published = await h.publish(tenant);
  const ada = await h.contact(tenant, 'Ada');
  await h.database.withTenant(tenant, (sql) =>
    sql.query(`update automation.automations set status = 'paused' where id = $1`, [
      published.automationId,
    ]),
  );
  await expect(addTo(tenant, published.id, [ada.contact])).rejects.toMatchObject({
    issues: [{ path: '/workflowId', code: 'workflow_not_published' }],
  });
  await expect(
    addTo(tenant, toPublicId('automation', '0198de17-876e-7000-aac7-9bc8ac229003'), [ada.contact]),
  ).rejects.toMatchObject({ issues: [{ path: '/workflowId', code: 'unknown_workflow' }] });
  // Something that is not a workflow's id names none.
  await expect(
    withTenant(h.db, tenant, (trx) => bulkWorkflows.resolve(trx, as(tenant), 'welcome')),
  ).resolves.toBe('not_found');
  // Paused after the action began: the contacts left are skipped, said why.
  await expect(
    withTenant(h.db, tenant, (trx) =>
      bulkWorkflows.enrol(trx, as(tenant), published.automationId, ada.contactId),
    ),
  ).resolves.toBe('unavailable');
});
