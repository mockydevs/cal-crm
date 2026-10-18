// Twilio Dial action callback: ring the next step when nobody answers.
// Twilio facts: DialBridged is true only when the dialed party was connected to the caller;
// a hang-up during screening reports completed.
// https://www.twilio.com/docs/voice/twiml/dial
// https://www.twilio.com/docs/voice/twiml/changelog
import { defineCommand, type Command } from '@repo/commands';
import { ForbiddenError, parsePublicId, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { addCallLeg, type ReadCallGrants } from '../call-ledger.js';
import { lockBusiness } from '../outbound.js';
import { renderDial, renderHangup } from './voice-twiml.js';
import { voiceWebhookUrl } from './voice-url.js';
import type { VoiceCallbackReply } from './voice-worker.js';

const hangupReply: VoiceCallbackReply = {
  statusCode: 200,
  contentType: 'application/xml',
  body: renderHangup(),
};

const input = z.strictObject({
  connectionId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  webhookToken: z.string().min(1).max(128),
  stepLegId: z.uuid(),
  dialBridged: z.boolean(),
  dialStatus: z
    .enum(['completed', 'answered', 'busy', 'no-answer', 'failed', 'canceled'])
    .nullable(),
});

const inboundDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('client'),
    address: z.string().regex(/^[A-Za-z0-9_]{1,121}$/),
    membershipId: z.string(),
  }),
  z.strictObject({
    kind: z.literal('number'),
    address: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  }),
]);

const inboundStepsSchema = z.array(z.array(inboundDestinationSchema));

