// What the business layout's softphone (softphone.tsx) and its lazy active part
// (softphone-active.tsx) both name. Kept apart so neither file imports the other: the layout
// only loads the active part on demand.
import type { BrowserVoice, BrowserVoiceOptions, BrowserVoiceState } from './voice-browser';

export interface SoftphoneValue {
  readonly state: BrowserVoiceState;
  /** Asks the server for a call to the identity; answers the server's refusal, if any. */
  readonly placeCall: (contactIdentityId: string) => Promise<string | undefined>;
}

export type CreateVoice = (options: BrowserVoiceOptions) => BrowserVoice;

export interface ActiveSoftphoneProps {
  readonly businessId: string;
  readonly createVoice?: CreateVoice | undefined;
  readonly onValue: (value: SoftphoneValue | null) => void;
}
