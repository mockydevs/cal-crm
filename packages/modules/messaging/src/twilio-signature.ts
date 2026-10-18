/*!
 * Portions of this file are derived from the Twilio Node.js SDK (npm package "twilio",
 * version 6.1.2, file src/webhooks/webhooks.ts, https://github.com/twilio/twilio-node):
 * expectedSignature (getExpectedTwilioSignature), expectedBodyHash (getExpectedBodyHash),
 * validateSignature (validateRequest), validateBody, validateSignatureWithBody
 * (validateRequestWithBody), and the helpers withStandardPort (buildUrlWithStandardPort),
 * addPort, removePort, withLegacyQuerystring, signedParam (toFormUrlEncodedParam) and
 * safeCompare. That SDK is distributed under the following licence, reproduced in full
 * from its LICENSE file:
 *
 * MIT License
 *
 * Copyright (C) 2023, Twilio, Inc. <https://www.twilio.com/help/contact>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Twilio's webhook signature (X-Twilio-Signature), ported function for function from the
// official SDK: twilio-node src/webhooks/webhooks.ts, version 6.1.2. The algorithm is
// documented at https://www.twilio.com/docs/usage/security#validating-requests.
//
// Ported: getExpectedTwilioSignature, getExpectedBodyHash, validateRequest (all four URL
// variants), validateBody, validateRequestWithBody.
// Not ported, on purpose: validateIncomingRequest, validateExpressRequest and webhook(),
// which rebuild the URL from an Express request's Host header and protocol. Here the URL
// always comes from our own configuration, never from the request.
import crypto from 'node:crypto';
import { parse, stringify } from 'node:querystring';

/** Form parameters by name; a name sent more than once holds every value. */
export type SignedParams = Readonly<Record<string, string | readonly string[]>>;

// Node's URL leaves the standard port out, so it is put back by hand.
function withStandardPort(parsed: URL): string {
  const port = parsed.protocol === 'https:' ? ':443' : ':80';
  let url = parsed.protocol ? `${parsed.protocol}//` : '';
  url += parsed.username;
  url += parsed.password ? `:${parsed.password}` : '';
  url += parsed.username || parsed.password ? '@' : '';
  url += parsed.host ? parsed.host + port : '';
  url += parsed.pathname + parsed.search + parsed.hash;
  return url;
}

function addPort(parsed: URL): string {
  return parsed.port ? parsed.toString() : withStandardPort(parsed);
}

function removePort(parsed: URL): string {
  const copy = new URL(parsed);
  copy.port = '';
  return copy.toString();
}

// The query string as Node's older querystring module writes it: it escapes characters
// that URL leaves alone, such as a single quote.
function withLegacyQuerystring(url: string): string {
  const parsed = new URL(url);
  if (!parsed.search) return url;
  const query = parse(parsed.search.slice(1));
  parsed.search = '';
  return `${parsed.toString()}?${stringify(query)}`;
}

// A repeated parameter is signed once per distinct value, the values in sorted order.
function signedParam(name: string, value: string | readonly string[]): string {
  if (typeof value === 'string') return name + value;
  return [...new Set(value)]
    .sort()
    .map((each) => name + each)
    .join('');
}

/** The signature Twilio would send for this URL and these parameters. */
export function expectedSignature(authToken: string, url: string, params: SignedParams): string {
  let data = url;
  // Default sort: by UTF-16 code unit, which is the SDK's "case-sensitive" order.
  for (const name of Object.keys(params).sort()) {
    const value = params[name];
    if (value !== undefined) data += signedParam(name, value);
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

// timingSafeEqual throws on unequal lengths. The length of a signature isn't secret.
function safeCompare(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function matches(authToken: string, signature: string, url: string, params: SignedParams): boolean {
  return safeCompare(
    Buffer.from(signature),
    Buffer.from(expectedSignature(authToken, url, params)),
  );
}

/**
 * Whether the signature is Twilio's for this request. As the SDK does, the URL is tried
 * without its port, with it, and both again with the older query-string escaping, "since
 * signature generation on the back end is inconsistent". Throws on a URL that can't be
 * parsed: that is a mistake in our configuration, not in the request.
 */
export function validateSignature(
  authToken: string,
  signature: string,
  url: string,
  params: SignedParams,
): boolean {
  const parsed = new URL(url);
  return (
    matches(authToken, signature, removePort(parsed), params) ||
    matches(authToken, signature, addPort(parsed), params) ||
    matches(authToken, signature, withLegacyQuerystring(removePort(parsed)), params) ||
    matches(authToken, signature, withLegacyQuerystring(addPort(parsed)), params)
  );
}

/** The bodySHA256 value Twilio adds to the URL of a request with a JSON body. */
export function expectedBodyHash(body: string): string {
  return crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
}

export function validateBody(body: string, bodyHash: string): boolean {
  return safeCompare(Buffer.from(bodyHash), Buffer.from(expectedBodyHash(body)));
}

/** For a JSON body: the URL is signed with no parameters, and names the body's hash. */
export function validateSignatureWithBody(
  authToken: string,
  signature: string,
  url: string,
  body: string,
): boolean {
  return (
    validateSignature(authToken, signature, url, {}) &&
    validateBody(body, new URL(url).searchParams.get('bodySHA256') ?? '')
  );
}
