// Settings → Phone System: the business's calling defaults and each registered
// number's own settings. Saving them changes nothing at the provider and places no call:
// the voice transport reads them. Every answer says whether calls can be made at all.
import { createHash } from 'node:crypto';

import { defineCommand, requireBusiness, type Command, type Invocation } from '@repo/commands';
import {
  phoneNumberSettings,
  type phoneCallingUnavailableCodes,
  listPhoneSystemMembers,
  phoneSystemSettings,
  phoneSystemMemberList,
  updatePhoneNumberSettingsInput,
  updatePhoneSystemSettingsInput,
  type PhoneCalling,
  type PhoneNumberSettings,
  type PhoneNumberWarningCode,
  type PhoneSystemSettings,
} from '@repo/contracts';
import type { DatabaseTransaction } from '@repo/db';
import {
  ConflictError,
  NotFoundError,
  parsePublicId,
  toPublicId,
  ValidationError,
  type TenantContext,
} from '@repo/kernel';
import * as z from 'zod';

/** A ring timeout under this is too short for most phones to be answered. */
const ADVISED_RING_SECONDS = 20;

const stale = () =>
  new ConflictError('These settings changed after you opened them. Reload the page and try again.');

const revisionOf = (values: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');

// People ------------------------------------------------------------------------------

/** Business members who can still sign in, as the calendar reads its team. */
function membersIn(trx: DatabaseTransaction, context: TenantContext) {
  return trx
    .selectFrom('tenancy.memberships as m')
    .innerJoin('auth.users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'm.user_id'])
    .where('m.agency_id', '=', context.agencyId)
    .where('m.business_id', '=', requireBusiness(context))
    .where('u.disabled_at', 'is', null);
}

/** Same eligibility source as usersOf, so the picker never offers a refused member. */
export async function readPhoneSystemMembers(
  trx: DatabaseTransaction,
  context: TenantContext,
  query: z.output<typeof listPhoneSystemMembers.query>,
): Promise<z.output<typeof phoneSystemMemberList>> {
  let read = membersIn(trx, context)
    .select(['u.name', 'u.email'])
    .orderBy('m.id')
    .limit(query.limit + 1);
  const after = query.after === undefined ? undefined : parsePublicId('membership', query.after);
  if (after !== undefined) read = read.where('m.id', '>', after);
  const rows = await read.execute();
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    data: page.map(({ id, name, email }) => ({ id: toPublicId('membership', id), name, email })),
    nextCursor:
      rows.length > query.limit && last !== undefined ? toPublicId('membership', last.id) : null,
  };
}

/** The users behind membership ids, each on this business's team, or a refusal naming where. */
async function usersOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  chosen: readonly { readonly path: string; readonly membershipId: string }[],
): Promise<string[]> {
  const ids = chosen.map(({ membershipId }) => parsePublicId('membership', membershipId));
  const known = ids.filter((id): id is string => id !== undefined);
  const rows =
    known.length === 0
      ? []
      : await membersIn(trx, context).where('m.id', 'in', known).forShare('m').execute();
  const userOf = new Map(rows.map((row) => [row.id, row.user_id]));
  const missing = chosen.filter((_, index) => userOf.get(ids[index] ?? '') === undefined);
  const [first, ...rest] = missing.map(({ path }) => ({
    path,
    code: 'unavailable_member',
    message: 'Choose someone on this business team.',
  }));
  if (first !== undefined) throw new ValidationError([first, ...rest]);
  return ids.map((id) => userOf.get(id ?? '') ?? '');
}

/** The membership each user has in this business now; people who left are absent. */
async function membershipsOf(
  trx: DatabaseTransaction,
  context: TenantContext,
  userIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await membersIn(trx, context).where('m.user_id', 'in', wanted).execute();
  return new Map(rows.map((row) => [row.user_id, toPublicId('membership', row.id)]));
}

/** Refuses forwarding a call to one of the business's own numbers, which would loop. */
async function refuseOwnNumber(
  trx: DatabaseTransaction,
  e164: string | null,
  path: string,
): Promise<void> {
  if (e164 === null) return;
  const own = await trx
    .selectFrom('messaging.phone_numbers')
    .select('id')
    .where('e164', '=', e164)
    .executeTakeFirst();
  if (own !== undefined)
    throw new ValidationError([
      {
        path,
        code: 'forwards_to_own_number',
        message:
          'Forward to a number outside this business. One of its own numbers would ring back here.',
      },
    ]);
}