export function createInboundAdvanceCommand(
  publicUrl: string,
  readGrants: ReadCallGrants,
  addLeg: typeof addCallLeg = addCallLeg,
): Command<typeof input, VoiceCallbackReply> {
  return defineCommand({
    name: 'call.advance_inbound',
    permission: 'phone.manage',
    input,
    audit: ({ connectionId, stepLegId }) => ({ connectionId, stepLegId }),
    async handle(trx, value, command): Promise<VoiceCallbackReply> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the voice worker advances incoming calls.');

      const businessId = await lockBusiness(trx, command.context);

      const connection = await trx
        .selectFrom('messaging.provider_connections as c')
        .innerJoin('tenancy.businesses as b', 'b.id', 'c.business_id')
        .select('c.account_ref')
        .where('c.id', '=', value.connectionId)
        .where('c.provider', '=', 'twilio')
        .where('c.status', '=', 'connected')
        .where('c.webhook_digest', '=', value.digest)
        .where('b.status', '=', 'active')
        .forShare('c')
        .executeTakeFirst();
      if (connection === undefined) return hangupReply;

      const leg = await trx
        .selectFrom('messaging.call_legs')
        .select(['id', 'call_id', 'parent_leg_id'])
        .where('id', '=', value.stepLegId)
        .where('business_id', '=', businessId)
        .where('provider_connection_id', '=', value.connectionId)
        .executeTakeFirst();
      if (leg === undefined) return hangupReply;

      const call = await trx
        .selectFrom('messaging.calls')
        .select(['id', 'state', 'outcome', 'contact_id'])
        .where('id', '=', leg.call_id)
        .where('business_id', '=', businessId)
        .executeTakeFirst();
      if (call === undefined) return hangupReply;

      const rootLeg = await trx
        .selectFrom('messaging.call_legs')
        .select('id')
        .where('call_id', '=', call.id)
        .where('business_id', '=', businessId)
        .where('parent_leg_id', 'is', null)
        .executeTakeFirst();
      if (rootLeg === undefined) return hangupReply;
      const rootLegId = rootLeg.id;

      const route = await trx
        .selectFrom('messaging.call_routes')
        .selectAll()
        .where('business_id', '=', businessId)
        .where('call_id', '=', call.id)
        .forUpdate()
        .executeTakeFirst();
      if (route === undefined) return hangupReply;

      if (route.finished_at !== null) return hangupReply;

      let rawSteps: unknown = route.steps;
      if (typeof route.steps === 'string') {
        try {
          rawSteps = JSON.parse(route.steps) as unknown;
        } catch {
          return hangupReply;
        }
      }
      const parsed = inboundStepsSchema.safeParse(rawSteps);
      if (!parsed.success) return hangupReply;
      const parsedSteps = parsed.data;

      if (route.step_leg_id !== value.stepLegId) {
        if (route.step_leg_id === null) return hangupReply;
        const currentStepDestinations = parsedSteps[route.step];
        if (!currentStepDestinations || currentStepDestinations.length === 0) return hangupReply;

        const firstLeg = await trx
          .selectFrom('messaging.call_legs')
          .select(['id', 'to_address', 'created_at'])
          .where('id', '=', route.step_leg_id)
          .where('call_id', '=', call.id)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        if (firstLeg === undefined) return hangupReply;

        const stepLegs = await trx
          .selectFrom('messaging.call_legs')
          .select(['id', 'to_address'])
          .where('call_id', '=', call.id)
          .where('business_id', '=', businessId)
          .where('parent_leg_id', '=', rootLegId)
          .where('created_at', '>=', firstLeg.created_at)
          .orderBy('created_at', 'asc')
          .execute();

        const legsByAddress = new Map<string, string>();
        for (const l of stepLegs) {
          if (l.to_address !== null && !legsByAddress.has(l.to_address)) {
            legsByAddress.set(l.to_address, l.id);
          }
        }

        const dialDestinations: {
          kind: 'client' | 'number';
          address: string;
          progressUrl: string;
          parameters?: Record<string, string>;
        }[] = [];
        for (const dest of currentStepDestinations) {
          const legId =
            dest.address === firstLeg.to_address ? firstLeg.id : legsByAddress.get(dest.address);
          if (legId === undefined) return hangupReply;
          const legProgressUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
            kind: 'progress',
            stepId: legId,
          });
          if (legProgressUrl === null) return hangupReply;
          dialDestinations.push({
            kind: dest.kind,
            address: dest.address,
            progressUrl: legProgressUrl,
            ...(dest.kind === 'client'
              ? { parameters: { callId: toPublicId('call', call.id) } }
              : {}),
          });
        }

        const actionUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
          kind: 'dial-result',
          stepId: route.step_leg_id,
        });
        const progressUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
          kind: 'progress',
          stepId: rootLegId,
        });
        if (actionUrl === null || progressUrl === null) return hangupReply;
        const body = renderDial({
          destinations: dialDestinations,
          actionUrl,
          progressUrl,
          timeoutSeconds: route.timeout_seconds,
          callerId: route.caller_id,
          recording: { enabled: false },
        });
        return {
          statusCode: 200,
          contentType: 'application/xml',
          body,
        };
      }

      const emitProgressed = async () => {
        const callState = await trx
          .selectFrom('messaging.calls')
          .select(['state', 'outcome', 'contact_id'])
          .where('id', '=', call.id)
          .where('business_id', '=', businessId)
          .executeTakeFirstOrThrow();
        await command.emit({
          type: 'call.progressed',
          subject: { kind: 'call', id: call.id },
          payload: { state: callState.state, outcome: callState.outcome },
          records: callState.contact_id === null ? [] : [callState.contact_id],
        });
      };

      if (value.dialBridged) {
        await trx
          .updateTable('messaging.call_routes')
          .set({ finished_at: sql`now()` })
          .where('business_id', '=', businessId)
          .where('call_id', '=', call.id)
          .execute();
        await emitProgressed();
        return hangupReply;
      }

      let targetStep = route.step + 1;
      while (targetStep < parsedSteps.length) {
        const stepDestinations = parsedSteps[targetStep];
        if (!stepDestinations || stepDestinations.length === 0) {
          targetStep++;
          continue;
        }

        const validDestinations: {
          dest: (typeof stepDestinations)[number];
          userId: string | null;
        }[] = [];
        for (const dest of stepDestinations) {
          if (dest.kind === 'client') {
            const membershipUuid = parsePublicId('membership', dest.membershipId);
            if (membershipUuid === undefined) continue;

            const memberRow = await trx
              .selectFrom('tenancy.memberships as m')
              .innerJoin('auth.users as u', 'u.id', 'm.user_id')
              .select(['m.id', 'm.user_id'])
              .where('m.id', '=', membershipUuid)
              .where('m.agency_id', '=', command.context.agencyId)
              .where('m.business_id', '=', businessId)
              .where('u.disabled_at', 'is', null)
              .executeTakeFirst();
            if (memberRow === undefined) continue;

            const grants = await readGrants(trx, command.context, memberRow.user_id);
            if (!grants?.has('calls.place')) continue;

            validDestinations.push({ dest, userId: memberRow.user_id });
          } else {
            validDestinations.push({ dest, userId: null });
          }
        }

        if (validDestinations.length === 0) {
          targetStep++;
          continue;
        }

        const ringingDestinations: typeof stepDestinations = [];
        const dialDestinations: {
          kind: 'client' | 'number';
          address: string;
          progressUrl: string;
          parameters?: Record<string, string>;
        }[] = [];
        let firstNewLegId: string | null = null;
        for (const item of validDestinations) {
          const legId = await addLeg(trx, {
            callId: call.id,
            parentLegId: rootLegId,
            party: item.dest.kind === 'client' ? 'member' : 'remote',
            userId: item.userId,
            to: item.dest.address,
          });
          if (legId !== null) {
            firstNewLegId ??= legId;
            ringingDestinations.push(item.dest);
            const legProgressUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
              kind: 'progress',
              stepId: legId,
            });
            if (legProgressUrl === null) return hangupReply;
            dialDestinations.push({
              kind: item.dest.kind,
              address: item.dest.address,
              progressUrl: legProgressUrl,
              ...(item.dest.kind === 'client'
                ? { parameters: { callId: toPublicId('call', call.id) } }
                : {}),
            });
          }
        }

        if (ringingDestinations.length === 0 || firstNewLegId === null) {
          targetStep++;
          continue;
        }

        const updatedSteps = [...parsedSteps];
        updatedSteps[targetStep] = ringingDestinations;

        await trx
          .updateTable('messaging.call_routes')
          .set({
            step: targetStep,
            step_leg_id: firstNewLegId,
            steps: JSON.stringify(updatedSteps),
          })
          .where('business_id', '=', businessId)
          .where('call_id', '=', call.id)
          .execute();

        const actionUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
          kind: 'dial-result',
          stepId: firstNewLegId,
        });
        const progressUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
          kind: 'progress',
          stepId: rootLegId,
        });
        if (actionUrl === null || progressUrl === null) return hangupReply;

        const body = renderDial({
          destinations: dialDestinations,
          actionUrl,
          progressUrl,
          timeoutSeconds: route.timeout_seconds,
          callerId: route.caller_id,
          recording: { enabled: false },
        });

        await emitProgressed();

        return {
          statusCode: 200,
          contentType: 'application/xml',
          body,
        };
      }

      // When voicemail is enabled this will transition to voicemail; until then the call hangs up.
      await trx
        .updateTable('messaging.call_routes')
        .set({
          step: sql`jsonb_array_length(steps)`,
          finished_at: sql`now()`,
        })
        .where('business_id', '=', businessId)
        .where('call_id', '=', call.id)
        .execute();

      await emitProgressed();
      return hangupReply;
    },
  });
}
