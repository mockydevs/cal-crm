// Downloads call recording audio from the provider and links it to the call recording row.
// Audio is stored in the business's private files with purpose 'call_recording'.
import {
  defineCommand,
  defineTask,
  requireBusiness,
  runCommand,
  type Command,
  type CommandContext,
  type Invocation,
  type Task,
  type TaskReference,
} from '@repo/commands';
import { withTenant, type DatabaseTransaction } from '@repo/db';
import { ForbiddenError, parsePublicId } from '@repo/kernel';
import { SecretUnreadableError, type Vault } from '@repo/module-vault';
import { sql } from 'kysely';
import * as z from 'zod';

import { openSmsCredentials } from '../sms-connect.js';
import type { TwilioCredentials } from '../twilio-api.js';
import { VOICE_SIGNING_KEY } from '../voice-setup.js';
import { fetchRecordingMp3 } from './recording-media.js';

export interface RecordingFiles {
  store(
    trx: DatabaseTransaction,
    command: CommandContext,
    file: {
      readonly filename: string;
      readonly contentType: 'audio/mpeg';
      readonly content: Uint8Array;
      readonly purpose: 'call_recording';
      readonly quota: true;
    },
  ): Promise<{ readonly id: string }>;
}

export const fetchCallRecordingReference = {
  name: 'messaging.fetch_call_recording',
  data: z.strictObject({ recordingId: z.uuid() }),
} satisfies TaskReference<z.ZodType>;

const signingKey = z.strictObject({
  sid: z.string(),
  secret: z.string(),
  type: z.literal('standard'),
});

const attachRecordingFileInput = z.strictObject({
  recordingId: z.uuid(),
  content: z.instanceof(Uint8Array),
});

function attachRecordingFileCommand(
  files: RecordingFiles,
): Command<typeof attachRecordingFileInput, void> {
  return defineCommand({
    name: 'call.attach_recording_file',
    permission: 'phone.manage',
    input: attachRecordingFileInput,
    async handle(trx, input, command) {
      if (command.context.actorKind !== 'system') {
        throw new ForbiddenError('Only the system attaches recording files.');
      }
      const businessId = requireBusiness(command.context);
      const row = await trx
        .selectFrom('messaging.call_recordings')
        .select(['id', 'file_id', 'fetch_failure'])
        .where('id', '=', input.recordingId)
        .where('business_id', '=', businessId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return;
      if (row.file_id !== null) return;
      const stored = await files.store(trx, command, {
        filename: `call-recording-${input.recordingId}.mp3`,
        contentType: 'audio/mpeg',
        content: input.content,
        purpose: 'call_recording',
        quota: true,
      });
      const fileId = parsePublicId('file', stored.id) ?? stored.id;
      await trx
        .updateTable('messaging.call_recordings')
        .set({
          file_id: fileId,
          updated_at: sql`now()`,
        })
        .where('id', '=', input.recordingId)
        .where('business_id', '=', businessId)
        .execute();
    },
  });
}

export interface FetchCallRecordingTaskOptions {
  readonly fetcher?: typeof fetch | undefined;
  readonly maxBytes?: number | undefined;
}

export function createFetchCallRecordingTask(
  vault: Vault,
  files: RecordingFiles,
  options: FetchCallRecordingTaskOptions = {},
): Task<typeof fetchCallRecordingReference.data> {
  return defineTask({
    ...fetchCallRecordingReference,
    async run({ recordingId }, { invocation, services }) {
      const opened = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('messaging.call_recordings as r')
          .innerJoin('messaging.provider_connections as c', (join) =>
            join
              .onRef('c.id', '=', 'r.provider_connection_id')
              .onRef('c.business_id', '=', 'r.business_id'),
          )
          .innerJoin('messaging.voice_setups as s', (join) =>
            join.onRef('s.connection_id', '=', 'c.id').onRef('s.business_id', '=', 'c.business_id'),
          )
          .select([
            'r.id',
            'r.business_id',
            'r.provider_recording_sid',
            'r.status',
            'r.file_id',
            'r.fetch_failure',
            'c.agency_id',
            'c.secret_id',
            'c.account_ref',
            's.secret_id as key_id',
          ])
          .where('r.id', '=', recordingId)
          .where('r.status', '=', 'completed')
          .where('r.file_id', 'is', null)
          .where('r.fetch_failure', 'is', null)
          .where('c.status', '=', 'connected')
          .where('s.status', '=', 'ready')
          .executeTakeFirst();
        if (row === undefined) return null;
        if (row.key_id === null) return null;

        const account = await openSmsCredentials(trx, vault, row.secret_id);
        if (account?.accountSid !== row.account_ref) return null;

        let openedKey: unknown;
        try {
          openedKey = JSON.parse(await vault.read(trx, row.key_id, VOICE_SIGNING_KEY));
        } catch (failure) {
          if (!(failure instanceof SecretUnreadableError || failure instanceof SyntaxError)) {
            throw failure;
          }
          return null;
        }
        const key = signingKey.safeParse(openedKey);
        if (!key.success) return null;

        const credentials: TwilioCredentials = {
          accountSid: account.accountSid,
          authToken: account.authToken,
          apiKey: { sid: key.data.sid, secret: key.data.secret },
        };

        return {
          recordingId: row.id,
          businessId: row.business_id,
          agencyId: row.agency_id,
          providerRecordingSid: row.provider_recording_sid,
          credentials,
        };
      });

      if (opened === null) return;

      const fetched = await fetchRecordingMp3(
        options.fetcher ?? fetch,
        opened.credentials,
        opened.providerRecordingSid,
        { maxBytes: options.maxBytes },
      );

      const systemInvocation: Invocation = {
        context: {
          agencyId: opened.agencyId,
          businessId: opened.businessId,
          actorKind: 'system',
          correlationId: invocation.context.correlationId,
        },
        permissions: 'all',
      };

      if (fetched.outcome === 'not_found' || fetched.outcome === 'too_large') {
        await withTenant(services.db, systemInvocation.context, async (trx) => {
          await trx
            .updateTable('messaging.call_recordings')
            .set({ fetch_failure: fetched.outcome, updated_at: sql`now()` })
            .where('id', '=', opened.recordingId)
            .where('business_id', '=', opened.businessId)
            .execute();
        });
        return;
      }

      if (fetched.outcome === 'unknown' || fetched.outcome === 'rejected') {
        throw new Error(
          `Fetching call recording audio failed (${fetched.outcome}); the job will retry.`,
        );
      }

      await runCommand(
        services,
        attachRecordingFileCommand(files),
        {
          recordingId: opened.recordingId,
          content: fetched.content,
        },
        systemInvocation,
      );
    },
  });
}
