// The one way out to a model provider: one HTTP exchange over node's own client, with a
// deadline for the whole of it, a cap on what is read, and a guard on where it may go. The
// adapters read the answer as it arrives, so a long stream is not held in memory twice and
// a stalled one ends at the deadline.
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';

import {
  checkServerUrl,
  resolveServerAddress,
  type LocalServer,
  type ServerLookup,
} from './addresses.js';

export type AiTransportErrorCode =
  'blocked_address' | 'network' | 'timeout' | 'too_large' | 'cancelled';

/** Why no answer could be read. The message names the kind only: never an address or a key. */
export class AiTransportError extends Error {
  override readonly name = 'AiTransportError';

  constructor(readonly code: AiTransportErrorCode) {
    super(`The model provider could not be reached (${code}).`);
  }
}

export interface AiHttpCall {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** DNS, connecting, sending and reading the whole answer, in milliseconds. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface AiHttpAnswer {
  readonly status: number;
  /** A response header by name, whatever its case. */
  header(name: string): string | undefined;
  /** The body as it arrives. It fails with AiTransportError, and can be read once. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Ends the exchange. Safe to call again, and after the body was read. */
  close(): void;
}

/** Fails with AiTransportError when no answer starts; a status of 400 or 500 is an answer. */
export type AiTransport = (call: AiHttpCall) => Promise<AiHttpAnswer>;

export type AiRequester = (options: RequestOptions, secure: boolean) => ClientRequest;

export interface AiTransportOptions {
  /** The install's own model servers (AI_LOCAL_SERVERS). */
  readonly localServers?: readonly LocalServer[];
  readonly lookup?: ServerLookup;
  /** The most that is read of one answer. */
  readonly maxResponseBytes?: number;
  /** Stands in for node's client in tests. */
  readonly requester?: AiRequester;
}

export const AI_MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * A lookup for node's client that answers with the checked address whatever it is asked,
 * so the socket goes where the guard looked and a second DNS answer can't redirect it. The
 * request's host stays the name, so TLS still checks the certificate against it.
 */
function pinnedLookup(address: string, family: number): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

const systemRequester: AiRequester = (options, secure) =>
  secure ? httpsRequest(options) : httpRequest(options);

export function createAiTransport(options: AiTransportOptions = {}): AiTransport {
  const localServers = options.localServers ?? [];
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requester = options.requester ?? systemRequester;

  return async (call) => {
    const cancelled = (): boolean => call.signal?.aborted === true;
    if (cancelled()) throw new AiTransportError('cancelled');
    if (
      !Number.isInteger(call.timeoutMs) ||
      call.timeoutMs < 1 ||
      call.timeoutMs > AI_MAX_TIMEOUT_MS
    )
      throw new RangeError(
        `A provider call's deadline is 1 to ${String(AI_MAX_TIMEOUT_MS)} milliseconds.`,
      );
    const checked = checkServerUrl(call.url, localServers);
    if (!checked.ok) throw new AiTransportError('blocked_address');

    // In an object, because it changes from a timer while this function is waiting.
    const deadline = { passed: false };
    let request: ClientRequest | undefined;
    const timer = setTimeout(() => {
      deadline.passed = true;
      request?.destroy();
    }, call.timeoutMs);
    const close = (): void => {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', abort);
      request?.destroy();
    };
    const abort = (): void => {
      request?.destroy();
    };
    call.signal?.addEventListener('abort', abort, { once: true });
    const failed = (): AiTransportError =>
      new AiTransportError(cancelled() ? 'cancelled' : deadline.passed ? 'timeout' : 'network');

    try {
      const resolved = await resolveServerAddress(checked, options.lookup);
      if (cancelled()) throw new AiTransportError('cancelled');
      // DNS can answer after the deadline; nothing may be sent by then.
      if (deadline.passed) throw new AiTransportError('timeout');
      if (!resolved.ok) throw new AiTransportError(resolved.code);
      const body = call.body;
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        try {
          request = requester(
            {
              method: call.method,
              host: checked.url.hostname.replace(/^\[|\]$/g, ''),
              port: checked.port,
              path: `${checked.url.pathname}${checked.url.search}`,
              headers: {
                ...call.headers,
                ...(body === undefined
                  ? {}
                  : { 'content-length': String(Buffer.byteLength(body)) }),
              },
              // A fresh connection every time: a pooled socket would skip the lookup below.
              agent: false,
              lookup: pinnedLookup(resolved.address, resolved.family),
            },
            checked.secure,
          );
        } catch {
          reject(new AiTransportError('network'));
          return;
        }
        request.on('error', () => {
          reject(failed());
        });
        request.on('response', resolve);
        request.end(body);
      });

      const headers = response.headers;
      async function* read(): AsyncGenerator<Uint8Array> {
        let size = 0;
        try {
          if (cancelled()) throw new AiTransportError('cancelled');
          for await (const chunk of response) {
            if (!Buffer.isBuffer(chunk)) throw new AiTransportError('network');
            size += chunk.byteLength;
            if (size > maxBytes) throw new AiTransportError('too_large');
            yield chunk;
          }
        } catch (error) {
          throw error instanceof AiTransportError ? error : failed();
        } finally {
          close();
        }
      }
      return {
        status: response.statusCode ?? 0,
        header: (name) => {
          const value = headers[name.toLowerCase()];
          return typeof value === 'string' ? value : value?.[0];
        },
        body: read(),
        close,
      };
    } catch (error) {
      close();
      throw error;
    }
  };
}

/** Reads a whole answer as text, up to a limit of its own. */
export async function readBody(answer: AiHttpAnswer, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for await (const chunk of answer.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new AiTransportError('too_large');
      chunks.push(chunk);
    }
  } finally {
    answer.close();
  }
  return Buffer.concat(chunks).toString('utf8');
}
