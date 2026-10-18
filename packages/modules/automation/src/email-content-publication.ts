import type { AutomationDocument } from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, ValidationError, type TenantContext } from '@repo/kernel';

/**
 * Each published copy owns its content history; legacy references keep their existing
 * semantics. A step that syncs with a template gets a binding too: its revision names the
 * template and keeps the content as it was when published, for the record only. Every send
 * reads the template itself (email-content-resolution.ts).
 */
export async function publishEmailContent(
  trx: DatabaseTransaction,
  context: TenantContext,
  automationId: string,
  versionId: string,
  document: AutomationDocument,
): Promise<void> {
  const businessId = context.businessId;
  if (businessId === undefined) throw new Error('Publishing email content needs a business.');
  for (const [key, step] of Object.entries(document.steps)) {
    if (step.type !== 'email.send' || !('mode' in step.config)) continue;
    const { config } = step;
    const source = config.source;
    const sourceId = source === undefined ? null : parsePublicId('template', source.id);
    if (sourceId === undefined)
      throw new Error('Published email provenance needs a valid template id.');
    let content: {
      subject: string;
      body: string;
      body_html: string | null;
      preheader: string | null;
    };
    if (config.mode === 'copy')
      content = {
        subject: config.subject,
        body: config.body,
        body_html: config.html ?? null,
        // Preview text is hidden text of the formatted part; plain text has nowhere for it.
        preheader: config.html === undefined ? null : (config.preheader ?? null),
      };
    else {
      const template =
        sourceId === null
          ? undefined
          : await trx
              .selectFrom('messaging.templates')
              .select(['subject', 'body', 'body_html', 'preheader'])
              .where('id', '=', sourceId)
              .where('channel', '=', 'email')
              .where('archived_at', 'is', null)
              .executeTakeFirst();
      // Publishing a step whose template is gone would publish a step that cannot send.
      if (template === undefined)
        throw new ValidationError([
          {
            path: `/steps/${key}/config/source`,
            code: 'template_unavailable',
            message:
              'The template this step syncs with is gone or archived. Choose another, or turn sync off.',
          },
        ]);
      content = template;
    }
    const { id } = await trx
      .insertInto('automation.email_bindings')
      .values({
        business_id: businessId,
        automation_id: automationId,
        version_id: versionId,
        step: key,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('automation.email_content_revisions')
      .values({
        business_id: businessId,
        binding_id: id,
        revision: 1,
        mode: config.mode,
        source_template_id: sourceId,
        source_revision: source?.revision ?? null,
        ...content,
        created_by_kind: context.actorKind,
        created_by_id: context.actorId ?? null,
      })
      .execute();
  }
}
