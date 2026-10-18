// What deleting a field asks of this module: which message templates and which automations
// use it, so the person deleting it is told what will stop being filled in. The CRM can't
// import this module; the server hands this reader to its field routes.
//
// A use is the field's merge path written anywhere in a template's subject or body, or in
// an automation's draft or published document: inside {{ }}, or as the path a condition
// or a step names. It is found by the text, so it can name a template that only mentions
// the path in passing; it never misses one that uses it.
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

export interface FieldUses {
  readonly templates: readonly { readonly id: string; readonly name: string }[];
  readonly automations: readonly { readonly id: string; readonly name: string }[];
}

/** A merge path as it may be written: letters, digits, underscores and dots, nothing else. */
const PATH = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * A PostgreSQL pattern for any of the paths as a whole path: not the tail of a longer one
 * (`other_contact.size`), nor the head of one (`contact.size_2`).
 */
function wholePath(paths: readonly string[]): string {
  const alternatives = paths
    .filter((path) => PATH.test(path))
    .map((path) => path.replaceAll('.', '\\.'));
  return `(^|[^a-z0-9_.])(${alternatives.join('|')})($|[^a-z0-9_])`;
}

/** The templates and the automations, deleted ones left out, that use any of the paths. */
export async function readFieldUses(
  trx: DatabaseTransaction,
  paths: readonly string[],
): Promise<FieldUses> {
  if (!paths.some((path) => PATH.test(path))) return { templates: [], automations: [] };
  const pattern = wholePath(paths);
  const templates = await trx
    .selectFrom('messaging.templates as template')
    .select(['template.id', 'template.name'])
    .where(sql<SqlBool>`(template.subject || E'\\n' || template.body) ~ ${pattern}`)
    .orderBy('template.name')
    .orderBy('template.id')
    .execute();
  const automations = await trx
    .selectFrom('automation.automations as automation')
    .leftJoin('automation.versions as version', (join) =>
      join
        .onRef('version.business_id', '=', 'automation.business_id')
        .onRef('version.id', '=', 'automation.published_version_id'),
    )
    .select(['automation.id', 'automation.name'])
    .where('automation.status', '<>', 'archived')
    .where(
      sql<SqlBool>`(automation.draft::text ~ ${pattern}
        or coalesce(version.document::text, '') ~ ${pattern})`,
    )
    .orderBy('automation.name')
    .orderBy('automation.id')
    .execute();
  return {
    templates: templates.map((row) => ({ id: toPublicId('template', row.id), name: row.name })),
    automations: automations.map((row) => ({
      id: toPublicId('automation', row.id),
      name: row.name,
    })),
  };
}
