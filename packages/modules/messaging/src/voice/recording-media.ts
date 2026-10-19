// Provider documentation for recording downloads:
// https://www.twilio.com/docs/voice/api/recording
// https://support.twilio.com/hc/en-us/articles/360002588893-Downloading-and-Deleting-Twilio-Call-Recordings
import type { TwilioCredentials } from '../twilio-api.js';

const RECORDING_SID = /^RE[0-9a-fA-F]{32}$/;
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

export type FetchRecordingResult =
  | { readonly outcome: 'fetched'; readonly content: Uint8Array }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'too_large' }
  | { readonly outcome: 'rejected'; readonly status?: number }
  | { readonly outcome: 'unknown' };

export interface FetchRecordingOptions {
  readonly maxBytes?: number | undefined;
}

/**
 * Downloads a recording's MP3 audio from Twilio directly.
 * Rejects without touching the network if credentials or SID are malformed.
 * Does not leak credentials, URLs, or SIDs into errors or logs.
 */
export async function fetchRecordingMp3(
  fetcher: typeof fetch,
  credentials: TwilioCredentials,
  recordingSid: string,
  options: FetchRecordingOptions = {},
): Promise<FetchRecordingResult> {
  if (!RECORDING_SID.test(recordingSid) || !ACCOUNT_SID.test(credentials.accountSid)) {
    return { outcome: 'rejected' };
  }

  const identity = credentials.apiKey?.sid ?? credentials.accountSid;
  const secret = credentials.apiKey?.secret ?? credentials.authToken;
  const auth = `Basic ${Buffer.from(`${identity}:${secret}`, 'utf8').toString('base64')}`;
  const targetUrl = new URL(
    `/2010-04-01/Accounts/${credentials.accountSid}/Recordings/${recordingSid}.mp3`,
    'https://api.twilio.com',
  );

  let response: Response;
  try {
    response = await fetcher(targetUrl, {
      method: 'GET',
      headers: {
        authorization: auth,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { outcome: 'unknown' };
  }

  if (response.status >= 500) {
    return { outcome: 'unknown' };
  }

  if (response.status === 404) {
    return { outcome: 'not_found' };
  }

  if (response.status >= 400 && response.status < 500) {
    return { outcome: 'rejected', status: response.status };
  }

  if (response.status !== 200) {
    return { outcome: 'rejected', status: response.status };
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'audio/mpeg') {
    return { outcome: 'rejected', status: response.status };
  }

  const max = options.maxBytes ?? 50 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) {
    return { outcome: 'unknown' };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) {
        return { outcome: 'unknown' };
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > max) {
        try {
          await reader.cancel();
        } catch {
          // Ignore stream cancellation error when aborting early.
        }
        return { outcome: 'too_large' };
      }
      chunks.push(chunk);
    }
  } catch {
    return { outcome: 'unknown' };
  }

  return { outcome: 'fetched', content: new Uint8Array(Buffer.concat(chunks)) };
}
