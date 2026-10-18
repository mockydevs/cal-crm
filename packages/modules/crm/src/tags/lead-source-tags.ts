// The tag of a lead source ("Source: Google Ads"), which a form adds by itself.
//
// Only people make tags: an automation, an assistant and a form apply the ones that exist
// (access.ts). This file is the one exception, and it is narrow on purpose:
// - it makes a tag only for a built-in lead source, a closed list of twenty names that ship
//   in the code (packages/contracts: leadSourceLabels). The name a caller hands over must be
//   that list's own name for the key, so nothing can pass its own text through here;
// - a lead source an address chose (`source=…`) is anybody's text: it is never made into a
//   tag. It gets a tag only when a person has already made one with that name;
// - the tag goes in the system's own group, "Lead source", and is found again by a key
//   (crm.tags.system_key), so a person may rename it or move it and no second one appears;
// - a tag a person made under the name before the system needed it is taken as that lead
//   source's tag the first time it is needed: it is given the key and nothing else of it
//   changes (its group, its description and who made it stay), so renaming it later does
//   not make a second one either;
// - the forms module calls it inside the transaction that stores a submission, and one
//   command reaches it for people, ensureLeadSourceTagsCommand: it takes keys of the closed
//   list and no name, so whoever wants the tags of some lead sources before any lead has
//   arrived (the workflow recipe that tags by source) gets these same tags and makes no
//   lookalike.
import { defineCommand, requireBusiness, type CommandContext } from '@repo/commands';
import {
  ensureLeadSourceTagsInput,
  LEAD_SOURCE_TAG_GROUP,
  leadSourceKeys,
  leadSourceLabels,
  leadSourceTagName,
  type LeadSourceKey,
  type LeadSourceTags,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { toPublicId } from '@repo/kernel';
import { sql } from 'kysely';

import { requireTagDesigner } from './access.js';
import { assignRecordTagCommand } from './assignments.js';
import { countTagsCreated } from './counts.js';
import { asTag } from './tags.js';

/** A lead source, as lead-source.ts gives it. */
export interface TaggedLeadSource {
  readonly key: LeadSourceKey;
  readonly label: string;
}

const GROUP_KEY = 'lead_source';
const GROUP_DESCRIPTION = 'How each lead arrived. Kept by the system: forms add these tags.';
const TAG_DESCRIPTION = 'Added by forms to the leads that arrived this way.';

/** A tag's name as crm.tags.name_key has it: one key for every way of writing the name. */
const nameKey = (name: string) =>
  sql<string>`lower(regexp_replace(btrim(${name}), '[\\s_-]+', ' ', 'g'))`;

/** The system's key for a built-in lead source's tag, or undefined for any other. */
function systemKeyOf(lead: TaggedLeadSource): string | undefined {
  const known = leadSourceKeys.find((key) => key === lead.key);
  if (known === undefined || known === 'source_param') return undefined;
  // The name must be the list's own: this is what stops a caller minting a tag of its choosing.
  return leadSourceLabels[known] === lead.label ? `lead_source:${known}` : undefined;
}

/** The tag a lead source has now, if it has one. Nothing is written. */
export async function findLeadSourceTag(
  trx: DatabaseTransaction,
  businessId: string,
  lead: TaggedLeadSource,
): Promise<
  { readonly id: string; readonly name: string; readonly system_key: string | null } | undefined
> {
  const name = leadSourceTagName(lead.label);
  if (name === undefined) return undefined;
  const systemKey = systemKeyOf(lead);
  const rows = await trx
    .selectFrom('crm.tags')
    .select(['id', 'name', 'system_key'])
    .where('business_id', '=', businessId)
    .where((eb) =>
      systemKey === undefined
        ? eb('name_key', '=', nameKey(name))
        : eb.or([eb('system_key', '=', systemKey), eb('name_key', '=', nameKey(name))]),
    )
    .execute();
  // The one the system keeps comes before one that only has the name.
  return rows.find((row) => row.system_key === systemKey) ?? rows[0];
}

/** The "Lead source" group, made the first time it is needed. */
async function leadSourceGroup(
  trx: DatabaseTransaction,
  businessId: string,
  command: CommandContext,
): Promise<string> {
  const find = () =>
    trx
      .selectFrom('crm.tag_groups')
      .select(['id', 'system_key'])
      .where('business_id', '=', businessId)
      .where((eb) =>
        eb.or([
          eb('system_key', '=', GROUP_KEY),
          eb(sql<string>`lower(btrim(name))`, '=', LEAD_SOURCE_TAG_GROUP.toLowerCase()),
        ]),
      )
      .orderBy('system_key', (order) => order.asc().nullsLast())
      .executeTakeFirst();
  const existing = await find();
  if (existing !== undefined) return existing.id;
  // Two submissions may need it at the same moment: the second waits for the first, makes
  // nothing, and reads what the first made.
  const made = await trx
    .insertInto('crm.tag_groups')
    .values({
      business_id: businessId,
      name: LEAD_SOURCE_TAG_GROUP,
      description: GROUP_DESCRIPTION,
      system_key: GROUP_KEY,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (made === undefined) return (await find().then((row) => row ?? raise())).id;
  await command.emit({
    type: 'tag_group.created',
    subject: { kind: 'tag_group', id: made.id },
    payload: { name: LEAD_SOURCE_TAG_GROUP, description: GROUP_DESCRIPTION },
  });
  return made.id;
}

function raise(): never {
  throw new Error('The lead source tag could not be made or found.');
}

/**
 * The tag of a lead source, made if it is a built-in one that has none yet. Undefined when
 * there is none and none may be made: a name an address chose, or one too long for a tag.
 */
async function ensureLeadSourceTag(
  trx: DatabaseTransaction,
  businessId: string,
  lead: TaggedLeadSource,
  command: CommandContext,
): Promise<string | undefined> {
  const existing = await findLeadSourceTag(trx, businessId, lead);
  const name = leadSourceTagName(lead.label);
  const systemKey = systemKeyOf(lead);
  if (existing !== undefined) {
    // A tag a person made under the name, for a built-in lead source that has no tag of
    // its own yet: from now on it is that tag, by the key, whatever it is renamed to. Two
    // leads at the same moment: the second waits for the row and finds the key set.
    if (systemKey !== undefined && existing.system_key === null)
      await trx
        .updateTable('crm.tags')
        .set({ system_key: systemKey })
        .where('business_id', '=', businessId)
        .where('id', '=', existing.id)
        .where('system_key', 'is', null)
        .execute();
    return existing.id;
  }
  if (name === undefined || systemKey === undefined) return undefined;
  const groupId = await leadSourceGroup(trx, businessId, command);
  const made = await trx
    .insertInto('crm.tags')
    .values({
      business_id: businessId,
      name,
      description: TAG_DESCRIPTION,
      group_id: groupId,
      system_key: systemKey,
      created_by_kind: 'system',
      created_by_id: null,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (made === undefined) return ((await findLeadSourceTag(trx, businessId, lead)) ?? raise()).id;
  await command.emit({
    type: 'tag.created',
    subject: { kind: 'tag', id: made.id },
    payload: { name, description: TAG_DESCRIPTION },
  });
  command.enqueue(countTagsCreated, { tagId: made.id });
  return made.id;
}

/**
 * Puts the tag of a lead source on a contact, through the CRM's own command, so it is on
 * the timeline and automations see it. Answers whether the contact carries it afterwards.
 * `contactId` is crm.contacts.id.
 */
export async function tagLeadSource(
  trx: DatabaseTransaction,
  command: CommandContext,
  contactId: string,
  lead: TaggedLeadSource,
): Promise<boolean> {
  const businessId = requireBusiness(command.context);
  const tagId = await ensureLeadSourceTag(trx, businessId, lead, command);
  if (tagId === undefined) return false;
  await assignRecordTagCommand.handle(
    trx,
    { id: toPublicId('contact', contactId), tagId: toPublicId('tag', tagId) },
    command,
  );
  return true;
}

/**
 * The tags of built-in lead sources, found or made, for a person who wants to name them
 * before a lead has: the workflow recipe that tags by source. It takes keys of the closed
 * list, so no name of the caller's reaches a tag; the tags are the ones a form adds, the
 * system's own, whoever asks first. Whoever may add a tag by hand may ask (tags.manage);
 * the business's rule for who may create a tag is not asked, the tags being the system's
 * and not that person's. An automation, an assistant, a form and a visitor may not.
 */
export const ensureLeadSourceTagsCommand = defineCommand({
  name: 'tag.ensure_lead_sources',
  permission: 'tags.manage',
  input: ensureLeadSourceTagsInput,
  async handle(trx, input, command): Promise<LeadSourceTags> {
    requireTagDesigner(command, 'tags.manage');
    const businessId = requireBusiness(command.context);
    const sources = [...new Set(input.sources)];
    const ids = new Map<string, string>();
    for (const key of sources) {
      const tagId = await ensureLeadSourceTag(
        trx,
        businessId,
        { key, label: leadSourceLabels[key] },
        command,
      );
      ids.set(key, tagId ?? raise());
    }
    const rows = await trx
      .selectFrom('crm.tags')
      .select(['id', 'name', 'description', 'created_at', 'updated_at'])
      .where('business_id', '=', businessId)
      .where('id', 'in', [...ids.values()])
      .execute();
    return {
      items: sources.map((key) => ({
        source: key,
        label: leadSourceLabels[key],
        tag: asTag(rows.find((row) => row.id === ids.get(key)) ?? raise()),
      })),
    };
  },
});

/** The names of tags, by their ids (crm.tags.id), for whoever shows what a form would add. */
export async function readTagNames(
  trx: DatabaseTransaction,
  businessId: string,
  tagIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (tagIds.length === 0) return new Map();
  const rows = await trx
    .selectFrom('crm.tags')
    .select(['id', 'name'])
    .where('business_id', '=', businessId)
    .where('id', 'in', [...tagIds])
    .execute();
  return new Map(rows.map((row) => [row.id, row.name]));
}
