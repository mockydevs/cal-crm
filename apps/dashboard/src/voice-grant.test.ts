import type { VoiceGrant as Answer } from '@repo/contracts';
import { expect, it } from 'vitest';
import { grantRequester, VoiceGrantRefused, type GrantClient } from './voice-grant';

const id = 'vgr_01k8e2wzr0e008000000000001';
const requested: Answer = { id, status: 'requested', token: null, expiresAt: null, failure: null };
const issued: Answer = {
  id,
  status: 'issued',
  token: 'eyJ.token.sig',
  expiresAt: '2026-10-17T12:10:00.000Z',
  failure: null,
};

/** Answers in turn, recording each operation and its input. */
function server(...answers: readonly Answer[]) {
  const calls: { operation: string; input: unknown }[] = [];
  const client = {
    request: (endpoint: { operationId: string }, input: unknown) => {
      calls.push({ operation: endpoint.operationId, input });
      const answer = answers[calls.length - 1];
      return answer === undefined
        ? Promise.reject(new Error('No answer left.'))
        : Promise.resolve(answer);
    },
  } as GrantClient;
  return { client, calls };
}

it('asks once, reads until the worker signs, and hands over the token', async () => {
  const fake = server(requested, requested, issued);
  const grant = await grantRequester(fake.client, { intervalMs: 1 })(new AbortController().signal);
  expect(grant).toEqual({ token: 'eyJ.token.sig', expiresAt: '2026-10-17T12:10:00.000Z' });
  expect(fake.calls).toEqual([
    { operation: 'requestVoiceGrant', input: {} },
    { operation: 'getVoiceGrant', input: { params: { id } } },
    { operation: 'getVoiceGrant', input: { params: { id } } },
  ]);
});

it('says why when the worker refused, or when a token came back already expired', async () => {
  const refused = server(requested, {
    ...requested,
    status: 'failed',
    failure: { code: 'member_unavailable', message: 'x' },
  });
  await expect(
    grantRequester(refused.client, { intervalMs: 1 })(new AbortController().signal),
  ).rejects.toEqual(new VoiceGrantRefused('member_unavailable'));
  const stale = server({ ...issued, token: null });
  await expect(grantRequester(stale.client)(new AbortController().signal)).rejects.toMatchObject({
    code: 'expired',
  });
});

it('gives up after its time, and stops at once when the softphone is closed', async () => {
  const slow = server(requested, requested, requested, requested);
  await expect(
    grantRequester(slow.client, { intervalMs: 5, timeoutMs: 1 })(new AbortController().signal),
  ).rejects.toMatchObject({ code: 'timeout' });
  const closing = new AbortController();
  const pending = grantRequester(server(requested, requested).client, { intervalMs: 10_000 })(
    closing.signal,
  );
  closing.abort(new Error('closed'));
  await expect(pending).rejects.toThrow('closed');
});