// The business's calling defaults -------------------------------------------------------

interface SystemValues {
  readonly defaultNumberId: string | null;
  readonly preferAssignedUser: boolean;
  readonly allowAnonymousCallers: boolean;
  readonly fallbackNumber: string | null;
  readonly callerId: PhoneSystemSettings['outbound']['callerId'];
  readonly connectAgent: PhoneSystemSettings['outbound']['connectAgent'];
  readonly quietHoursWarning: boolean;
  readonly retentionDays: number | null;
  readonly transcriptionEnabled: boolean;
  readonly missedCallTextEnabled: boolean;
  readonly missedCallText: string | null;
}

/** What applies before the first save: the table's defaults (0108). */
const systemDefaults: SystemValues = {
  defaultNumberId: null,
  preferAssignedUser: true,
  allowAnonymousCallers: true,
  fallbackNumber: null,
  callerId: 'account_default',
  connectAgent: 'after_announcement',
  quietHoursWarning: true,
  retentionDays: null,
  transcriptionEnabled: false,
  missedCallTextEnabled: false,
  missedCallText: null,
};

const callerIds = z.enum(['account_default', 'user_assigned', 'local_presence']);
const connectAgents = z.enum(['before_announcement', 'after_announcement']);

async function storedSystem(
  trx: DatabaseTransaction,
  businessId: string,
  lock = false,
): Promise<SystemValues> {
  const query = trx
    .selectFrom('messaging.phone_system_settings')
    .selectAll()
    .where('business_id', '=', businessId);
  const row = await (lock ? query.forUpdate() : query).executeTakeFirst();
  return row === undefined
    ? systemDefaults
    : {
        defaultNumberId: row.default_phone_number_id,
        preferAssignedUser: row.inbound_prefer_assigned_user,
        allowAnonymousCallers: row.inbound_allow_anonymous,
        fallbackNumber: row.inbound_fallback_e164,
        callerId: callerIds.parse(row.outbound_caller_id),
        connectAgent: connectAgents.parse(row.outbound_connect_agent),
        quietHoursWarning: row.outbound_quiet_hours_warning,
        retentionDays: row.recording_retention_days,
        transcriptionEnabled: row.transcription_enabled,
        missedCallTextEnabled: row.missed_call_text_enabled,
        missedCallText: row.missed_call_text,
      };
}

const systemRevision = (values: SystemValues): string =>
  revisionOf([
    values.defaultNumberId,
    values.preferAssignedUser,
    values.allowAnonymousCallers,
    values.fallbackNumber,
    values.callerId,
    values.connectAgent,
    values.quietHoursWarning,
    values.retentionDays,
    values.transcriptionEnabled,
    values.missedCallTextEnabled,
    values.missedCallText,
  ]);

const callingMessages = {
  no_voice_number:
    'Register a number that can take calls, from a connected Twilio account, to make and take calls here.',
  calling_not_set_up: 'Set up calling on the Twilio account your number belongs to.',
  calling_setup_pending: 'Calling is being set up on your Twilio account. This takes a moment.',
  calling_setup_failed: 'Setting up calling failed. See why under Calling, then try again.',
  calling_setup_unknown:
    'Twilio did not answer while calling was being set up. Check it under Calling before trying again.',
} as const satisfies Record<(typeof phoneCallingUnavailableCodes)[number], string>;

/**
 * Whether calls can be made or taken, and if not, the first thing missing that the business
 * can do something about: a number that takes calls, then calling set up on the Twilio
 * account of such a number.
 */
