// What may be kept as a fact about a contact, as rules with no database in them.
//
// A fact is read from what a contact wrote, by a model, and is later shown to people and
// handed to other models as something known. So the words of a fact are the one place an
// outsider's text could come to be treated as knowledge. The contract already holds a fact
// to one short line (contact-facts.ts). The screen here refuses, whoever would approve it
// and whatever the model was told:
//
//   * a line that talks to its reader or about instructions, or that says what the
//     business said, promised, allowed or owes: a fact is about the contact, and a contact
//     cannot give themselves a discount by saying they were given one;
//   * contact details and links: an address or a number belongs in the contact's own
//     fields, where it is checked, and a link is somewhere a later reader could be sent;
//   * the sensitive categories (health, money matters, beliefs, origin, sexuality, criminal
//     history, credentials): the design does not say these may be kept, so they are not.
//
// It is a word screen, in English. It is one layer of several, and it errs towards keeping
// less: what it lets through is still only proposed, still one line of data between
// markers, and still for a person to remove. What it stops in another language is left to
// the instructions the model is given and to the person who approves.
import { FACT_STATEMENT_MAX_LENGTH, isPlainLine } from '@repo/contracts';

export type ScreenRefusal = 'instruction' | 'business_claim' | 'contact_detail' | 'sensitive';

/** Words to the reader, or about the instructions a model works under. */
const INSTRUCTION: readonly RegExp[] = [
  /\b(ignore|disregard|override|bypass|jailbreak)\b/i,
  /\b(instructions?|prompts?|system message|guardrails?|guidelines)\b/i,
  /\b(chatbot|ai|llm|language model|gpt|claude|gemini)\b/i,
  // A contact may have an assistant of their own; a line that says what "the assistant"
  // is to do is not about them.
  /\b(the|this|an|any|every) assistant (must|should|shall|will|can|may|is to|needs to|has to|always|never)\b/i,
  /\b(you|your|yours|yourself)\b/i,
  /\b(from now on|make sure|be sure to|remember to|remember that|do not forget|note to self)\b/i,
  /\b(always|never|must|should|shall|need to|needs to|have to|has to)\b.{0,60}\b(reply|respond|answer|say|tell|offer|give|send|grant|approve|agree|include|mention|write|forward|share|reveal|apply)\b/i,
];

/** What the business is said to have said, promised, allowed or to owe. */
const BUSINESS_CLAIM: readonly RegExp[] = [
  /\b(owner|manager|management|staff|team|business|company|support|admin|administrator|employee|agent|representative|rep|supervisor|director|boss|ceo)\b.{0,80}\b(said|says|say|promised|promises|agreed|agrees|approved|approves|authori[sz]ed|confirmed|guaranteed|offered|told|granted|owes|owe|allowed|allows)\b/i,
  /\b(is|are|was|were|been|be) (entitled|eligible|owed|promised|guaranteed|approved|authori[sz]ed|exempt|pre-?approved)\b/i,
  /\b(discounts?|refunds?|free of charge|for free|at no cost|credits?|vouchers?|coupons?|compensation|waive[ds]?|price match|reimburse\w*|chargeback)\b/i,
  /\b(vip|priority (customer|client|status|treatment)|premium (customer|client|status)|special (status|treatment|rate|price|terms))\b/i,
];

/** Addresses and links. Phone numbers are counted by their digits (below). */
const CONTACT_DETAIL: readonly RegExp[] = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\b(?:https?:\/\/|www\.)\S+/i,
];

/** Health, money matters, beliefs, origin, sexuality, criminal history and credentials. */
const SENSITIVE: readonly RegExp[] = [
  /\b(diagnos\w*|cancer|tumou?r|diabet\w*|hiv|aids|pregnan\w*|miscarr\w*|ivf|disabilit\w*|disabled|illness\w*|disease\w*|surgery|surgeries|chemo\w*|medicat\w*|prescri\w*|therap\w*|depress\w*|anxiety|mental health|allerg\w*|asthma\w*|epilep\w*|dementia|alzheimer\w*|autis\w*|adhd|wheelchair|hospital\w*|medical\w*|health|rehab\w*|addict\w*|alcoholi\w*|sober|sobriety|injur\w*|terminal\w*)\b/i,
  /\b(salar\w*|income|wages?|debts?|bankrupt\w*|credit score|credit rating|credit card|debit card|card number|bank account|account number|sort code|iban|routing number|loans?|mortgage\w*|overdraft|net worth|tax return|unemploy\w*|benefits claimant)\b/i,
  /\b(social security|ssn|national insurance|national id|passport|driver'?s licen[cs]e|driving licen[cs]e|tax id|date of birth)\b/i,
  /\b(religio\w*|muslim|islam\w*|christian\w*|jewish|judaism|hindu\w*|sikh\w*|buddhis\w*|catholic\w*|protestant\w*|atheis\w*|agnostic)\b/i,
  /\b(political\w*|democrat|republican|socialist|communist|trade union|union member|votes? for|voted for)\b/i,
  /\b(ethnic\w*|racial\w*|nationality|immigration status|asylum|refugee|undocumented|visa status)\b/i,
  /\b(sexual\w*|gay|lesbian|bisexual|transgender|non-?binary|queer|sex life)\b/i,
  /\b(criminal\w*|convict\w*|arrest\w*|prison\w*|jail\w*|probation|parole|felon\w*|restraining order)\b/i,
  /\b(passwords?|passcodes?|pin code|pin number|security code|cvv|cvc|login|log-in|api key|secret key|access token|recovery code|one-time code)\b/i,
];

/** A run of digits and what separates them holds a phone, card or account number at nine. */
const NUMBER_DIGITS = 9;

function holdsLongNumber(text: string): boolean {
  for (const run of text.match(/\+?\d[\d\s().-]*\d/g) ?? [])
    if (run.replaceAll(/\D/g, '').length >= NUMBER_DIGITS) return true;
  return false;
}

const matchesAny = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

/** Why a line reads as words to its reader rather than about the contact, or undefined. */
export function screenInstruction(text: string): 'instruction' | 'business_claim' | undefined {
  if (matchesAny(INSTRUCTION, text)) return 'instruction';
  if (matchesAny(BUSINESS_CLAIM, text)) return 'business_claim';
  return undefined;
}

/**
 * Why a line may not be kept as a fact, or undefined when it may. The same answer every
 * time for the same line.
 */
export function screenFact(statement: string): ScreenRefusal | undefined {
  const refused = screenInstruction(statement);
  if (refused !== undefined) return refused;
  if (matchesAny(CONTACT_DETAIL, statement) || holdsLongNumber(statement)) return 'contact_detail';
  if (matchesAny(SENSITIVE, statement)) return 'sensitive';
  return undefined;
}

/**
 * A fact as two readers compare it: case, spacing and the full stop at its end do not make
 * two facts of one.
 */
export function normalizeFact(statement: string): string {
  return statement
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .replace(/[.!\s]+$/, '')
    .trim();
}

/**
 * A stored fact as a later prompt is given it: one line, cut to the length a fact may
 * have. A fact written before the limits existed, or by hand, is held to them here.
 */
export function factForPrompt(statement: string): string | undefined {
  const line = statement
    .replaceAll(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, FACT_STATEMENT_MAX_LENGTH);
  return line === '' || !isPlainLine(line) ? undefined : line;
}
