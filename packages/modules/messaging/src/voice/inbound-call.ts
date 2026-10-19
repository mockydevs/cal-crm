// Twilio voice callback for incoming calls.
// Request parameters: https://www.twilio.com/docs/voice/twiml#request-parameters
// Dial action and status: https://www.twilio.com/docs/voice/twiml/dial
import { defineCommand, type Command, type CommandContext } from '@repo/commands';
import type { DatabaseTransaction } from '@repo/db';
import { ForbiddenError, toPublicId } from '@repo/kernel';
import { sql } from 'kysely';
import * as z from 'zod';
import { recordInboundCall, addCallLeg, type ReadCallGrants } from '../call-ledger.js';
import { inboundDoNotDisturbFrom } from '../inbound-dnd.js';
import { lockBusiness } from '../outbound.js';
import { readPhoneNumberSettings, readPhoneSystemSettings } from '../phone-settings.js';
import { voiceIdentity } from './voice-identity.js';
import { resolveInboundRoute, type InboundDestination } from './voice-routing.js';
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
  callSid: z.string().min(1).max(512),
  from: z.string().min(1).max(512),
  to: z.string().min(1).max(512),
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

async function refuseCall(
  trx: DatabaseTransaction,
  command: CommandContext,
  callId: string,
  failureCode: 'do_not_call' | 'number_unavailable' | 'contact_unavailable' | 'member_unavailable',
): Promise<VoiceCallbackReply> {
  await trx
    .updateTable('messaging.calls')
    .set({
      state: 'refused',
      failure_code: failureCode,
      ended_at: sql`now()`,
    })
    .where('id', '=', callId)
    .execute();
  const call = await trx
    .selectFrom('messaging.calls')
    .select(['state', 'outcome', 'contact_id'])
    .where('id', '=', callId)
    .executeTakeFirstOrThrow();
  await command.emit({
    type: 'call.progressed',
    subject: { kind: 'call', id: callId },
    payload: { state: call.state, outcome: call.outcome },
    records: call.contact_id === null ? [] : [call.contact_id],
  });
  return hangupReply;
}

