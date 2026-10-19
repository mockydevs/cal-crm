import { randomUUID } from 'node:crypto';
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type CommandContext,
  type Services,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, NotFoundError, type TenantContext } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { openSmsCredentials } from '../sms-connect.js';
import type { TwilioCredentials } from '../twilio-api.js';
import { VOICE_SIGNING_KEY } from '../voice-setup.js';
import { deleteRecording } from './recording-media.js';

export interface RecordingRetentionFiles {
  discard(trx: DatabaseTransaction, command: CommandContext, fileId: string): Promise<void>;
}

export interface ExpireCallRecordingsOptions {
  readonly vault?: Vault | undefined;
  readonly files?: RecordingRetentionFiles | undefined;
  readonly fetcher?: typeof fetch | undefined;
}

export const expireCallRecordingsReference = {
  name: 'messaging.expire_call_recordings',
  data: z.strictObject({}).default({}),
} satisfies TaskReference<z.ZodType>;

const signingKey = z.strictObject({
  sid: z.string(),
  secret: z.string(),
  type: z.literal('standard'),
});

const expireCallRecordingInput = z.strictObject({
  recordingId: z.uuid(),
});

interface RecordingTarget {
  readonly id: string;
  readonly provider_recording_sid: string;
  readonly file_id: string | null;
  readonly connection_status: string | null;
  readonly connection_secret_id: string | null;
  readonly account_ref: string | null;
  readonly voice_setup_status: string | null;
  readonly voice_key_id: string | null;
}

function createExpireRecordingCommand(
  files?: RecordingRetentionFiles,
): Command<typeof expireCallRecordingInput, void> {
  return defineCommand({
    name: 'call.expire_recording',
    permission: 'phone.manage',
    input: expireCallRecordingInput,
    async handle(trx, input, command) {
      if (command.context.actorKind !== 'system') {
        throw new ForbiddenError('Only the system expires call recordings.');
      }
      const businessId = requireBusiness(command.context);
      const row = await trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'deleted_at'])
        .where('id', '=', input.recordingId)
        .where('business_id', '=', businessId)
        .forUpdate()
        .executeTakeFirst();

      if (row === undefined) {
        return;
      }
      if (row.deleted_at !== null) {
        return;
      }

      if (row.file_id !== null && files !== undefined) {
        await sql`savepoint expire_recording_file`.execute(trx);
        try {
          await files.discard(trx, command, row.file_id);
          await sql`release savepoint expire_recording_file`.execute(trx);
        } catch (error) {
          await sql`rollback to savepoint expire_recording_file`.execute(trx);
          await sql`release savepoint expire_recording_file`.execute(trx);
          if (!(error instanceof NotFoundError)) {
            throw error;
          }
        }
      }

      await trx
        .updateTable('messaging.call_recordings')
        .set({
          file_id: null,
          deleted_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where('id', '=', input.recordingId)
        .where('business_id', '=', businessId)
        .execute();
    },
  });
}

/**
 * Removes old call recordings from the provider and business storage according to retention settings.
 * At most 200 recordings are processed per business per sweep, taking the oldest first.
 */
export async function expireCallRecordings(
  services: Services,
  options: ExpireCallRecordingsOptions = {},
): Promise<number> {
  const { rows: businesses } = await sql<{ agency_id: string; business_id: string }>`
    select agency_id, business_id
    from private.businesses_with_expired_call_recordings(${100})
  `.execute(services.db);

  let totalExpired = 0;
  const expireCommand = createExpireRecordingCommand(options.files);

  for (const business of businesses) {
    const tenantContext: TenantContext = {
      agencyId: business.agency_id,
      businessId: business.business_id,
      actorKind: 'system',
      correlationId: randomUUID(),
    };

    const targetRecordings: readonly RecordingTarget[] = await withTenant(
      services.db,
      tenantContext,
      async (trx) => {
        const settings = await trx
          .selectFrom('messaging.phone_system_settings')
          .select('recording_retention_days')
          .where('business_id', '=', business.business_id)
          .executeTakeFirst();

        const days = settings?.recording_retention_days;
        if (typeof days !== 'number') {
          return [];
        }
        const rows = await trx
          .selectFrom('messaging.call_recordings as r')
          .leftJoin('messaging.provider_connections as c', (join) =>
            join
              .onRef('c.id', '=', 'r.provider_connection_id')
              .onRef('c.business_id', '=', 'r.business_id'),
          )
          .leftJoin('messaging.voice_setups as s', (join) =>
            join.onRef('s.connection_id', '=', 'c.id').onRef('s.business_id', '=', 'c.business_id'),
          )
          .select([
            'r.id',
            'r.provider_recording_sid',
            'r.file_id',
            'c.status as connection_status',
            'c.secret_id as connection_secret_id',
            'c.account_ref',
            's.status as voice_setup_status',
            's.secret_id as voice_key_id',
          ])
          .where('r.business_id', '=', business.business_id)
          .where('r.deleted_at', 'is', null)
          .where('r.created_at', '<', sql<Date>`now() - pg_catalog.make_interval(days => ${days})`)
          .orderBy('r.created_at', 'asc')
          .limit(200)
          .execute();

        return rows;
      },
    );

    for (const recording of targetRecordings) {
      let credentials: TwilioCredentials | null = null;

      if (
        recording.connection_status === 'connected' &&
        recording.connection_secret_id !== null &&
        recording.account_ref !== null &&
        options.vault !== undefined
      ) {
        const vault = options.vault;
        const secretId = recording.connection_secret_id;
        const accountRef = recording.account_ref;
        const account = await withTenant(services.db, tenantContext, async (trx) => {
          return openSmsCredentials(trx, vault, secretId);
        });

        if (account !== null && account.accountSid === accountRef) {
          let openedKey: unknown;
          if (recording.voice_key_id !== null && recording.voice_setup_status === 'ready') {
            const keyId = recording.voice_key_id;
            try {
              openedKey = JSON.parse(
                await withTenant(services.db, tenantContext, async (trx) => {
                  return vault.read(trx, keyId, VOICE_SIGNING_KEY);
                }),
              );
            } catch (failure) {
              if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError)) {
                throw failure;
              }
            }
          }
          const key = signingKey.safeParse(openedKey);
          credentials = {
            accountSid: account.accountSid,
            authToken: account.authToken,
            apiKey: key.success ? { sid: key.data.sid, secret: key.data.secret } : undefined,
          };
        }
      }

      if (credentials !== null) {
        const result = await deleteRecording(
          options.fetcher ?? fetch,
          credentials,
          recording.provider_recording_sid,
        );
        if (result.outcome === 'unknown' || result.outcome === 'rejected') {
          continue;
        }
      }

      await runCommand(
        services,
        expireCommand,
        { recordingId: recording.id },
        {
          context: tenantContext,
          permissions: 'all',
        },
      );
      totalExpired++;
    }
  }

  return totalExpired;
}

export function createExpireCallRecordingsTask(
  options: ExpireCallRecordingsOptions = {},
): Task<typeof expireCallRecordingsReference.data> {
  return defineTask({
    ...expireCallRecordingsReference,
    async run(_data, { services }) {
      await expireCallRecordings(services, options);
    },
  });
}
