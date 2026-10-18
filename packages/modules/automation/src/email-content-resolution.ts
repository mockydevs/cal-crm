import type { DatabaseTransaction } from '@repo/db';

export interface PublishedEmailContent {
  readonly binding: string;
  readonly revision: number;
  readonly subject: string;
  readonly body: string;
  readonly html: string | null;
  readonly preheader: string | null;
}

/**
 * Resolve content through the enrolment's pinned version, never the workflow's current live
 * version. A copy's content is its binding's current revision. A step that syncs reads the
 * library template as it is now, so an edit made anywhere reaches every step that syncs
 * with it at its next send; `unavailable` when that template is gone or archived, which
 * fails the step and never falls back to older content.
 */
export async function readPublishedEmailContent(
  trx: DatabaseTransaction,
  enrolmentId: string,
  step: string,
): Promise<PublishedEmailContent | 'unavailable' | undefined> {
  const row = await trx
    .selectFrom('automation.enrolments as enrolment')
    .innerJoin('automation.email_bindings as binding', (join) =>
      join
        .onRef('binding.business_id', '=', 'enrolment.business_id')
        .onRef('binding.automation_id', '=', 'enrolment.automation_id')
        .onRef('binding.version_id', '=', 'enrolment.version_id'),
    )
    .innerJoin('automation.email_content_revisions as content', (join) =>
      join
        .onRef('content.business_id', '=', 'binding.business_id')
        .onRef('content.binding_id', '=', 'binding.id')
        .onRef('content.revision', '=', 'binding.current_revision'),
    )
    .select([
      'binding.id as binding',
      'content.revision',
      'content.mode',
      'content.subject',
      'content.body',
      'content.body_html',
      'content.preheader',
      'content.source_template_id',
    ])
    .where('enrolment.id', '=', enrolmentId)
    .where('binding.step', '=', step)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  if (row.mode === 'copy')
    return {
      binding: row.binding,
      revision: row.revision,
      subject: row.subject,
      body: row.body,
      html: row.body_html,
      preheader: row.preheader,
    };
  if (row.mode !== 'sync' || row.source_template_id === null) return undefined;
  const template = await trx
    .selectFrom('messaging.templates')
    .select(['subject', 'body', 'body_html', 'preheader'])
    .where('id', '=', row.source_template_id)
    .where('channel', '=', 'email')
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (template === undefined) return 'unavailable';
  return {
    binding: row.binding,
    revision: row.revision,
    subject: template.subject,
    body: template.body,
    html: template.body_html,
    preheader: template.preheader,
  };
}
