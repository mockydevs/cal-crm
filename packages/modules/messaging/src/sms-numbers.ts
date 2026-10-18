// Phone numbers. A business registers numbers its Twilio account already owns, picked from
// the list the worker read from Twilio. Nothing here buys, releases or reconfigures a
// number: registering only records, in this database, that the business uses it.
import { defineCommand, requireBusiness, type Command } from '@repo/commands';
import {
  phoneNumber,
  registerPhoneNumberInput,
  smsProviderNumber,
  type PhoneNumber,
  type SmsProviderNumber,
} from '@repo/contracts';
import { explainUniqueViolation, type DatabaseTransaction } from '@repo/db';
import { ConflictError, NotFoundError, parsePublicId, toPublicId } from '@repo/kernel';
import * as z from 'zod';

import { syncSmsNumbersReference } from './sms-connect.js';
import { pointVoiceNumbersReference } from './voice/number-voice.js';

/**
 * The connection, only if it is this business's own. messaging.phone_numbers points at a
 * connection by id alone, so every path to one goes through this check.
 */
async function ownConnection(
  trx: DatabaseTransaction,
  businessId: string,
  publicId: string,
): Promise<{ id: string; status: string }> {
  const id = parsePublicId('sms_connection', publicId);
  const row =
    id === undefined
      ? undefined
      : await trx
          .selectFrom('messaging.provider_connections')
          .select(['id', 'status'])
          .where('id', '=', id)
          .where('business_id', '=', businessId)
          .where('provider', '=', 'twilio')
          .executeTakeFirst();
  if (row === undefined) throw new NotFoundError('SMS connection', publicId);
  return row;
}

/** The numbers the account owns, as last read, and which of them are registered here. */
export async function readSmsProviderNumbers(
  trx: DatabaseTransaction,
  businessId: string,
  connectionPublicId: string,
): Promise<SmsProviderNumber[]> {
  const connection = await ownConnection(trx, businessId, connectionPublicId);
  const rows = await trx
    .selectFrom('messaging.provider_numbers as listed')
    .leftJoin('messaging.phone_numbers as registered', (join) =>
      join
        .onRef('registered.provider_connection_id', '=', 'listed.connection_id')
        .onRef('registered.provider_number_ref', '=', 'listed.provider_number_ref'),
    )
    .select([
      'listed.provider_number_ref',
      'listed.e164',
      'listed.friendly_name',
      'listed.capabilities',
      'listed.seen_at',
      'registered.id as registered_id',
    ])
    .where('listed.connection_id', '=', connection.id)
    .orderBy('listed.e164')
    .execute();
  return rows.map((row) =>
    smsProviderNumber.parse({
      providerNumberRef: row.provider_number_ref,
      e164: row.e164,
      friendlyName: row.friendly_name,
      capabilities: row.capabilities,
      registeredAs:
        row.registered_id === null ? null : toPublicId('phone_number', row.registered_id),
      seenAt: row.seen_at.toISOString(),
    }),
  );
}

const present = (row: {
  id: string;
  name: string;
  status: string;
  e164: string;
  provider_connection_id: string;
  capabilities: string[];
  created_at: Date;
}): PhoneNumber =>
  phoneNumber.parse({
    id: toPublicId('phone_number', row.id),
    name: row.name,
    e164: row.e164,
    connectionId: toPublicId('sms_connection', row.provider_connection_id),
    capabilities: row.capabilities,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  });

export async function readPhoneNumbers(trx: DatabaseTransaction): Promise<PhoneNumber[]> {
  const rows = await trx
    .selectFrom('messaging.phone_numbers as number')
    .innerJoin('messaging.channel_accounts as channel', (join) =>
      join
        .onRef('channel.id', '=', 'number.id')
        .onRef('channel.business_id', '=', 'number.business_id'),
    )
    .select([
      'number.id',
      'channel.name',
      'channel.status',
      'number.e164',
      'number.provider_connection_id',
      'number.capabilities',
      'number.created_at',
    ])
    .orderBy('number.created_at')
    .orderBy('number.id')
    .execute();
  return rows.map(present);
}

