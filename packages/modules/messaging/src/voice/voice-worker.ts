import { defineCommand, runCommand, type Services } from '@repo/commands';
import type { Vault } from '@repo/module-vault';
import { ForbiddenError } from '@repo/kernel';
import * as z from 'zod';
import {
  addCallLeg,
  recordCallProgress,
  recordInboundTerminal,
  type CallProgressResult,
  type ReadCallGrants,
} from '../call-ledger.js';
import { endCallReference } from '../call-requests.js';
import { lockBusiness } from '../outbound.js';
import { webhookDigest } from '../sms-webhook-url.js';
import { createInboundAdvanceCommand } from './inbound-advance.js';
import { createInboundCallCommand } from './inbound-call.js';
import { authenticateVoiceCallback } from './voice-context.js';
import { parseVoiceProgress } from './voice-progress.js';
import { parseVoiceTerminal } from './voice-terminal.js';
import type { verifyVoiceRequest } from './voice-request.js';

export interface VoiceCallbackReply {
  readonly statusCode: number;
  readonly contentType: 'application/xml' | 'text/plain';
  readonly body: string;
}
const reply = (statusCode: number): VoiceCallbackReply => ({
  statusCode,
  contentType: 'text/plain',
  body: '',
});
const input = z.strictObject({
  connectionId: z.uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(['progress', 'ended']),
  legId: z.uuid().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

// Private to this authenticated boundary: no API route exposes this command. The
// caller verifies the original URL and every signed parameter before running it.
const apply = defineCommand({
  name: 'call.apply_voice_callback',
  permission: 'phone.manage',
  input,
  audit: ({ connectionId, kind, legId }) => ({ connectionId, kind, legId }),
  async handle(trx, value, command): Promise<VoiceCallbackReply> {
    if (command.context.actorKind !== 'system')
      throw new ForbiddenError('Only the voice worker applies provider callbacks.');
    await lockBusiness(trx, command.context);
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
    if (connection === undefined) return reply(404);
    let result: { readonly result: CallProgressResult; readonly callId: string | null };
    let hangUpWaiting = false;
    if (value.kind === 'progress') {
      const progress = parseVoiceProgress(value.params, connection.account_ref);
      if (progress === null || value.legId === null) return reply(400);
      const recorded = await recordCallProgress(trx, {
        connectionId: value.connectionId,
        legId: value.legId,
        progress,
      });
      result = recorded;
      hangUpWaiting = recorded.hangUpWaiting;
    } else {
      const terminal = parseVoiceTerminal(value.params, connection.account_ref);
      if (terminal === null || value.legId !== null) return reply(400);
      result = await recordInboundTerminal(trx, { connectionId: value.connectionId, terminal });
    }
    if (result.callId === null) return reply(404);
    if (result.result === 'advanced') {
      const call = await trx
        .selectFrom('messaging.calls')
        .select(['state', 'outcome', 'contact_id'])
        .where('id', '=', result.callId)
        .executeTakeFirstOrThrow();
      await command.emit({
        type: 'call.progressed',
        subject: { kind: 'call', id: result.callId },
        payload: { state: call.state, outcome: call.outcome },
        records: call.contact_id === null ? [] : [call.contact_id],
      });
      if (hangUpWaiting) command.enqueue(endCallReference, { callId: result.callId });
    }
    return reply(204);
  },
});

/** Worker/all role only. Other instruction handlers stay unavailable until built. */
export function createVoiceCallbackWorker(
  services: Services,
  vault: Vault,
  publicUrl: string,
  readGrants: ReadCallGrants,
  addLeg: typeof addCallLeg = addCallLeg,
): {
  handle(request: Parameters<typeof verifyVoiceRequest>[0]): Promise<VoiceCallbackReply>;
} {
  const inboundCall = createInboundCallCommand(publicUrl, readGrants, addLeg);
  const inboundAdvance = createInboundAdvanceCommand(publicUrl, readGrants, addLeg);
  return {
    async handle(request) {
      const checked = await authenticateVoiceCallback(services.db, vault, publicUrl, request);
      if (checked.outcome === 'refused') return reply(checked.statusCode);
      const { target, params } = checked.verified;
      if (target.kind === 'dial-result') {
        if (target.stepId === undefined) return reply(400);
        const firstParam = (v: string | readonly string[] | undefined): string | undefined =>
          typeof v === 'string' ? v : v?.[0];
        const dialBridged = firstParam(params['DialBridged']) === 'true';
        const dialStatusResult = z
          .enum(['completed', 'answered', 'busy', 'no-answer', 'failed', 'canceled'])
          .safeParse(firstParam(params['DialCallStatus']));
        const dialStatus = dialStatusResult.success ? dialStatusResult.data : null;
        return runCommand(
          services,
          inboundAdvance,
          {
            connectionId: checked.connectionId,
            digest: webhookDigest(target.token),
            webhookToken: target.token,
            stepLegId: target.stepId,
            dialBridged,
            dialStatus,
          },
          { context: checked.context, permissions: 'all' },
        );
      }
      if (target.kind === 'inbound') {
        const { call } = checked.verified;
        if (!call.from || !call.to || call.direction !== 'inbound') return reply(400);
        return runCommand(
          services,
          inboundCall,
          {
            connectionId: checked.connectionId,
            digest: webhookDigest(target.token),
            webhookToken: target.token,
            callSid: call.callSid,
            from: call.from,
            to: call.to,
          },
          { context: checked.context, permissions: 'all' },
        );
      }
      if (target.kind !== 'progress' && target.kind !== 'ended') return reply(503);
      return runCommand(
        services,
        apply,
        {
          connectionId: checked.connectionId,
          digest: webhookDigest(target.token),
          kind: target.kind,
          legId: target.stepId ?? null,
          params,
        },
        { context: checked.context, permissions: 'all' },
      );
    },
  };
}
