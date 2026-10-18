// Which workflow actions use a template: the Send email
// steps, in each automation's draft and in the version it runs now, that sync with the
// template, refer to it the older way, or hold a copy made from it. A copy is listed apart
// from a link: a library edit reaches a link and never a copy.
import type { TemplateWorkflowAction, TemplateWorkflowActionList } from '@repo/contracts';
import type { Invocation } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { parsePublicId, toPublicId, ValidationError } from '@repo/kernel';
import { readTemplate } from '@repo/module-messaging';
import { sql } from 'kysely';
import * as z from 'zod';

// Only what the inventory shows is read, so a document a later format would refuse still lists.
const stepsOf = z.looseObject({
  steps: z
    .record(
      z.string(),
      z.looseObject({
        type: z.string().optional(),
        label: z.string().optional(),
        config: z
          .looseObject({
            mode: z.string().optional(),
            template: z.string().optional(),
            source: z
              .looseObject({ id: z.string().optional(), revision: z.string().optional() })
              .optional(),
          })
          .optional(),
      }),
    )
    .catch({}),
});

export async function readTemplateWorkflowActions(
  trx: DatabaseTransaction,
  invocation: Invocation,
  template: string,
  query: { readonly after?: string | undefined; readonly limit: number },
): Promise<TemplateWorkflowActionList> {
  // Not found for a template that is not this business's, as reading it is.
  const current = await readTemplate(trx, invocation, template);
  const after = query.after === undefined ? undefined : parsePublicId('automation', query.after);
  if (query.after !== undefined && after === undefined)
    throw new ValidationError([
      {
        path: '/after',
        code: 'unknown_automation',
        message: 'Start after an automation in this list.',
      },
    ]);
  const { rows } = await sql<{
    id: string;
    name: string;
    status: string;
    draft: unknown;
    version_id: string | null;
    document: unknown;
  }>`
    select a.id, a.name, a.status, a.draft, v.id as version_id, v.document
    from automation.automations a
    left join automation.versions v
      on v.business_id = a.business_id and v.id = a.published_version_id
    where a.status <> 'archived'
      and (${after ?? null}::uuid is null or a.id > ${after ?? null}::uuid)
      and (
        jsonb_path_exists(a.draft,
          '$.steps.* ? (@.type == "email.send" && (@.config.template == $template || @.config.template == $name || @.config.source.id == $template))',
          jsonb_build_object('template', ${current.id}::text, 'name', ${current.name}::text))
        or jsonb_path_exists(v.document,
          '$.steps.* ? (@.type == "email.send" && (@.config.template == $template || @.config.template == $name || @.config.source.id == $template))',
          jsonb_build_object('template', ${current.id}::text, 'name', ${current.name}::text))
      )
    order by a.id
    limit ${query.limit + 1}
  `.execute(trx);
  const page = rows.slice(0, query.limit);
  const items: TemplateWorkflowAction[] = [];
  for (const row of page) {
    const automation = {
      id: toPublicId('automation', row.id),
      name: row.name,
      status: row.status,
    };
    const scopes = [
      { scope: 'draft' as const, version: null, document: row.draft },
      ...(row.version_id === null
        ? []
        : [
            {
              scope: 'published' as const,
              version: toPublicId('automation_version', row.version_id),
              document: row.document,
            },
          ]),
    ];
    for (const { scope, version, document } of scopes) {
      const parsed = stepsOf.safeParse(document);
      if (!parsed.success) continue;
      for (const [step, each] of Object.entries(parsed.data.steps)) {
        const config = each.config;
        if (each.type !== 'email.send' || config === undefined) continue;
        const mode =
          // A draft may still name the template; a published document holds its id.
          config.template === current.id || (scope === 'draft' && config.template === current.name)
            ? ('reference' as const)
            : config.source?.id !== current.id
              ? undefined
              : config.mode === 'sync'
                ? ('sync' as const)
                : ('copy' as const);
        if (mode === undefined) continue;
        const sourceRevision =
          mode === 'reference' || !/^[0-9a-f]{64}$/.test(config.source?.revision ?? '')
            ? null
            : (config.source?.revision ?? null);
        items.push({
          automation,
          scope,
          version,
          step,
          label: each.label ?? null,
          mode,
          sourceRevision,
          current: mode === 'copy' ? sourceRevision === current.revision : null,
        });
      }
    }
  }
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last !== undefined ? toPublicId('automation', last.id) : null,
  };
}
