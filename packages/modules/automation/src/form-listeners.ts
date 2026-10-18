// Which workflows start when a form is sent: what the in-app assistant's page checks ask of
// this module, to say "nothing happens after this form is sent" without a model. The forms
// module can't import this one; the server hands this reader to the checks.
//
// A workflow listens to a form when its published version has a "form submitted" trigger
// for that form, or for every form, and the workflow is running (not paused, not deleted).
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';

export interface FormListener {
  readonly id: string;
  readonly name: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a published document has a "form submitted" trigger that this form passes. */
export function listensToForm(document: unknown, formPublicId: string): boolean {
  if (!isRecord(document) || !Array.isArray(document['triggers'])) return false;
  return document['triggers'].some((trigger: unknown) => {
    if (!isRecord(trigger) || trigger['type'] !== 'form.submitted') return false;
    const config = trigger['config'];
    const form: unknown = isRecord(config) ? config['form'] : undefined;
    // A trigger that names no form starts on every form.
    return form === undefined || form === null || form === '' || form === formPublicId;
  });
}

/** The running workflows a submission of this form starts, by name. */
export async function readFormListeners(
  trx: DatabaseTransaction,
  formPublicId: string,
): Promise<readonly FormListener[]> {
  const rows = await trx
    .selectFrom('automation.trigger_subscriptions as subscription')
    .innerJoin('automation.automations as automation', (join) =>
      join
        .onRef('automation.id', '=', 'subscription.automation_id')
        .onRef('automation.published_version_id', '=', 'subscription.version_id'),
    )
    .innerJoin('automation.versions as version', 'version.id', 'subscription.version_id')
    .select(['automation.id', 'automation.name', 'version.document'])
    .where('subscription.event_type', '=', 'form.submitted')
    .where('automation.status', '=', 'active')
    .orderBy('automation.name')
    .orderBy('automation.id')
    .execute();
  const listeners = new Map<string, FormListener>();
  for (const row of rows)
    if (listensToForm(row.document, formPublicId))
      listeners.set(row.id, { id: toPublicId('automation', row.id), name: row.name });
  return [...listeners.values()];
}
