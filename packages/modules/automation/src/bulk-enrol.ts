// Contacts → Bulk Actions → "Add to workflow": what the CRM's bulk action needs of
// workflows. Only a published workflow that is not paused can be chosen, and each contact
// is enrolled by enrol, so once at a time and again only as the workflow's re-entry setting
// allows, as a trigger would. The run has no event behind it: it carries the bulk request's
// correlation, and its first step reads the contact as it is.
import { requireBusiness } from '@repo/commands';
import { automationDocument } from '@repo/contracts';
import { parsePublicId } from '@repo/kernel';
import type { BulkWorkflows } from '@repo/module-crm';

import { enrol, lockRecordRuns } from './enrolment.js';

export const bulkWorkflows: BulkWorkflows = {
  async resolve(trx, _invocation, workflowId) {
    const id = parsePublicId('automation', workflowId);
    const row =
      id === undefined
        ? undefined
        : await trx
            .selectFrom('automation.automations')
            .select(['id', 'status', 'published_version_id'])
            .where('id', '=', id)
            .where('status', '<>', 'archived')
            .executeTakeFirst();
    if (row === undefined) return 'not_found';
    return row.status === 'active' && row.published_version_id !== null
      ? { id: row.id }
      : 'not_published';
  },

  async enrol(trx, invocation, workflowId, contactId) {
    const businessId = requireBusiness(invocation.context);
    // The record's runs held still, as every start of a run takes them.
    await lockRecordRuns(trx, contactId);
    const live = await trx
      .selectFrom('automation.automations as automation')
      .innerJoin('automation.versions as version', (join) =>
        join
          .onRef('version.business_id', '=', 'automation.business_id')
          .onRef('version.id', '=', 'automation.published_version_id'),
      )
      .select(['automation.status', 'version.id as version_id', 'version.document'])
      .where('automation.id', '=', workflowId)
      .executeTakeFirst();
    // Paused, deleted or unpublished since the action began.
    if (live?.status !== 'active') return 'unavailable';
    const enrolled = await enrol(
      trx,
      businessId,
      workflowId,
      live.version_id,
      contactId,
      automationDocument.parse(live.document),
      {
        eventId: null,
        correlationId: invocation.context.correlationId,
        triggerId: null,
        state: { addedBy: 'bulk_action' },
      },
    );
    return enrolled.outcome;
  },
};
