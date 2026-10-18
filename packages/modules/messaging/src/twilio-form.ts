// A Twilio webhook's raw application/x-www-form-urlencoded body, read into the names and
// values its signature covers. Twilio signs values exactly as sent: "Some frameworks may
// trim whitespace from POST body fields ... You must turn off these behaviors"
// (https://www.twilio.com/docs/usage/security#notes). So nothing is trimmed or repaired,
// and a body that can't be read exactly is refused whole.
import type { SignedParams } from './twilio-signature.js';

/** Bounds for one webhook body. An inbound SMS is about 30 fields and 1,600 characters. */
export const FORM_LIMITS = { bytes: 65_536, fields: 200, nameLength: 100 } as const;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decode(part: string): string | null {
  try {
    // In a form, "+" is a space; a literal plus arrives as %2B.
    return decodeURIComponent(part.replaceAll('+', ' '));
  } catch {
    return null;
  }
}

/** The body's parameters, or null when it is too large or not a well-formed form. */
export function parseForm(body: Uint8Array): SignedParams | null {
  if (body.byteLength > FORM_LIMITS.bytes) return null;
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    return null;
  }
  // No prototype: a parameter named __proto__ or toString is only a parameter.
  const params: Record<string, string | string[]> = Object.create(null) as Record<
    string,
    string | string[]
  >;
  let fields = 0;
  for (const pair of text.split('&')) {
    if (pair === '') continue;
    fields += 1;
    if (fields > FORM_LIMITS.fields) return null;
    const separator = pair.indexOf('=');
    const name = decode(separator === -1 ? pair : pair.slice(0, separator));
    const value = separator === -1 ? '' : decode(pair.slice(separator + 1));
    if (name === null || value === null) return null;
    if (name === '' || name.length > FORM_LIMITS.nameLength) return null;
    const existing = params[name];
    if (existing === undefined) params[name] = value;
    else if (typeof existing === 'string') params[name] = [existing, value];
    else existing.push(value);
  }
  return params;
}

/** A parameter sent exactly once; a missing or repeated one gives undefined. */
export function singleValue(params: SignedParams, name: string): string | undefined {
  const value = Object.hasOwn(params, name) ? params[name] : undefined;
  return typeof value === 'string' ? value : undefined;
}