export async function readPhoneCalling(trx: DatabaseTransaction): Promise<PhoneCalling> {
  const setups = await trx
    .selectFrom('messaging.phone_numbers as number')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'number.id')
        .onRef('channel.business_id', '=', 'number.business_id'),
    )
    .innerJoin('messaging.provider_connections as connection', (join) =>
      join
        .onRef('connection.id', '=', 'number.provider_connection_id')
        .onRef('connection.business_id', '=', 'number.business_id'),
    )
    .leftJoin('messaging.voice_setups as setup', (join) =>
      join
        .onRef('setup.connection_id', '=', 'connection.id')
        .onRef('setup.business_id', '=', 'connection.business_id'),
    )
    .select('setup.status')
    .where('channel.status', '=', 'active')
    .where('connection.status', '=', 'connected')
    .where((eb) => eb(eb.val('voice'), '=', eb.fn.any('number.capabilities')))
    .execute();
  const statuses = new Set(setups.map((row) => row.status));
  if (statuses.has('ready')) {
    return { available: true, unavailable: null };
  }
  const code =
    setups.length === 0
      ? 'no_voice_number'
      : statuses.has('requested') || statuses.has('creating')
        ? 'calling_setup_pending'
        : statuses.has('unknown')
          ? 'calling_setup_unknown'
          : statuses.has('failed')
            ? 'calling_setup_failed'
            : 'calling_not_set_up';
  return { available: false, unavailable: { code, message: callingMessages[code] } };
}

async function presentSystem(
  trx: DatabaseTransaction,
  values: SystemValues,
): Promise<PhoneSystemSettings> {
  return phoneSystemSettings.parse({
    defaultNumberId:
      values.defaultNumberId === null ? null : toPublicId('phone_number', values.defaultNumberId),
    inbound: {
      preferAssignedUser: values.preferAssignedUser,
      allowAnonymousCallers: values.allowAnonymousCallers,
      fallbackNumber: values.fallbackNumber,
    },
    outbound: {
      callerId: values.callerId,
      connectAgent: values.connectAgent,
      quietHoursWarning: values.quietHoursWarning,
    },
    recording: {
      retentionDays: values.retentionDays,
      transcriptionEnabled: values.transcriptionEnabled,
    },
    missedCallText: { enabled: values.missedCallTextEnabled, message: values.missedCallText },
    revision: systemRevision(values),
    calling: await readPhoneCalling(trx),
  });
}

export async function readPhoneSystemSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<PhoneSystemSettings> {
  return presentSystem(trx, await storedSystem(trx, requireBusiness(invocation.context)));
}

export const updatePhoneSystemSettingsCommand: Command<
  typeof updatePhoneSystemSettingsInput,
  PhoneSystemSettings
> = defineCommand({
  name: 'phone.update_settings',
  permission: 'phone.manage',
  input: updatePhoneSystemSettingsInput,
  async handle(trx, input, command): Promise<PhoneSystemSettings> {
    const businessId = requireBusiness(command.context);
    // The row is made, then locked, so two saves take turns and the revision check holds.
    await trx
      .insertInto('messaging.phone_system_settings')
      .values({ business_id: businessId })
      .onConflict((conflict) => conflict.column('business_id').doNothing())
      .execute();
    if (systemRevision(await storedSystem(trx, businessId, true)) !== input.revision) throw stale();

    let defaultNumberId: string | null = null;
    if (input.defaultNumberId !== null) {
      const id = parsePublicId('phone_number', input.defaultNumberId);
      const number =
        id === undefined
          ? undefined
          : await trx
              .selectFrom('messaging.phone_numbers')
              .select(['id', 'capabilities'])
              .where('id', '=', id)
              .forShare()
              .executeTakeFirst();
      if (number === undefined)
        throw new ValidationError([
          {
            path: '/defaultNumberId',
            code: 'unavailable_number',
            message: 'Choose one of this business’s registered numbers.',
          },
        ]);
      if (!number.capabilities.includes('voice'))
        throw new ValidationError([
          {
            path: '/defaultNumberId',
            code: 'number_cannot_call',
            message: 'This number can’t make calls. Choose one that can.',
          },
        ]);
      defaultNumberId = number.id;
    }
    await refuseOwnNumber(trx, input.inbound.fallbackNumber, '/inbound/fallbackNumber');

    await trx
      .updateTable('messaging.phone_system_settings')
      .set({
        default_phone_number_id: defaultNumberId,
        inbound_prefer_assigned_user: input.inbound.preferAssignedUser,
        inbound_allow_anonymous: input.inbound.allowAnonymousCallers,
        inbound_fallback_e164: input.inbound.fallbackNumber,
        outbound_caller_id: input.outbound.callerId,
        outbound_connect_agent: input.outbound.connectAgent,
        outbound_quiet_hours_warning: input.outbound.quietHoursWarning,
        recording_retention_days: input.recording.retentionDays,
        transcription_enabled: input.recording.transcriptionEnabled,
        missed_call_text_enabled: input.missedCallText.enabled,
        missed_call_text: input.missedCallText.message,
      })
      .where('business_id', '=', businessId)
      .execute();
    const saved = await storedSystem(trx, businessId);
    await command.emit({
      type: 'phone_system_settings.updated',
      subject: { kind: 'business', id: businessId },
      // Which settings, not their values: a fallback number can be someone's own phone.
      payload: {
        defaultNumberId: saved.defaultNumberId,
        outboundCallerId: saved.callerId,
        recordingRetentionDays: saved.retentionDays,
        transcriptionEnabled: saved.transcriptionEnabled,
        missedCallTextEnabled: saved.missedCallTextEnabled,
      },
    });
    return presentSystem(trx, saved);
  },
});

