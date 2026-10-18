// STOP, START and HELP in an inbound SMS.
//
// What Twilio does on its own (https://www.twilio.com/docs/messaging/twiml, "'STOP' and
// opt-out", and .../messaging/tutorials/advanced-opt-out): for long code numbers it handles
// the standard English opt-out words itself, blocks later sends to that person from that
// number (error 21610) until they opt back in, and still passes the message to our webhook.
// It tells us its verdict (OptOutType) only when the customer has turned on Advanced
// Opt-Out for a Messaging Service. So the words are recognised here too.
//
// What the law asks (47 CFR 64.1200(a)(10), the FCC's 2024 revocation order, in force as
// read on eCFR 2026-10-01): a reply of "stop", "quit", "end", "revoke", "opt out", "cancel"
// or "unsubscribe" revokes consent per se, and a reply in other words revokes it "if a
// reasonable person would understand those words to have conveyed a request to revoke
// consent". Revocations are honoured within ten business days; we honour them at once.
// FCC 26-67 (adopted 2026-09-30, not yet in force) keeps the seven words as the standard
// set, so recognising them in any spelling satisfies both texts.
//
// Our rule, which is ours and not Twilio's (Twilio does not publish how it matches):
// - letter case is ignored, as is white space and punctuation around the message, and a
//   hyphen or underscore inside it ("opt-out", "Opt_Out" and "OPT OUT" are one phrase);
// - a message that is one of the words, or one of the plain-language revocations below,
//   with at most a "please" or a "thanks" around it, is a STOP;
// - any other sentence is an ordinary message for a person to read. A wider net would end
//   consent people did not end ("cancel my appointment" is about the appointment), and a
//   person on the team answers what is unclear;
// - only English in plain Latin letters; other languages and look-alike letters are not
//   keywords, unless Twilio itself says so through OptOutType;
// - "YES" is not an opt-in here: people answer ordinary questions with it.

/** Twilio's default opt-out words for long codes (advanced-opt-out tutorial). */
export const OPT_OUT_KEYWORDS = [
  'STOP',
  'UNSUBSCRIBE',
  'END',
  'QUIT',
  'STOPALL',
  'REVOKE',
  'OPTOUT',
  'CANCEL',
] as const;
/** The opt-in words Twilio reserves ("Start" and "unstop"). */
export const OPT_IN_KEYWORDS = ['START', 'UNSTOP'] as const;
/** The help word Twilio reserves. */
export const HELP_KEYWORDS = ['HELP'] as const;

export type SmsKeyword = 'stop' | 'start' | 'help';

/**
 * Plain-language revocations a reasonable person reads as "stop texting me" (47 CFR
 * 64.1200(a)(10)), as whole messages in the normalized form keywordPhrase gives. Each
 * says only that; none can be read as a request about something else.
 */
export const OPT_OUT_PHRASES: ReadonlySet<string> = new Set([
  // The seven words of the rule, as two words or one.
  'opt out',
  'un subscribe',
  'stop all',
  'stop stop',
  'stop it',
  'stop now',
  ...['texting', 'messaging', 'sending', 'contacting'].flatMap((verb) => [
    `stop ${verb}`,
    `stop ${verb} me`,
    `quit ${verb}`,
    `quit ${verb} me`,
  ]),
  ...['texts', 'messages', 'text messages', 'sms'].flatMap((what) => [
    `stop ${what}`,
    `stop all ${what}`,
    `stop the ${what}`,
    `stop these ${what}`,
    `stop sending ${what}`,
    `stop sending me ${what}`,
    `cancel ${what}`,
    `cancel all ${what}`,
    `end ${what}`,
    `no more ${what}`,
    `opt out of ${what}`,
    `unsubscribe from ${what}`,
  ]),
  'unsubscribe me',
  'opt me out',
  'remove me',
  'remove my number',
  ...['your', 'the', 'this', 'my'].flatMap((list) => [
    `remove me from ${list} list`,
    `take me off ${list} list`,
    `unsubscribe me from ${list} list`,
  ]),
  'take me off',
  ...['text', 'message', 'contact', 'call or text'].flatMap((verb) => [
    `do not ${verb} me`,
    `dont ${verb} me`,
    `do not ${verb} me again`,
    `dont ${verb} me again`,
  ]),
  'leave me alone',
  'revoke consent',
  'revoke my consent',
  'i revoke consent',
  'i revoke my consent',
  'i want to opt out',
  'i want to unsubscribe',
  'cancel subscription',
  'cancel my subscription',
]);

// Courtesies around a revocation that change nothing about it.
const COURTESY =
  /^(?:(?:please|pls|plz|kindly|thanks|thank you|thx|ty)\s+)+|(?:\s+(?:please|pls|plz|thanks|thank you|thx|ty))+$/g;

/**
 * A message as it is compared with the phrases: lower case, apostrophes dropped ("don't"
 * is "dont"), every run of anything that isn't a Latin letter one space, courtesies off.
 */
export function keywordPhrase(body: string): string {
  return body
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .replace(COURTESY, '')
    .trim();
}

// Everything that isn't a letter or a digit, at either end.
const AROUND = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

/** A message as it is compared with the keywords: its edges removed, in upper case. */
export function keywordText(body: string): string {
  return body.replace(AROUND, '').toUpperCase();
}

const includes = (list: readonly string[], word: string) => list.includes(word);

/**
 * The keyword a message is, or null for an ordinary message. Twilio's own OptOutType, when
 * it is one of its three documented values, decides: the customer may have configured
 * other words there. Any other value is not understood, and the text is read instead.
 */
export function smsKeyword(body: string, optOutType?: string): SmsKeyword | null {
  if (optOutType === 'STOP') return 'stop';
  if (optOutType === 'START') return 'start';
  if (optOutType === 'HELP') return 'help';
  const word = keywordText(body);
  if (includes(OPT_OUT_KEYWORDS, word)) return 'stop';
  // Only Latin letters, spaces and punctuation: digits or other scripts are not a phrase.
  if (/^[\p{P}\p{Z}\s\p{S}A-Za-z'’]+$/u.test(body)) {
    const phrase = keywordPhrase(body);
    if (OPT_OUT_PHRASES.has(phrase) || includes(OPT_OUT_KEYWORDS, phrase.toUpperCase()))
      return 'stop';
  }
  if (includes(OPT_IN_KEYWORDS, word)) return 'start';
  if (includes(HELP_KEYWORDS, word)) return 'help';
  return null;
}
