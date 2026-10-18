// Settings → Business Profile → "Contact Deduplication Preferences" (GoHighLevel's name): the
// field an existing contact is found by first when details arrive, and the one tried after it.
// https://help.gohighlevel.com/support/solutions/articles/48001181714
//
// GoHighLevel also has an "Allow Duplicate Contact" switch. Here an email address or a phone
// number always belongs to one contact, since messages are matched and sent on them, so there
// is no such switch: only the order.
import { createHash } from 'node:crypto';

import { defineCommand, requireBusiness, type Invocation } from '@repo/commands';
import {
  updateDuplicateSettingsInput,
  type DuplicateMatchField,
  type DuplicateSettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import { ConflictError } from '@repo/kernel';

/** The order a business finds an existing contact in. */
export interface MatchSettings {
  readonly primary: DuplicateMatchField;
  readonly secondary: DuplicateMatchField | null;
}

/** As a business has them before anyone saves any: email first, as before they existed. */
export const DEFAULT_MATCH_SETTINGS: MatchSettings = { primary: 'email', secondary: null };

const otherThan = (field: DuplicateMatchField): DuplicateMatchField =>
  field === 'email' ? 'phone' : 'email';

/**
 * The fields to look an existing contact up by, in order, for details that give these. The
 * primary field when it was given, then the secondary one if it is set and given, tried only
 * when the primary finds nobody. When the primary field was not given at all, the other one
 * is used, secondary or not: details with only a phone number still find the contact that
 * holds it.
 */
export function matchFields(
  settings: MatchSettings,
  given: Readonly<Record<DuplicateMatchField, boolean>>,
): readonly DuplicateMatchField[] {
  const other = otherThan(settings.primary);
  if (!given[settings.primary]) return given[other] ? [other] : [];
  return settings.secondary !== null && given[settings.secondary]
    ? [settings.primary, settings.secondary]
    : [settings.primary];
}

/**
 * The order an import reads a row's addresses in: the primary field, then the other.
 * GoHighLevel's importer merges a row into a contact on its email address or its phone
 * number whatever the preferences say (article 48001181714), so an import always looks at
 * both; the preferences decide which comes first.
 */
export function importMatchOrder(settings: MatchSettings): readonly DuplicateMatchField[] {
  return [settings.primary, otherThan(settings.primary)];
}

const asField = (value: string | null): DuplicateMatchField | null =>
  value === 'email' || value === 'phone' ? value : null;

/** The business's order, as it is when the caller reads it. */
export async function readMatchSettings(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<MatchSettings> {
  const row = await trx
    .selectFrom('crm.settings')
    .select(['duplicate_primary', 'duplicate_secondary'])
    .where('business_id', '=', businessId)
    .executeTakeFirst();
  if (row === undefined) return DEFAULT_MATCH_SETTINGS;
  return {
    primary: asField(row.duplicate_primary) ?? DEFAULT_MATCH_SETTINGS.primary,
    secondary: asField(row.duplicate_secondary),
  };
}

function shown(settings: MatchSettings, invocation: Invocation): DuplicateSettings {
  const values = { primary: settings.primary, secondary: settings.secondary };
  return {
    ...values,
    revision: createHash('sha256')
      .update(JSON.stringify(['duplicate-settings', values]))
      .digest('hex'),
    canManage: invocation.permissions === 'all' || invocation.permissions.has('business.profile'),
  };
}

export async function readDuplicateSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<DuplicateSettings> {
  return shown(await readMatchSettings(trx, requireBusiness(invocation.context)), invocation);
}

export const updateDuplicateSettingsCommand = defineCommand({
  name: 'duplicate_settings.update',
  // The Business Profile's own permission: the preferences are a section of that page.
  permission: 'business.profile',
  input: updateDuplicateSettingsInput,
  async handle(trx, input, command): Promise<DuplicateSettings> {
    const businessId = requireBusiness(command.context);
    await trx
      .insertInto('crm.settings')
      .values({ business_id: businessId })
      .onConflict((conflict) => conflict.column('business_id').doNothing())
      .execute();
    await trx
      .selectFrom('crm.settings')
      .select('business_id')
      .where('business_id', '=', businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const current = await readMatchSettings(trx, businessId);
    if (shown(current, command).revision !== input.revision)
      throw new ConflictError(
        'These preferences changed. Reload the saved version before editing again.',
      );
    const next: MatchSettings = { primary: input.primary, secondary: input.secondary };
    if (current.primary !== next.primary || current.secondary !== next.secondary) {
      await trx
        .updateTable('crm.settings')
        .set({ duplicate_primary: next.primary, duplicate_secondary: next.secondary })
        .where('business_id', '=', businessId)
        .execute();
      await command.emit({
        type: 'duplicate_settings.updated',
        subject: { kind: 'business', id: businessId },
        payload: { primary: next.primary, secondary: next.secondary },
      });
    }
    return shown(next, command);
  },
});