// Each number's settings ----------------------------------------------------------------

const statuses = z.enum(['active', 'paused', 'failing', 'disconnected']);
const capabilities = z.array(z.enum(['sms', 'mms', 'voice']));
const forwardedCallerIds = z.enum(['caller', 'business_number']);

function numbersQuery(trx: DatabaseTransaction, businessId: string) {
  return trx
    .selectFrom('messaging.phone_numbers as number')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'number.id')
        .onRef('channel.business_id', '=', 'number.business_id'),
    )
    .leftJoin('messaging.phone_number_settings as settings', (join) =>
      join
        .onRef('settings.phone_number_id', '=', 'number.id')
        .onRef('settings.business_id', '=', 'number.business_id'),
    )
    .select([
      'number.id',
      'number.e164',
      'number.capabilities',
      'channel.name',
      'channel.status',
      'settings.owner_user_id',
      'settings.recording_enabled',
      'settings.recording_announcement_enabled',
      'settings.recording_announcement',
      'settings.primary_user_id',
      'settings.forward_to_e164',
      'settings.use_business_fallback',
      'settings.ring_also_user_ids',
      'settings.ring_timeout_seconds',
      'settings.voicemail_backup',
      'settings.call_connect_confirmation',
      'settings.whisper_enabled',
      'settings.whisper_message',
      'settings.forwarded_caller_id',
      'settings.prefer_contact_owner',
    ])
    .where('number.business_id', '=', businessId);
}
type NumberRow = Awaited<ReturnType<ReturnType<typeof numbersQuery>['executeTakeFirstOrThrow']>>;

/** A number's stored settings, with the table's defaults where none were saved (0108). */
interface NumberValues {
  readonly name: string;
  readonly ownerUserId: string | null;
  readonly recordingEnabled: boolean;
  readonly announcementEnabled: boolean;
  readonly announcement: string | null;
  readonly primaryUserId: string | null;
  readonly forwardTo: string | null;
  readonly useBusinessFallback: boolean;
  readonly ringAlsoUserIds: readonly string[];
  readonly ringTimeoutSeconds: number;
  readonly voicemailBackup: boolean;
  readonly callConnectConfirmation: boolean;
  readonly whisperEnabled: boolean;
  readonly whisperMessage: string | null;
  readonly forwardedCallerId: 'caller' | 'business_number';
  readonly preferContactOwner: boolean;
}

const numberValues = (row: NumberRow): NumberValues => ({
  name: row.name,
  ownerUserId: row.owner_user_id,
  recordingEnabled: row.recording_enabled ?? false,
  announcementEnabled: row.recording_announcement_enabled ?? false,
  announcement: row.recording_announcement,
  primaryUserId: row.primary_user_id,
  forwardTo: row.forward_to_e164,
  useBusinessFallback: row.use_business_fallback ?? false,
  ringAlsoUserIds: row.ring_also_user_ids ?? [],
  ringTimeoutSeconds: row.ring_timeout_seconds ?? ADVISED_RING_SECONDS,
  voicemailBackup: row.voicemail_backup ?? true,
  callConnectConfirmation: row.call_connect_confirmation ?? false,
  whisperEnabled: row.whisper_enabled ?? false,
  whisperMessage: row.whisper_message,
  forwardedCallerId: forwardedCallerIds.parse(row.forwarded_caller_id ?? 'caller'),
  preferContactOwner: row.prefer_contact_owner ?? false,
});

