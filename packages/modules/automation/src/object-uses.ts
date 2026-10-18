// What deleting a custom object asks of this module: which published workflows use it, so
// the delete is refused while one does (the owner's choice, where GoHighLevel deletes the
// workflows with the object). The CRM can't import this module; the server hands this
// reader to its object routes.
//
// A workflow uses an object when its published version runs on it (the document's object)
// or names one of its fields' merge paths, custom_objects.<key>.<field>, anywhere. A draft
// does not: deleting the object leaves it for its author to change before publishing.
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql, type SqlBool } from 'kysely';

/** The published workflows, active or paused, that use the custom object with this key. */
export async function readObjectUses(
  trx: DatabaseTransaction,
  objectKey: string,
): Promise<{ id: string; name: string }[]> {
  // Keys are lowercase letters, digits and underscores, so the key needs no escaping.
  const path = `(^|[^a-z0-9_.])custom_objects\\.${objectKey}($|[^a-z0-9_])`;
  const rows = await trx
    .selectFrom('automation.automations as automation')
    .innerJoin('automation.versions as version', (join) =>
      join
        .onRef('version.business_id', '=', 'automation.business_id')
        .onRef('version.id', '=', 'automation.published_version_id'),
    )
    .select(['automation.id', 'automation.name'])
    .where('automation.status', 'in', ['active', 'paused'])
    .where(
      sql<SqlBool>`(version.document->>'object' = ${objectKey}
        or version.document::text ~ ${path})`,
    )
    .orderBy('automation.name')
    .orderBy('automation.id')
    .execute();
  return rows.map((row) => ({ id: toPublicId('automation', row.id), name: row.name }));
}