/**
 * The numbers a text message can be sent from now: registered, their channel working,
 * their Twilio connection connected, and able to send SMS. In name order, as raw ids.
 */
export async function readSmsSenders(
  trx: DatabaseTransaction,
): Promise<{ readonly id: string; readonly name: string }[]> {
  return trx
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
    .select(['number.id', 'channel.name'])
    .where('channel.status', '=', 'active')
    .where('connection.status', '=', 'connected')
    .where('connection.provider', '=', 'twilio')
    .where((eb) => eb(eb.val('sms'), '=', eb.fn.any('number.capabilities')))
    .orderBy('channel.name')
    .orderBy('number.id')
    .execute();
}

/** Whether the business can send SMS at all: for the automation catalog and the composer. */
export async function hasActiveSmsNumber(trx: DatabaseTransaction): Promise<boolean> {
  return (await readSmsSenders(trx)).length > 0;
}

/**
 * Registers one of the connection's listed numbers. The number and its capabilities come
 * from what the worker read from Twilio, never from the request.
 */
export const registerPhoneNumberCommand: Command<typeof registerPhoneNumberInput, PhoneNumber> =
  defineCommand({
    name: 'sms.register_number',
    permission: 'sms.manage',
    input: registerPhoneNumberInput,
    async handle(trx, input, command): Promise<PhoneNumber> {
      const businessId = requireBusiness(command.context);
      const connection = await ownConnection(trx, businessId, input.connectionId);
      if (connection.status !== 'connected')
        throw new ConflictError('This Twilio account is not connected at the moment.');
      const listed = await trx
        .selectFrom('messaging.provider_numbers')
        .select(['e164', 'capabilities'])
        .where('connection_id', '=', connection.id)
        .where('provider_number_ref', '=', input.providerNumberRef)
        .executeTakeFirst();
      if (listed === undefined) throw new NotFoundError('phone number', input.providerNumberRef);
      if (!listed.capabilities.includes('sms'))
        throw new ConflictError('This number can’t send or receive SMS.');
      const taken = () => new ConflictError('This number is already registered.');
      const channel = await trx
        .insertInto('messaging.channel_accounts')
        .values({ business_id: businessId, channel: 'sms', name: input.name })
        .returning(['id', 'name', 'status'])
        .executeTakeFirstOrThrow();
      const number = await trx
        .insertInto('messaging.phone_numbers')
        .values({
          business_id: businessId,
          id: channel.id,
          e164: listed.e164,
          provider_connection_id: connection.id,
          provider_number_ref: input.providerNumberRef,
          capabilities: listed.capabilities,
        })
        .returning(['id', 'e164', 'provider_connection_id', 'capabilities', 'created_at'])
        .executeTakeFirstOrThrow()
        .catch(
          explainUniqueViolation({
            // A number receives inbound messages for exactly one business in the install.
            phone_numbers_e164_unique: taken,
            phone_numbers_provider_ref_unique: taken,
          }),
        );
      await command.emit({
        type: 'phone_number.registered',
        subject: { kind: 'phone_number', id: number.id },
        payload: { connectionId: connection.id },
      });
      if (listed.capabilities.includes('voice')) {
        const setup = await trx
          .selectFrom('messaging.voice_setups')
          .select('status')
          .where('connection_id', '=', connection.id)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        if (setup?.status === 'ready') {
          command.enqueue(pointVoiceNumbersReference, { connectionId: connection.id });
        }
      }
      return present({ ...number, name: channel.name, status: channel.status });
    },
  });

const refreshInput = z.strictObject({ id: z.string() });

/** Queues another read of the account's numbers; the worker does the reading. */
export const refreshSmsNumbersCommand: Command<typeof refreshInput, undefined> = defineCommand({
  name: 'sms.refresh_numbers',
  permission: 'sms.manage',
  input: refreshInput,
  async handle(trx, input, command): Promise<undefined> {
    const businessId = requireBusiness(command.context);
    const connection = await ownConnection(trx, businessId, input.id);
    command.enqueue(syncSmsNumbersReference, { connectionId: connection.id });
    return undefined;
  },
});
