// Official verbs: https://www.twilio.com/docs/voice/twiml/dial , /number , /record , /gather
// Names/serialization cross-checked against installed twilio@6.1.2 VoiceResponse.
// Instructions only: tenant authorization, reservations and callback handling belong
// to the call engine. A single Dial action returns control there, avoiding accidental
// fallback dialing after a successfully answered call ends.
import * as z from 'zod';

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.hash === '' &&
    !url.hostname.includes('_')
  );
});
const e164 = z.string().regex(/^\+[1-9][0-9]{6,14}$/);
// XML 1.0 allows tab/newline/return and excludes controls and lone surrogates.
const message = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) =>
    Array.from(value).every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 9 ||
        code === 10 ||
        code === 13 ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    }),
  );
const parameterName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/);
const parameterValue = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{Cc}/u.test(value));
const destination = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('number'),
    address: e164,
    acceptUrl: httpsUrl.optional(),
    progressUrl: httpsUrl.optional(),
  }),
  z.strictObject({
    kind: z.literal('client'),
    address: z.string().regex(/^[A-Za-z0-9_]{1,121}$/),
    acceptUrl: httpsUrl.optional(),
    progressUrl: httpsUrl.optional(),
    // installed twilio@6.1.2 lib/twiml/VoiceResponse.d.ts, class Client: identity(), parameter(); https://www.twilio.com/docs/voice/twiml/client#custom-parameters
    parameters: z
      .record(parameterName, parameterValue)
      .refine((record) => Object.keys(record).length <= 4)
      .optional(),
  }),
]);
const dialInstructions = z.strictObject({
  destinations: z
    .array(destination)
    .min(1)
    .max(7)
    .refine(
      (values) =>
        new Set(values.map((value) => `${value.kind}:${value.address}`)).size === values.length,
    ),
  actionUrl: httpsUrl,
  progressUrl: httpsUrl,
  // Product limits shared with phone settings; not a statement of Twilio's maximum.
  timeoutSeconds: z.number().int().min(5).max(120),
  callerId: e164.optional(),
  announcement: message.optional(),
  recording: z.discriminatedUnion('enabled', [
    z.strictObject({ enabled: z.literal(false) }),
    z.strictObject({ enabled: z.literal(true), statusCallback: httpsUrl }),
  ]),
});
export type DialInstructions = z.infer<typeof dialInstructions>;

const escape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const response = (content: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
type Attribute = readonly [string, string | number | boolean];
const attributes = (values: readonly Attribute[]): string =>
  values.map(([name, value]) => `${name}="${escape(String(value))}"`).join(' ');
const say = (value: string): string => `<Say>${escape(value)}</Say>`;

/**
 * Call engine passes its resolved, authorized destinations and canonical callback URLs.
 * An announcement is spoken to the caller before dialing, answering that caller first.
 * answerOnBridge keeps ringing only when Dial is the first verb. Callee-only whispers
 * and confirmation belong in each target's acceptUrl, not this announcement.
 * https://www.twilio.com/docs/voice/twiml/dial#answeronbridge
 */
export function renderDial(input: unknown): string {
  const value = dialInstructions.parse(input);
  const dial: Attribute[] = [
    ['action', value.actionUrl],
    ['method', 'POST'],
    ['timeout', value.timeoutSeconds],
    ['answerOnBridge', true],
    ['record', value.recording.enabled ? 'record-from-answer-dual' : 'do-not-record'],
  ];
  if (value.callerId !== undefined) dial.push(['callerId', value.callerId]);
  if (value.recording.enabled)
    dial.push(
      ['recordingStatusCallback', value.recording.statusCallback],
      ['recordingStatusCallbackMethod', 'POST'],
      ['recordingStatusCallbackEvent', 'completed absent'],
    );
  const targets = value.destinations
    .map((target) => {
      const attrs: Attribute[] = [
        ['statusCallback', target.progressUrl ?? value.progressUrl],
        ['statusCallbackMethod', 'POST'],
        ['statusCallbackEvent', 'initiated ringing answered completed'],
      ];
      if (target.acceptUrl !== undefined) attrs.push(['url', target.acceptUrl], ['method', 'POST']);
      if (
        target.kind === 'client' &&
        target.parameters !== undefined &&
        Object.keys(target.parameters).length > 0
      ) {
        const params = Object.entries(target.parameters)
          .map(
            ([name, paramValue]) =>
              `<Parameter ${attributes([
                ['name', name],
                ['value', paramValue],
              ])}/>`,
          )
          .join('');
        return `<Client ${attributes(attrs)}><Identity>${escape(target.address)}</Identity>${params}</Client>`;
      }
      const tag = target.kind === 'number' ? 'Number' : 'Client';
      return `<${tag} ${attributes(attrs)}>${escape(target.address)}</${tag}>`;
    })
    .join('');
  return response(
    (value.announcement === undefined ? '' : say(value.announcement)) +
      `<Dial ${attributes(dial)}>${targets}</Dial>`,
  );
}

const voicemailInstructions = z
  .strictObject({
    greeting: message.nullable(),
    greetingAudioUrl: httpsUrl.optional(),
    actionUrl: httpsUrl,
    recordingUrl: httpsUrl,
    maxSeconds: z.number().int().min(5).max(600),
  })
  .refine((value) => value.greeting !== null || value.greetingAudioUrl !== undefined);
export type VoicemailInstructions = z.infer<typeof voicemailInstructions>;

export function renderVoicemail(input: unknown): string {
  const value = voicemailInstructions.parse(input);
  const greeting =
    value.greetingAudioUrl === undefined
      ? say(value.greeting ?? '')
      : `<Play>${escape(value.greetingAudioUrl)}</Play>`;
  return response(
    greeting +
      `<Record ${attributes([
        ['action', value.actionUrl],
        ['method', 'POST'],
        ['maxLength', value.maxSeconds],
        ['playBeep', true],
        ['recordingStatusCallback', value.recordingUrl],
        ['recordingStatusCallbackMethod', 'POST'],
        ['recordingStatusCallbackEvent', 'completed absent'],
      ])}/>`,
  );
}

const connectInstructions = z.strictObject({
  prompt: message,
  actionUrl: httpsUrl,
  requireConfirmation: z.boolean(),
});
export type CallConnectInstructions = z.infer<typeof connectInstructions>;

/** The action handler must accept only the configured digit after verifying its signature. */
export function renderCallConnect(input: unknown): string {
  const value = connectInstructions.parse(input);
  if (!value.requireConfirmation) return response(say(value.prompt));
  return response(
    `<Gather ${attributes([
      ['action', value.actionUrl],
      ['method', 'POST'],
      ['input', 'dtmf'],
      ['numDigits', 1],
      ['timeout', 5],
    ])}>${say(value.prompt)}</Gather><Hangup/>`,
  );
}

export function renderHangup(): string {
  return response('<Hangup/>');
}
