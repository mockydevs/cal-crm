// The app cannot open provider credentials. It relays only voice webhooks to the worker,
// which verifies the provider signature and returns call instructions. This boundary grants
// no tenant access and never treats a capability URL as proof.
import { parseVoiceCallbackPath } from '@repo/module-messaging';
import { voiceWorkerOriginOf } from './config.js';

const BODY_LIMIT = 65_536;

export interface VoiceRelayRequest {
  /** Raw path + query only; never a URL or a forwarded Host header. */
  readonly path: string;
  readonly body: Uint8Array;
  readonly signature: string | undefined;
}
export interface VoiceRelayReply {
  readonly statusCode: number;
  readonly contentType: 'application/xml' | 'text/plain';
  readonly body: string;
}

const unavailable = (): VoiceRelayReply => ({
  statusCode: 503,
  contentType: 'text/plain',
  body: 'Voice service unavailable.',
});
const refused = (statusCode: number): VoiceRelayReply => ({
  statusCode,
  contentType: 'text/plain',
  body: 'Voice request refused.',
});

/** Fixed operator configuration, never a destination taken from an HTTP request. */
export function createVoiceRelay(options: {
  readonly workerOrigin: string;
  readonly fetcher?: typeof fetch;
}): (request: VoiceRelayRequest) => Promise<VoiceRelayReply> {
  const origin = voiceWorkerOriginOf(options.workerOrigin);
  const fetcher = options.fetcher ?? fetch;
  return async (request) => {
    const target = parseVoiceCallbackPath(request.path);
    if (target === null) return refused(400);
    const notification = ['progress', 'ended', 'recording'].includes(target.kind);
    if (request.body.byteLength > BODY_LIMIT) return refused(413);
    if (
      request.signature === undefined ||
      request.signature === '' ||
      request.signature.length > 512 ||
      /[\r\n]/.test(request.signature)
    )
      return refused(403);
    try {
      const response = await fetcher(new URL(request.path, origin), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-twilio-signature': request.signature,
        },
        body: Buffer.from(request.body),
        redirect: 'manual',
        // Twilio's hard call-response budget is15s; leave room for public transport.
        signal: AbortSignal.timeout(5000),
      });
      if ([400, 403, 404, 429].includes(response.status)) {
        await response.body?.cancel();
        return refused(response.status);
      }
      const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (notification && response.status === 204) {
        await response.body?.cancel();
        return { statusCode: 204, contentType: 'text/plain', body: '' };
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        return unavailable();
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await reader?.read();
        if (next === undefined || next.done) break;
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new Error('Invalid voice response.');
        bytes += chunk.byteLength;
        if (bytes > BODY_LIMIT) {
          await reader?.cancel();
          return unavailable();
        }
        chunks.push(chunk);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      if (notification && body === '')
        return { statusCode: 200, contentType: 'text/plain', body: '' };
      if (body === '' || (type !== 'application/xml' && type !== 'text/xml')) return unavailable();
      return { statusCode: 200, contentType: 'application/xml', body };
    } catch {
      // Do not log error objects, provider bodies, callback URLs or their capabilities.
      return unavailable();
    }
  };
}