export function createInboundCallCommand(
  publicUrl: string,
  readGrants: ReadCallGrants,
  addLeg: typeof addCallLeg = addCallLeg,
): Command<typeof input, VoiceCallbackReply> {
  return defineCommand({
    name: 'call.answer_inbound',
    permission: 'phone.manage',
    input,
    audit: ({ connectionId, callSid }) => ({ connectionId, callSid }),
    async handle(trx, value, command): Promise<VoiceCallbackReply> {
      if (command.context.actorKind !== 'system')
        throw new ForbiddenError('Only the voice worker answers incoming calls.');

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

      const phoneNumber = await trx
        .selectFrom('messaging.phone_numbers')
        .select('id')
        .where('provider_connection_id', '=', value.connectionId)
        .where('e164', '=', value.to)
        .executeTakeFirst();
      if (phoneNumber === undefined) return hangupReply;

      const numberSettings = await readPhoneNumberSettings(
        trx,
        command,
        toPublicId('phone_number', phoneNumber.id),
      );
      const recordingUrl = voiceWebhookUrl(publicUrl, value.webhookToken, { kind: 'recording' });
      const voice = numberSettings.voice;
      const recording =
        voice?.recording.enabled && recordingUrl !== null
          ? { enabled: true as const, statusCallback: recordingUrl }
          : { enabled: false as const };
      const announcement =
        voice?.recording.announcement.enabled && voice.recording.announcement.message !== null
          ? voice.recording.announcement.message
          : undefined;

      const recorded = await recordInboundCall(trx, command.context, {
        phoneNumberId: phoneNumber.id,
        connectionId: value.connectionId,
        providerCallId: value.callSid,
        from: value.from,
        to: value.to,
      });
      if (recorded === null) return hangupReply;
      const { callId, legId: rootLegId } = recorded;

      const call = await trx
        .selectFrom('messaging.calls')
        .select(['state', 'contact_id'])
        .where('id', '=', callId)
        .executeTakeFirst();
      if (call?.state !== 'ringing') return hangupReply;

      const existingRoute = await trx
        .selectFrom('messaging.call_routes')
        .selectAll()
        .where('business_id', '=', businessId)
        .where('call_id', '=', callId)
        .executeTakeFirst();

      if (existingRoute !== undefined) {
        if (existingRoute.step_leg_id === null) return hangupReply;
        let rawSteps: unknown = existingRoute.steps;
        if (typeof existingRoute.steps === 'string') {
          try {
            rawSteps = JSON.parse(existingRoute.steps) as unknown;
          } catch {
            return hangupReply;
          }
        }
        const parsed = inboundStepsSchema.safeParse(rawSteps);
        if (!parsed.success) return hangupReply;
        const currentStepDestinations = parsed.data[existingRoute.step];
        if ((currentStepDestinations?.length ?? 0) === 0 || currentStepDestinations === undefined)
          return hangupReply;

        const firstLeg = await trx
          .selectFrom('messaging.call_legs')
          .select(['id', 'to_address', 'created_at'])
          .where('id', '=', existingRoute.step_leg_id)
          .where('call_id', '=', callId)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        if (firstLeg === undefined) return hangupReply;

        const stepLegs = await trx
          .selectFrom('messaging.call_legs')
          .select(['id', 'to_address'])
          .where('call_id', '=', callId)
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
              ? { parameters: { callId: toPublicId('call', callId) } }
              : {}),
          });
        }

        const actionUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
          kind: 'dial-result',
          stepId: existingRoute.step_leg_id,
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
          timeoutSeconds: existingRoute.timeout_seconds,
          callerId: existingRoute.caller_id,
          recording,
          announcement,
        });
        return {
          statusCode: 200,
          contentType: 'application/xml',
          body,
        };
      }

      const isCallerNumber = /^\+[1-9][0-9]{6,14}$/.test(value.from);
      if (isCallerNumber && (await inboundDoNotDisturbFrom(trx, businessId, value.from))) {
        return refuseCall(trx, command, callId, 'do_not_call');
      }

      const systemSettings = await readPhoneSystemSettings(trx, command);

      let contactOwnerUserId: string | null = null;
      if (call.contact_id !== null) {
        const contact = await trx
          .selectFrom('crm.contacts')
          .select('owner_user_id')
          .where('id', '=', call.contact_id)
          .where('business_id', '=', businessId)
          .executeTakeFirst();
        contactOwnerUserId = contact?.owner_user_id ?? null;
      }

      const activeMembers = await trx
        .selectFrom('tenancy.memberships as m')
        .innerJoin('auth.users as u', 'u.id', 'm.user_id')
        .select(['m.id', 'm.user_id'])
        .where('m.agency_id', '=', command.context.agencyId)
        .where('m.business_id', '=', businessId)
        .where('u.disabled_at', 'is', null)
        .execute();

      const members = new Map<string, string>();
      const membershipIdToUserId = new Map<string, string>();
      let contactOwnerMembershipId: string | null = null;

      for (const m of activeMembers) {
        const grants = await readGrants(trx, command.context, m.user_id);
        if (grants?.has('calls.place')) {
          const publicMembershipId = toPublicId('membership', m.id);
          const identity = voiceIdentity(businessId, m.user_id);
          members.set(publicMembershipId, identity);
          membershipIdToUserId.set(publicMembershipId, m.user_id);
          if (contactOwnerUserId !== null && m.user_id === contactOwnerUserId) {
            contactOwnerMembershipId = publicMembershipId;
          }
        }
      }

      const ownNumbersRows = await trx
        .selectFrom('messaging.phone_numbers')
        .select('e164')
        .where('business_id', '=', businessId)
        .execute();
      const ownNumbers = ownNumbersRows.map((row) => row.e164);

      const voiceSetup = await trx
        .selectFrom('messaging.voice_setups')
        .select('status')
        .where('business_id', '=', businessId)
        .where('connection_id', '=', value.connectionId)
        .executeTakeFirst();
      const connectionReady = voiceSetup?.status === 'ready';

      const route = resolveInboundRoute({
        number: numberSettings,
        inbound: systemSettings.inbound,
        caller: value.from,
        contactOwnerMembershipId,
        connectionReady,
        members,
        ownNumbers,
      });

      if (route.outcome === 'refused') {
        const failureCode =
          route.reason === 'number_unavailable' ? 'number_unavailable' : 'contact_unavailable';
        return refuseCall(trx, command, callId, failureCode);
      }

      if (route.steps.length === 0) {
        return refuseCall(trx, command, callId, 'member_unavailable');
      }

      const step0 = route.steps[0];
      if (step0 === undefined) {
        return refuseCall(trx, command, callId, 'member_unavailable');
      }

      const ringingDestinations: InboundDestination[] = [];
      const dialDestinations: {
        kind: 'client' | 'number';
        address: string;
        progressUrl: string;
        parameters?: Record<string, string>;
      }[] = [];
      let firstStepLegId: string | null = null;
      for (const dest of step0) {
        const legId = await addLeg(trx, {
          callId,
          parentLegId: rootLegId,
          party: dest.kind === 'client' ? 'member' : 'remote',
          userId:
            dest.kind === 'client' ? (membershipIdToUserId.get(dest.membershipId) ?? null) : null,
          to: dest.address,
        });
        if (legId !== null) {
          firstStepLegId ??= legId;
          ringingDestinations.push(dest);
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
              ? { parameters: { callId: toPublicId('call', callId) } }
              : {}),
          });
        }
      }

      if (ringingDestinations.length === 0 || firstStepLegId === null) {
        return refuseCall(trx, command, callId, 'member_unavailable');
      }

      await trx
        .insertInto('messaging.call_routes')
        .values({
          business_id: businessId,
          call_id: callId,
          // Step 0 as it rings: a retried request dials exactly these again.
          steps: JSON.stringify([ringingDestinations, ...route.steps.slice(1)]),
          step: 0,
          step_leg_id: firstStepLegId,
          voicemail: route.voicemail,
          timeout_seconds: route.timeoutSeconds,
          caller_id: route.callerId,
        })
        .execute();

      const actionUrl = voiceWebhookUrl(publicUrl, value.webhookToken, {
        kind: 'dial-result',
        stepId: firstStepLegId,
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
        timeoutSeconds: route.timeoutSeconds,
        callerId: route.callerId,
        recording,
        announcement,
      });

      const callState = await trx
        .selectFrom('messaging.calls')
        .select(['state', 'outcome', 'contact_id'])
        .where('id', '=', callId)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'call.progressed',
        subject: { kind: 'call', id: callId },
        payload: { state: callState.state, outcome: callState.outcome },
        records: callState.contact_id === null ? [] : [callState.contact_id],
      });

      return {
        statusCode: 200,
        contentType: 'application/xml',
        body,
      };
    },
  });
}
