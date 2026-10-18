// What Settings → Phone System works out before it draws: a number's settings and the
// business's calling defaults as their editors hold them and as the API takes them, where
// each problem is, where a call goes first, and which numbers a search finds. The contract
// (packages/contracts/src/phone-system.ts) checks every save first, so a problem found here
// reads as the server's own would.
import {
  updatePhoneNumberSettingsInput,
  updatePhoneSystemSettingsInput,
  type PhoneNumberSettings,
  type PhoneNumberVoiceSettings,
  type PhoneSystemSettings,
  type UpdatePhoneNumberSettingsInput,
  type UpdatePhoneSystemSettingsInput,
} from '@repo/contracts';
import type * as z from 'zod';

/** How many more people may ring with a number's first person: our limit, not Twilio's. */
export const MAX_RING_ALSO = 6;

/** What a number's editor changes: everything a save sends but the revision. */
export type NumberDraft = Omit<UpdatePhoneNumberSettingsInput, 'revision'>;
/** What the business settings' editor changes. */
export type SystemDraft = Omit<UpdatePhoneSystemSettingsInput, 'revision'>;
type Routing = PhoneNumberVoiceSettings['routing'];
type Recording = PhoneNumberVoiceSettings['recording'];

export interface FieldProblem {
  readonly code: string;
  readonly message: string;
}

/** What is wrong, by the JSON pointer of where it is; '' for the whole of it. */
export type Problems = Readonly<Record<string, FieldProblem>>;

export type Checked<Input> =
  | { readonly ok: true; readonly input: Input }
  | { readonly ok: false; readonly problems: Problems };

export function numberDraftOf(number: PhoneNumberSettings): NumberDraft {
  return { name: number.name, ownerId: number.ownerId, voice: number.voice };
}

export function systemDraftOf(settings: PhoneSystemSettings): SystemDraft {
  return {
    defaultNumberId: settings.defaultNumberId,
    inbound: settings.inbound,
    outbound: settings.outbound,
    recording: settings.recording,
    missedCallText: settings.missedCallText,
  };
}

/** Whether two drafts would save the same. */
export function sameDraft(a: NumberDraft | SystemDraft, b: NumberDraft | SystemDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A message left blank or only spaces is no message. */
const textOrNull = (text: string | null): string | null =>
  text === null || text.trim() === '' ? null : text;

/** The first problem for each place, as the API's problem details list them. */
export function problemsOf(
  issues: readonly { readonly path: string; readonly code: string; readonly message: string }[],
): Problems {
  const problems: Record<string, FieldProblem> = {};
  for (const issue of issues) problems[issue.path] ??= { code: issue.code, message: issue.message };
  return problems;
}

/** The problem of a field, or of anything under it, such as one of several people. */
export function problemAt(problems: Problems, pointer: string): FieldProblem | undefined {
  const own = problems[pointer];
  if (own !== undefined) return own;
  const under = Object.keys(problems).find((path) => path.startsWith(`${pointer}/`));
  return under === undefined ? undefined : problems[under];
}

function issuesOf(error: z.ZodError): Problems {
  return problemsOf(
    error.issues.map((issue) => ({
      path: `/${issue.path.map(String).join('/')}`,
      code: issue.code,
      message: issue.message,
    })),
  );
}

export function numberInput(
  draft: NumberDraft,
  revision: string,
): Checked<UpdatePhoneNumberSettingsInput> {
  const voice = draft.voice;
  const parsed = updatePhoneNumberSettingsInput.safeParse({
    ...draft,
    voice:
      voice === null
        ? null
        : {
            ...voice,
            recording: {
              ...voice.recording,
              announcement: {
                ...voice.recording.announcement,
                message: textOrNull(voice.recording.announcement.message),
              },
            },
            advanced: {
              ...voice.advanced,
              whisper: {
                ...voice.advanced.whisper,
                message: textOrNull(voice.advanced.whisper.message),
              },
            },
          },
    revision,
  });
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, problems: issuesOf(parsed.error) };
}

export function systemInput(
  draft: SystemDraft,
  revision: string,
): Checked<UpdatePhoneSystemSettingsInput> {
  const parsed = updatePhoneSystemSettingsInput.safeParse({
    ...draft,
    missedCallText: {
      ...draft.missedCallText,
      message: textOrNull(draft.missedCallText.message),
    },
    revision,
  });
  return parsed.success
    ? { ok: true, input: parsed.data }
    : { ok: false, problems: issuesOf(parsed.error) };
}

/** A new first person, who then no longer also rings beside themselves. */
export function withPrimary(routing: Routing, memberId: string | null): Routing {
  return {
    ...routing,
    primaryMemberId: memberId,
    ringAlso: routing.ringAlso.filter((each) => each !== memberId),
  };
}

export function canRingMore(ringAlso: readonly string[]): boolean {
  return ringAlso.length < MAX_RING_ALSO;
}

/** Recording on or off; with it off, no announcement says a call is recorded. */
export function withRecording(recording: Recording, enabled: boolean): Recording {
  return {
    enabled,
    announcement: enabled ? recording.announcement : { ...recording.announcement, enabled: false },
  };
}

export type Destination =
  | { readonly kind: 'no_voice' }
  | { readonly kind: 'member'; readonly memberId: string }
  | { readonly kind: 'forward'; readonly e164: string }
  | { readonly kind: 'fallback' }
  | { readonly kind: 'voicemail' }
  | { readonly kind: 'nobody' };

/** Where a call to the number goes first, in the routing's order of priority. */
export function destinationOf(voice: PhoneNumberVoiceSettings | null): Destination {
  if (voice === null) return { kind: 'no_voice' };
  const routing = voice.routing;
  if (routing.primaryMemberId !== null)
    return { kind: 'member', memberId: routing.primaryMemberId };
  if (routing.forwardTo !== null) return { kind: 'forward', e164: routing.forwardTo };
  if (routing.useBusinessFallback) return { kind: 'fallback' };
  return routing.voicemailBackup ? { kind: 'voicemail' } : { kind: 'nobody' };
}

const digitsOf = (text: string): string => text.replace(/\D/g, '');

/**
 * Whether a number is one a search asks for: by its name, by its owner's name, or by its
 * digits however they are written, such as (415) 555-0123 for +14155550123.
 */
export function matchesSearch(
  number: PhoneNumberSettings,
  query: string,
  ownerName: (memberId: string | null) => string | undefined,
): boolean {
  const words = query.trim().toLowerCase();
  if (words === '') return true;
  if (number.name.toLowerCase().includes(words)) return true;
  if (ownerName(number.ownerId)?.toLowerCase().includes(words) === true) return true;
  const digits = digitsOf(words);
  return (
    digits !== '' &&
    digits === words.replace(/[\s()+.-]/g, '') &&
    digitsOf(number.e164).includes(digits)
  );
}

/** The numbers that can take calls: the only ones that can be the default. */
export function voiceNumbers(numbers: readonly PhoneNumberSettings[]): PhoneNumberSettings[] {
  return numbers.filter((number) => number.capabilities.includes('voice'));
}
