// What template authoring asks of automations, which send the templates: which live
// automations send one, so archiving it can say what stops, and which merge fields a send
// can fill in, so a template that could never be sent is named when it's saved. Messaging
// can't import this module; the server hands these readers to its template routes.
import {
  contactFieldPaths,
  attributionPaths,
  contactMergeFields,
  triggerLinkMergeKey,
  type MessageTemplateUse,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId, type TenantContext } from '@repo/kernel';
import { sql } from 'kysely';

import { customValuesByPath } from './values.js';

/**
 * The active and paused automations that send this template as it is at each send (an
 * older reference, or a step that syncs with it), by name: their published version does,
 * or runs still going on an earlier version will (a run stays on the version it began
 * with), which `runsInProgress` marks when only those do. A step holding a copy made from
 * it does not count: it sends its own. A published document holds the template's public
 * id, whatever the draft called it. Drafts, versions nothing runs on any more and archived
 * automations, whose runs were cancelled, don't count.
 */
export async function readTemplateUses(
  trx: DatabaseTransaction,
  _context: TenantContext,
  template: string,
): Promise<MessageTemplateUse[]> {
  const { rows } = await sql<{ id: string; name: string; status: string; published: boolean }>`
    select a.id, a.name, a.status, bool_or(v.id = a.published_version_id) as published
    from automation.automations a
    join automation.versions v
      on v.business_id = a.business_id and v.automation_id = a.id
    where a.status in ('active', 'paused')
      and (
        v.id = a.published_version_id
        or exists (
          select from automation.enrolments run
          where run.business_id = v.business_id and run.version_id = v.id
            and run.status in ('running', 'waiting'))
      )
      and jsonb_path_exists(v.document,
        '$.steps.* ? (@.type == "email.send" && (@.config.template == $template || (@.config.mode == "sync" && @.config.source.id == $template)))',
        jsonb_build_object('template', ${template}::text))
    group by a.id, a.name, a.status
    order by a.name, a.id
  `.execute(trx);
  return rows.map((row) => ({
    id: toPublicId('automation', row.id),
    name: row.name,
    status: row.status === 'paused' ? 'paused' : 'active',
    ...(row.published ? {} : { runsInProgress: true as const }),
  }));
}

/**
 * How many workflows use each of some templates in a Send email step, in their draft or
 * their running version: by the template's id, by its name (a draft may still name it), or
 * as the template a step syncs with or was copied from. The same workflows the inventory
 * lists one template at a time (email-template-actions.ts), counted for a page of templates
 * in one statement, so a list of templates does not ask once a row. Archived workflows are
 * not counted. Every template asked about is answered, with 0 when nothing uses it.
 */
export async function readTemplateUseCounts(
  trx: DatabaseTransaction,
  _context: TenantContext,
  templates: readonly { readonly id: string; readonly name: string }[],
): Promise<ReadonlyMap<string, number>> {
  if (templates.length === 0) return new Map();
  const { rows } = await sql<{ id: string; uses: number }>`
    select t.id, count(a.id)::integer as uses
    from unnest(${templates.map((each) => each.id)}::text[], ${templates.map((each) => each.name)}::text[])
      as t(id, name)
    left join automation.automations a
      on a.status <> 'archived'
     and (
       jsonb_path_exists(a.draft,
         '$.steps.* ? (@.type == "email.send" && (@.config.template == $template || @.config.template == $name || @.config.source.id == $template))',
         jsonb_build_object('template', t.id, 'name', t.name))
       or exists (
         select from automation.versions v
         where v.business_id = a.business_id and v.id = a.published_version_id
           and jsonb_path_exists(v.document,
             '$.steps.* ? (@.type == "email.send" && (@.config.template == $template || @.config.template == $name || @.config.source.id == $template))',
             jsonb_build_object('template', t.id, 'name', t.name))
       )
     )
    group by t.id
  `.execute(trx);
  return new Map(rows.map((row) => [row.id, row.uses]));
}

/**
 * Every merge field a template send can fill in for a contact of this business, exactly
 * as contactValues names them: the built-in contact fields; where the contact came from
 * (its first and latest touch, contact.attribution.*); each live custom contact field
 * under contact.custom.<key> and its merge key contact.<key>; the keys merged fields left
 * behind; and each custom value that has something in it, as custom_values.<key> and
 * values.<key>. Nothing else reaches a template: not a deal's fields (opportunity.<key>),
 * not a company's (business.<key>).
 */
// The contact's own two touches. How a run's lead arrived (trigger.attribution.*) belongs
// to a run, and a template sent outside one has none.
const CONTACT_ATTRIBUTION = attributionPaths.filter((path) => path.startsWith('contact.'));

export async function readTemplateFields(trx: DatabaseTransaction): Promise<string[]> {
  const custom = await trx
    .selectFrom('crm.field_definitions as field')
    .innerJoin('crm.object_types as type', (join) =>
      join
        .onRef('type.business_id', '=', 'field.business_id')
        .onRef('type.id', '=', 'field.object_type_id'),
    )
    .select((eb) => [
      'field.key',
      eb
        .selectFrom('crm.field_key_aliases as alias')
        .select((inner) => inner.fn.agg<string[]>('array_agg', ['alias.alias_key']).as('keys'))
        .whereRef('alias.business_id', '=', 'field.business_id')
        .whereRef('alias.field_id', '=', 'field.id')
        .as('aliases'),
    ])
    .where('type.kind', '=', 'contact')
    .where('field.archived_at', 'is', null)
    // A text box list's boxes and a file upload field's files are no text to put in a
    // message, so neither is a merge field a send can fill in.
    .where('field.value_type', 'not in', ['text_list', 'file'])
    .orderBy('field.key')
    .execute();
  const links = await trx
    .selectFrom('messaging.trigger_links')
    .select('key')
    .orderBy('key')
    .execute();
  return [
    ...new Set([
      ...contactMergeFields,
      ...CONTACT_ATTRIBUTION,
      ...custom.flatMap((field) =>
        [field.key, ...(field.aliases ?? []).sort()].flatMap(contactFieldPaths),
      ),
      ...Object.keys(await customValuesByPath(trx)).sort(),
      // A trigger link, which a send turns into the contact's own address for it.
      ...links.map((link) => triggerLinkMergeKey(link.key)),
    ]),
  ];
}