const numberRevision = (values: NumberValues): string =>
  revisionOf([
    values.name,
    values.ownerUserId,
    values.recordingEnabled,
    values.announcementEnabled,
    values.announcement,
    values.primaryUserId,
    values.forwardTo,
    values.useBusinessFallback,
    values.ringAlsoUserIds,
    values.ringTimeoutSeconds,
    values.voicemailBackup,
    values.callConnectConfirmation,
    values.whisperEnabled,
    values.whisperMessage,
    values.forwardedCallerId,
    values.preferContactOwner,
  ]);

function presentNumber(
  row: NumberRow,
  system: SystemValues,
  memberships: ReadonlyMap<string, string>,
): PhoneNumberSettings {
  const values = numberValues(row);
  const warnings = new Set<PhoneNumberWarningCode>();
  const membershipOf = (userId: string | null): string | null => {
    if (userId === null) return null;
    const membership = memberships.get(userId);
    if (membership === undefined) warnings.add('member_left');
    return membership ?? null;
  };
  const ownerId = membershipOf(values.ownerUserId);
  const canCall = row.capabilities.includes('voice');
  let voice: PhoneNumberSettings['voice'] = null;
  if (canCall) {
    const primaryMemberId = membershipOf(values.primaryUserId);
    const ringAlso = values.ringAlsoUserIds
      .map(membershipOf)
      .filter((id): id is string => id !== null);
    const fallbackRings = values.useBusinessFallback && system.fallbackNumber !== null;
    if (values.useBusinessFallback && system.fallbackNumber === null)
      warnings.add('fallback_not_set');
    if (
      primaryMemberId === null &&
      ringAlso.length === 0 &&
      values.forwardTo === null &&
      !fallbackRings &&
      !values.voicemailBackup
    )
      warnings.add('no_destination');
    if (values.ringTimeoutSeconds < ADVISED_RING_SECONDS) warnings.add('short_ring_timeout');
    voice = {
      recording: {
        enabled: values.recordingEnabled,
        announcement: { enabled: values.announcementEnabled, message: values.announcement },
      },
      routing: {
        primaryMemberId,
        forwardTo: values.forwardTo,
        useBusinessFallback: values.useBusinessFallback,
        ringAlso,
        ringTimeoutSeconds: values.ringTimeoutSeconds,
        voicemailBackup: values.voicemailBackup,
      },
      advanced: {
        callConnectConfirmation: values.callConnectConfirmation,
        whisper: { enabled: values.whisperEnabled, message: values.whisperMessage },
        forwardedCallerId: values.forwardedCallerId,
        preferContactOwner: values.preferContactOwner,
      },
    };
  }
  return phoneNumberSettings.parse({
    id: toPublicId('phone_number', row.id),
    e164: row.e164,
    capabilities: capabilities.parse(row.capabilities),
    status: statuses.parse(row.status),
    isDefault: system.defaultNumberId === row.id,
    name: values.name,
    ownerId,
    voice,
    revision: numberRevision(values),
    warnings: [...warnings].sort(),
  });
}

async function presentNumbers(
  trx: DatabaseTransaction,
  context: TenantContext,
  rows: readonly NumberRow[],
): Promise<PhoneNumberSettings[]> {
  const system = await storedSystem(trx, requireBusiness(context));
  const memberships = await membershipsOf(
    trx,
    context,
    rows.flatMap((row) => [
      row.owner_user_id,
      row.primary_user_id,
      ...(row.ring_also_user_ids ?? []),
    ]),
  );
  return rows.map((row) => presentNumber(row, system, memberships));
}

/** Every registered number with its settings, in the order the numbers were registered. */
export async function readPhoneSystemNumbers(
  trx: DatabaseTransaction,
  invocation: Invocation,
): Promise<PhoneNumberSettings[]> {
  const rows = await numbersQuery(trx, requireBusiness(invocation.context))
    .orderBy('number.created_at')
    .orderBy('number.id')
    .execute();
  return presentNumbers(trx, invocation.context, rows);
}

async function numberRow(
  trx: DatabaseTransaction,
  businessId: string,
  publicId: string,
  lock = false,
): Promise<NumberRow> {
  const id = parsePublicId('phone_number', publicId);
  const query = numbersQuery(trx, businessId).where('number.id', '=', id ?? '');
  const row =
    id === undefined
      ? undefined
      : await (lock ? query.forUpdate('number') : query).executeTakeFirst();
  if (row === undefined) throw new NotFoundError('phone number', publicId);
  return row;
}

export async function readPhoneNumberSettings(
  trx: DatabaseTransaction,
  invocation: Invocation,
  publicId: string,
): Promise<PhoneNumberSettings> {
  const row = await numberRow(trx, requireBusiness(invocation.context), publicId);
  const [settings] = await presentNumbers(trx, invocation.context, [row]);
  if (settings === undefined) throw new NotFoundError('phone number', publicId);
  return settings;
}

const updateNumberInput = updatePhoneNumberSettingsInput.extend({
  id: z.string(),
});

export const updatePhoneNumberSettingsCommand: Command<
  typeof updateNumberInput,
  PhoneNumberSettings
> = defineCommand({
  name: 'phone_number.update_settings',
  permission: 'phone.manage',
  input: updateNumberInput,
  async handle(trx, input, command): Promise<PhoneNumberSettings> {
    const businessId = requireBusiness(command.context);
    const row = await numberRow(trx, businessId, input.id, true);
    if (numberRevision(numberValues(row)) !== input.revision) throw stale();

    const canCall = row.capabilities.includes('voice');
    if (canCall !== (input.voice !== null))
      throw new ValidationError([
        canCall
          ? {
              path: '/voice',
              code: 'voice_required',
              message: 'Say how this number’s calls are handled.',
            }
          : {
              path: '/voice',
              code: 'voice_not_supported',
              message: 'This number can’t take calls.',
            },
      ]);

    const [ownerUserId] =
      input.ownerId === null
        ? [null]
        : await usersOf(trx, command.context, [{ path: '/ownerId', membershipId: input.ownerId }]);
    const voice = input.voice;
    let voiceColumns = {};
    if (voice !== null) {
      const { routing } = voice;
      const chosen = [
        ...(routing.primaryMemberId === null
          ? []
          : [{ path: '/voice/routing/primaryMemberId', membershipId: routing.primaryMemberId }]),
        ...routing.ringAlso.map((membershipId, index) => ({
          path: `/voice/routing/ringAlso/${String(index)}`,
          membershipId,
        })),
      ];
      const users = await usersOf(trx, command.context, chosen);
      const primaryUserId = routing.primaryMemberId === null ? null : (users.shift() ?? null);
      await refuseOwnNumber(trx, routing.forwardTo, '/voice/routing/forwardTo');
      voiceColumns = {
        recording_enabled: voice.recording.enabled,
        recording_announcement_enabled: voice.recording.announcement.enabled,
        recording_announcement: voice.recording.announcement.message,
        primary_user_id: primaryUserId,
        forward_to_e164: routing.forwardTo,
        use_business_fallback: routing.useBusinessFallback,
        ring_also_user_ids: users,
        ring_timeout_seconds: routing.ringTimeoutSeconds,
        voicemail_backup: routing.voicemailBackup,
        call_connect_confirmation: voice.advanced.callConnectConfirmation,
        whisper_enabled: voice.advanced.whisper.enabled,
        whisper_message: voice.advanced.whisper.message,
        forwarded_caller_id: voice.advanced.forwardedCallerId,
        prefer_contact_owner: voice.advanced.preferContactOwner,
      };
    }

    await trx
      .updateTable('messaging.channel_accounts')
      .set({ name: input.name })
      .where('id', '=', row.id)
      .where('business_id', '=', businessId)
      .execute();
    const saved = { owner_user_id: ownerUserId ?? null, ...voiceColumns };
    await trx
      .insertInto('messaging.phone_number_settings')
      .values({ business_id: businessId, phone_number_id: row.id, ...saved })
      .onConflict((conflict) =>
        conflict.columns(['business_id', 'phone_number_id']).doUpdateSet(saved),
      )
      .execute();
    await command.emit({
      type: 'phone_number.settings_updated',
      subject: { kind: 'phone_number', id: row.id },
      // Which parts changed hands, not the numbers calls are forwarded to.
      payload: {
        nameChanged: input.name !== row.name,
        ownerUserId: ownerUserId ?? null,
        recordingEnabled: voice?.recording.enabled ?? null,
      },
    });
    return readPhoneNumberSettings(trx, command, input.id);
  },
});
