// The provider boundary for finding, pricing, buying, reading and releasing phone numbers,
// and for listing and starting verification of outgoing caller IDs (PS8).
//
// Every operation, parameter and field was checked against:
// - Twilio's OpenAPI files (twilio-oai, commit 141f1201b55abcc16b3aa8089e71c4a927326975,
//   unchanged on main at 2026-10-15): spec/json/twilio_api_v2010.json for
//   ListAvailablePhoneNumberLocal/TollFree/Mobile, CreateIncomingPhoneNumber,
//   ListIncomingPhoneNumber, FetchIncomingPhoneNumber, DeleteIncomingPhoneNumber,
//   ListOutgoingCallerId and CreateValidationRequest; spec/json/twilio_pricing_v1.json for
//   FetchPhoneNumberCountry on https://pricing.twilio.com.
// - The installed twilio@6.1.2 SDK: lib/rest/api/v2010/account/availablePhoneNumberCountry/
//   {local,tollFree,mobile}.js, incomingPhoneNumber.js, outgoingCallerId.js,
//   validationRequest.js, lib/rest/pricing/v1/phoneNumber/country.js and lib/rest/PricingBase.js.
// - Twilio's docs: phone-numbers/pricing (prices are decimal strings; number_type is local,
//   mobile, national or toll free), voice/api/outgoing-caller-ids (a validation request
//   places a call; FriendlyName up to 64 characters, CallDelay 0 to 60, StatusCallback up to
//   1,000 characters; the caller ID exists only after VerificationStatus=success), and
//   phone-numbers/api/incomingphonenumber-resource (deleting releases the number, which
//   Twilio may give to another customer).
//
// Nothing here decides whether a business may buy, release or verify: callers authorize and
// reserve first. A paid or call-placing request is sent once and never repeated here, and an
// answer we can't trust is `unknown`, for the caller to reconcile with a read.
import * as z from 'zod';

import type { TwilioCredentials, TwilioResponse } from '../twilio-api.js';

export const NUMBER_API_ORIGIN = 'https://api.twilio.com';
export const NUMBER_PRICING_ORIGIN = 'https://pricing.twilio.com';
const ORIGINS = new Map([
  ['api', NUMBER_API_ORIGIN],
  ['pricing', NUMBER_PRICING_ORIGIN],
] as const);

export type NumberHost = 'api' | 'pricing';
export interface NumberRequest {
  readonly host: NumberHost;
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path and query on the host; never a full URL. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}
/**
 * Sends one request. A rejection means no answer was read: the request may or may not have
 * reached Twilio.
 */
export type NumberTransport = (request: NumberRequest) => Promise<TwilioResponse>;

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const NUMBER_SID = /^PN[0-9a-fA-F]{32}$/;
const CALL_SID = /^CA[0-9a-fA-F]{32}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const COUNTRY = /^[A-Z]{2}$/;

// Paths are anchored from their first character, so no path can name another host.
const ACCOUNT = '/2010-04-01/Accounts/AC[0-9a-fA-F]{32}';
const QUERY = '(\\?[A-Za-z0-9=&%_.~+*-]*)?';
const OWNED = `${ACCOUNT}/IncomingPhoneNumbers/PN[0-9a-fA-F]{32}\\.json`;
const exact = (pattern: string) => new RegExp(`^${pattern}$`);
const ALLOWED: readonly {
  readonly host: NumberHost;
  readonly method: NumberRequest['method'];
  readonly path: RegExp;
}[] = [
  {
    host: 'api',
    method: 'GET',
    path: exact(`${ACCOUNT}/AvailablePhoneNumbers/[A-Z]{2}/(Local|TollFree|Mobile)\\.json${QUERY}`),
  },
  { host: 'pricing', method: 'GET', path: exact('/v1/PhoneNumbers/Countries/[A-Z]{2}') },
  { host: 'api', method: 'POST', path: exact(`${ACCOUNT}/IncomingPhoneNumbers\\.json`) },
  { host: 'api', method: 'GET', path: exact(`${ACCOUNT}/IncomingPhoneNumbers\\.json${QUERY}`) },
  { host: 'api', method: 'GET', path: exact(OWNED) },
  // The only DELETE: one owned number, by its own SID.
  { host: 'api', method: 'DELETE', path: exact(OWNED) },
  // The only POST to an owned number, used to set where its calls go.
  { host: 'api', method: 'POST', path: exact(OWNED) },
  { host: 'api', method: 'GET', path: exact(`${ACCOUNT}/OutgoingCallerIds\\.json${QUERY}`) },
  { host: 'api', method: 'POST', path: exact(`${ACCOUNT}/OutgoingCallerIds\\.json`) },
];

/** Whether a request is one this boundary may ever send. */
export function isAllowedNumberRequest(host: string, method: string, path: string): boolean {
  return ALLOWED.some(
    (each) => each.host === host && each.method === method && each.path.test(path),
  );
}

export interface NumberTransportOptions {
  readonly fetcher?: typeof fetch;
  /** The whole exchange, in milliseconds. */
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Fixed hosts, no redirects, a bounded response. No path or credential in thrown errors. */
export function createNumberTransport(options: NumberTransportOptions = {}): NumberTransport {
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  return async (request) => {
    const origin = ORIGINS.get(request.host);
    if (origin === undefined || !isAllowedNumberRequest(request.host, request.method, request.path))
      throw new Error('This number request is not allowed.');
    const response = await fetcher(new URL(request.path, origin), {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error('The number response was not bytes.');
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader?.cancel();
        throw new Error('The number response was too large.');
      }
      chunks.push(chunk);
    }
    return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
  };
}

// --- Shared outcomes -----------------------------------------------------------------------

/** Twilio did not act: the input was refused here (httpStatus 0) or Twilio answered 4xx. */
export interface NumberRejected {
  readonly outcome: 'rejected';
  readonly httpStatus: number;
  readonly code: number | null;
}
export type NumberReadFailure =
  /** Twilio refused the credentials (401/403). */
  | { readonly outcome: 'refused' }
  | NumberRejected
  /** No usable answer: the network, Twilio, or a response we can't trust. */
  | { readonly outcome: 'unavailable' };
/** Twilio may have acted. Never repeated automatically; reconcile with a read. */
export interface NumberUnknown {
  readonly outcome: 'unknown';
  readonly reason: 'no_response' | 'server_error' | 'unreadable' | 'unexpected_status';
}

const invalid: NumberRejected = { outcome: 'rejected', httpStatus: 0, code: null };
const unavailable = { outcome: 'unavailable' } as const;
const unreadable: NumberUnknown = { outcome: 'unknown', reason: 'unreadable' };

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Twilio's error body: { status, message, code?, more_info? }. Only the code is read.
const errorBody = z.object({ code: z.number().int().positive() });
function rejectedBy(response: TwilioResponse): NumberRejected {
  const parsed = errorBody.safeParse(json(response.body));
  return {
    outcome: 'rejected',
    httpStatus: response.status,
    code: parsed.success ? parsed.data.code : null,
  };
}
const isClientError = (status: number) => status >= 400 && status < 500;

function readFailure(response: TwilioResponse | null): NumberReadFailure {
  if (response === null) return unavailable;
  if (response.status === 401 || response.status === 403) return { outcome: 'refused' };
  return isClientError(response.status) ? rejectedBy(response) : unavailable;
}

function writeFailure(response: TwilioResponse | null): NumberRejected | NumberUnknown {
  if (response === null) return { outcome: 'unknown', reason: 'no_response' };
  if (isClientError(response.status)) return rejectedBy(response);
  if (response.status >= 500 && response.status < 600)
    return { outcome: 'unknown', reason: 'server_error' };
  return { outcome: 'unknown', reason: 'unexpected_status' };
}

const isSuccess = (response: TwilioResponse | null): response is TwilioResponse =>
  response !== null && response.status >= 200 && response.status < 300;

// An API key authenticates REST calls when there is one; the Account SID stays in the path.
function authorization(credentials: TwilioCredentials): string {
  const user = credentials.apiKey?.sid ?? credentials.accountSid;
  const secret = credentials.apiKey?.secret ?? credentials.authToken;
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

async function exchange(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  host: NumberHost,
  method: NumberRequest['method'],
  path: string,
  form?: URLSearchParams,
): Promise<TwilioResponse | null> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: authorization(credentials),
  };
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  try {
    return await transport({
      host,
      method,
      path,
      headers,
      ...(form === undefined ? {} : { body: form.toString() }),
    });
  } catch {
    return null;
  }
}

const accountPath = (credentials: TwilioCredentials) =>
  `/2010-04-01/Accounts/${credentials.accountSid}`;

// Text Twilio returns is bounded and free of control characters before it leaves here.
const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^\P{Cc}*$/u);
const optionalText = (max: number) => text(max).nullable().optional();
const capabilitiesBody = z
  .object({
    sms: z.boolean().optional(),
    mms: z.boolean().optional(),
    voice: z.boolean().optional(),
  })
  .nullable()
  .optional();
export type NumberCapability = 'sms' | 'mms' | 'voice';
function capabilityList(capabilities: z.infer<typeof capabilitiesBody>): NumberCapability[] {
  return (['sms', 'mms', 'voice'] as const).filter((name) => capabilities?.[name] === true);
}
export const addressRequirements = ['none', 'any', 'local', 'foreign'] as const;
export type AddressRequirement = (typeof addressRequirements)[number];

const httpsUrl = z
  .url()
  .max(1000)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
    );
  });
const name = text(64).min(1);

// --- Searching available numbers ----------------------------------------------------------

// The Contains grammar from ListAvailablePhoneNumberLocal: 2 to 16 characters, at least two
// letters or digits in one run, wildcards (* and %) only at the ends, and an anchor (+ at the
// start, $ at the end) never next to a wildcard.
const CONTAINS = /^(\+|[*%]*)[0-9A-Za-z]{2,}(\$|[*%]*)$/;
const NORTH_AMERICA = new Set(['US', 'CA']);
const searchQuery = z
  .strictObject({
    country: z.string().regex(COUNTRY),
    kind: z.enum(['local', 'toll_free', 'mobile']),
    /** US and Canada only, per the spec. */
    areaCode: z.number().int().min(200).max(999).optional(),
    contains: z.string().min(2).max(16).regex(CONTAINS).optional(),
    /** US and Canada only, per the spec. */
    inRegion: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    /** US and Canada only, per the spec. */
    inPostalCode: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/)
      .optional(),
    inLocality: text(64).min(1).optional(),
    capabilities: z
      .strictObject({
        voice: z.boolean().optional(),
        sms: z.boolean().optional(),
        mms: z.boolean().optional(),
      })
      .optional(),
    /** Leaves out numbers that need any Address registered first. */
    excludeAddressRequired: z.boolean().optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (query) =>
      NORTH_AMERICA.has(query.country) ||
      (query.areaCode === undefined &&
        query.inRegion === undefined &&
        query.inPostalCode === undefined),
  );
export type AvailableNumberQuery = z.input<typeof searchQuery>;

const KIND_PATHS = { local: 'Local', toll_free: 'TollFree', mobile: 'Mobile' } as const;

const availableBody = z.object({
  phone_number: z.string().regex(E164),
  friendly_name: optionalText(64),
  iso_country: z.string().regex(COUNTRY),
  locality: optionalText(128),
  region: optionalText(64),
  postal_code: optionalText(16),
  address_requirements: z.enum(addressRequirements).nullable().optional(),
  beta: z.boolean().nullable().optional(),
  capabilities: capabilitiesBody,
});
const availablePage = z.object({
  available_phone_numbers: z.array(availableBody),
  next_page_uri: z.string().nullable().optional(),
});

export interface AvailableNumber {
  readonly e164: string;
  readonly friendlyName: string;
  readonly isoCountry: string;
  readonly locality: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  /** What Twilio says buying it needs; null when Twilio did not say. Never assumed met. */
  readonly addressRequirements: AddressRequirement | null;
  readonly beta: boolean | null;
  readonly capabilities: readonly NumberCapability[];
}
export type SearchAvailableNumbersResult =
  | {
      readonly outcome: 'ok';
      readonly numbers: readonly AvailableNumber[];
      /** Twilio has more matches than this one page. */
      readonly truncated: boolean;
    }
  | NumberReadFailure;

/** One page of numbers Twilio offers for purchase. Read-only. */
export async function searchAvailableNumbers(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  query: AvailableNumberQuery,
): Promise<SearchAvailableNumbersResult> {
  const parsed = searchQuery.safeParse(query);
  if (!ACCOUNT_SID.test(credentials.accountSid) || !parsed.success) return invalid;
  const value = parsed.data;
  const pageSize = value.pageSize ?? 20;
  const params = new URLSearchParams();
  if (value.areaCode !== undefined) params.append('AreaCode', String(value.areaCode));
  if (value.contains !== undefined) params.append('Contains', value.contains);
  if (value.inRegion !== undefined) params.append('InRegion', value.inRegion);
  if (value.inPostalCode !== undefined) params.append('InPostalCode', value.inPostalCode);
  if (value.inLocality !== undefined) params.append('InLocality', value.inLocality);
  const { voice, sms, mms } = value.capabilities ?? {};
  if (voice !== undefined) params.append('VoiceEnabled', String(voice));
  if (sms !== undefined) params.append('SmsEnabled', String(sms));
  if (mms !== undefined) params.append('MmsEnabled', String(mms));
  if (value.excludeAddressRequired !== undefined)
    params.append('ExcludeAllAddressRequired', String(value.excludeAddressRequired));
  params.append('PageSize', String(pageSize));
  const response = await exchange(
    transport,
    credentials,
    'api',
    'GET',
    `${accountPath(credentials)}/AvailablePhoneNumbers/${value.country}/${KIND_PATHS[value.kind]}.json?${params.toString()}`,
  );
  if (response?.status !== 200) return readFailure(response);
  const page = availablePage.safeParse(json(response.body));
  // More than asked for, or a number from another country, is not an answer to this search.
  if (
    !page.success ||
    page.data.available_phone_numbers.length > pageSize ||
    page.data.available_phone_numbers.some((each) => each.iso_country !== value.country)
  )
    return unavailable;
  return {
    outcome: 'ok',
    truncated: (page.data.next_page_uri ?? '') !== '',
    numbers: page.data.available_phone_numbers.map((each) => ({
      e164: each.phone_number,
      friendlyName: each.friendly_name ?? '',
      isoCountry: each.iso_country,
      locality: each.locality ?? null,
      region: each.region ?? null,
      postalCode: each.postal_code ?? null,
      addressRequirements: each.address_requirements ?? null,
      beta: each.beta ?? null,
      capabilities: capabilityList(each.capabilities),
    })),
  };
}

// --- Country pricing -----------------------------------------------------------------------

// Prices stay decimal strings, as Twilio sends them: never floats, never hardcoded.
const decimal = z.string().regex(/^[0-9]{1,6}(\.[0-9]{1,6})?$/);
const pricingBody = z.object({
  country: optionalText(128),
  iso_country: z.string().regex(COUNTRY),
  price_unit: z.string().regex(/^[A-Za-z]{3}$/),
  phone_number_prices: z
    .array(z.object({ number_type: text(64), base_price: decimal, current_price: decimal }))
    .max(50)
    .nullable()
    .optional(),
});
export type PricedNumberType = 'local' | 'mobile' | 'national' | 'toll_free';
const NUMBER_TYPES = new Map<string, PricedNumberType>([
  ['local', 'local'],
  ['mobile', 'mobile'],
  ['national', 'national'],
  ['toll free', 'toll_free'],
]);

export interface NumberPrice {
  readonly numberType: PricedNumberType;
  /** Monthly list price, a decimal string in `currency`. */
  readonly basePrice: string;
  /** What this account pays, after any discount. */
  readonly currentPrice: string;
}
export interface NumberPricing {
  readonly isoCountry: string;
  readonly country: string;
  /** ISO 4217, upper case. */
  readonly currency: string;
  /** Only the documented number types; others are left out. */
  readonly prices: readonly NumberPrice[];
}
export type FetchNumberPricingResult =
  { readonly outcome: 'ok'; readonly pricing: NumberPricing } | NumberReadFailure;

/** FetchPhoneNumberCountry on the pricing host. Read-only. */
export async function fetchNumberPricing(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  country: string,
): Promise<FetchNumberPricingResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid) || !COUNTRY.test(country)) return invalid;
  const response = await exchange(
    transport,
    credentials,
    'pricing',
    'GET',
    `/v1/PhoneNumbers/Countries/${country}`,
  );
  if (response?.status !== 200) return readFailure(response);
  const parsed = pricingBody.safeParse(json(response.body));
  if (!parsed.success || parsed.data.iso_country !== country) return unavailable;
  const prices: NumberPrice[] = [];
  for (const each of parsed.data.phone_number_prices ?? []) {
    const numberType = NUMBER_TYPES.get(each.number_type);
    if (numberType !== undefined)
      prices.push({ numberType, basePrice: each.base_price, currentPrice: each.current_price });
  }
  return {
    outcome: 'ok',
    pricing: {
      isoCountry: country,
      country: parsed.data.country ?? '',
      currency: parsed.data.price_unit.toUpperCase(),
      prices,
    },
  };
}

// --- Owned numbers -------------------------------------------------------------------------

const ownedBody = z.object({
  sid: z.string().regex(NUMBER_SID),
  account_sid: z.string().regex(ACCOUNT_SID),
  phone_number: z.string().regex(E164),
  friendly_name: optionalText(255),
  capabilities: capabilitiesBody,
  address_requirements: z.enum(addressRequirements).nullable().optional(),
  address_sid: z
    .string()
    .regex(/^AD[0-9a-fA-F]{32}$/)
    .nullable()
    .optional(),
  bundle_sid: z
    .string()
    .regex(/^BU[0-9a-fA-F]{32}$/)
    .nullable()
    .optional(),
});

export interface OwnedNumber {
  /** The IncomingPhoneNumber SID. */
  readonly sid: string;
  readonly e164: string;
  readonly friendlyName: string;
  readonly capabilities: readonly NumberCapability[];
  readonly addressRequirements: AddressRequirement | null;
  readonly addressSid: string | null;
  /** The regulatory bundle the number is attached to; not evidence of approval. */
  readonly bundleSid: string | null;
}

/** An owned number, only when it belongs to this account. */
function ownedFrom(value: unknown, accountSid: string): OwnedNumber | null {
  const parsed = ownedBody.safeParse(value);
  if (!parsed.success || parsed.data.account_sid !== accountSid) return null;
  const number = parsed.data;
  return {
    sid: number.sid,
    e164: number.phone_number,
    friendlyName: number.friendly_name ?? '',
    capabilities: capabilityList(number.capabilities),
    addressRequirements: number.address_requirements ?? null,
    addressSid: number.address_sid ?? null,
    bundleSid: number.bundle_sid ?? null,
  };
}

const purchaseInput = z.strictObject({
  /** The exact number chosen from a search. An area code alone is never bought. */
  e164: z.string().regex(E164),
  friendlyName: name.optional(),
  voiceUrl: httpsUrl.optional(),
  smsUrl: httpsUrl.optional(),
  addressSid: z
    .string()
    .regex(/^AD[0-9a-fA-F]{32}$/)
    .optional(),
  bundleSid: z
    .string()
    .regex(/^BU[0-9a-fA-F]{32}$/)
    .optional(),
});
export type PurchaseNumberInput = z.input<typeof purchaseInput>;
export type PurchaseNumberResult =
  { readonly outcome: 'accepted'; readonly number: OwnedNumber } | NumberRejected | NumberUnknown;

/**
 * CreateIncomingPhoneNumber, once: a paid action with no idempotency key. On `unknown`, use
 * findOwnedNumber before anything else; never buy again on the strength of an unknown.
 */
export async function purchaseNumber(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  input: PurchaseNumberInput,
): Promise<PurchaseNumberResult> {
  const parsed = purchaseInput.safeParse(input);
  if (!ACCOUNT_SID.test(credentials.accountSid) || !parsed.success) return invalid;
  const value = parsed.data;
  const form = new URLSearchParams([['PhoneNumber', value.e164]]);
  if (value.friendlyName !== undefined) form.append('FriendlyName', value.friendlyName);
  if (value.voiceUrl !== undefined) {
    form.append('VoiceUrl', value.voiceUrl);
    form.append('VoiceMethod', 'POST');
  }
  if (value.smsUrl !== undefined) {
    form.append('SmsUrl', value.smsUrl);
    form.append('SmsMethod', 'POST');
  }
  if (value.addressSid !== undefined) form.append('AddressSid', value.addressSid);
  if (value.bundleSid !== undefined) form.append('BundleSid', value.bundleSid);
  const response = await exchange(
    transport,
    credentials,
    'api',
    'POST',
    `${accountPath(credentials)}/IncomingPhoneNumbers.json`,
    form,
  );
  if (!isSuccess(response)) return writeFailure(response);
  const number = ownedFrom(json(response.body), credentials.accountSid);
  // A success about another account or another number proves nothing either way.
  if (number?.e164 !== value.e164) return unreadable;
  return { outcome: 'accepted', number };
}

const ownedPage = z.object({
  incoming_phone_numbers: z.array(z.unknown()).max(50),
  next_page_uri: z.string().nullable().optional(),
});
export type FindOwnedNumberResult =
  | { readonly outcome: 'found'; readonly number: OwnedNumber }
  /** The whole answer was read and this account does not own the number. */
  | { readonly outcome: 'absent' }
  | NumberReadFailure;

/** Whether this account owns an exact number: how an unknown purchase is reconciled. */
export async function findOwnedNumber(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  e164: string,
): Promise<FindOwnedNumberResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid) || !E164.test(e164)) return invalid;
  const params = new URLSearchParams([
    ['PhoneNumber', e164],
    ['PageSize', '50'],
  ]);
  const response = await exchange(
    transport,
    credentials,
    'api',
    'GET',
    `${accountPath(credentials)}/IncomingPhoneNumbers.json?${params.toString()}`,
  );
  if (response?.status !== 200) return readFailure(response);
  const page = ownedPage.safeParse(json(response.body));
  if (!page.success) return unavailable;
  const numbers = page.data.incoming_phone_numbers.map((each) =>
    ownedFrom(each, credentials.accountSid),
  );
  // Twilio's PhoneNumber filter is a pattern, so only an exact match counts.
  const matches = numbers.filter((each) => each?.e164 === e164);
  const [match] = matches;
  if (numbers.includes(null) || matches.length > 1) return unavailable;
  if (match !== undefined && match !== null) return { outcome: 'found', number: match };
  return (page.data.next_page_uri ?? '') === '' ? { outcome: 'absent' } : unavailable;
}

export type FetchOwnedNumberResult =
  | { readonly outcome: 'ok'; readonly number: OwnedNumber }
  | { readonly outcome: 'not_found' }
  | NumberReadFailure;

/** FetchIncomingPhoneNumber, bound to this account and SID. */
export async function fetchOwnedNumber(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  sid: string,
): Promise<FetchOwnedNumberResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid) || !NUMBER_SID.test(sid)) return invalid;
  const response = await exchange(
    transport,
    credentials,
    'api',
    'GET',
    `${accountPath(credentials)}/IncomingPhoneNumbers/${sid}.json`,
  );
  if (response?.status === 404) return { outcome: 'not_found' };
  if (response?.status !== 200) return readFailure(response);
  const number = ownedFrom(json(response.body), credentials.accountSid);
  return number?.sid === sid ? { outcome: 'ok', number } : unavailable;
}

export type ReleaseNumberResult =
  | { readonly outcome: 'released' }
  /** Twilio has no such number on this account: already released, or never ours. */
  | { readonly outcome: 'not_found' }
  | NumberRejected
  | NumberUnknown;

/**
 * DeleteIncomingPhoneNumber, once. Release is not reliably reversible: Twilio may give the
 * number to another customer. On `unknown`, read with fetchOwnedNumber before anything else.
 */
export async function releaseNumber(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  sid: string,
): Promise<ReleaseNumberResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid) || !NUMBER_SID.test(sid)) return invalid;
  const response = await exchange(
    transport,
    credentials,
    'api',
    'DELETE',
    `${accountPath(credentials)}/IncomingPhoneNumbers/${sid}.json`,
  );
  if (response?.status === 204) return { outcome: 'released' };
  if (response?.status === 404) return { outcome: 'not_found' };
  return writeFailure(response);
}

const configureVoiceInput = z.strictObject({
  voiceUrl: httpsUrl,
  statusCallback: httpsUrl,
});
export type ConfigureNumberVoiceInput = z.input<typeof configureVoiceInput>;

export type ConfigureNumberVoiceResult =
  { readonly outcome: 'accepted' } | NumberRejected | NumberUnknown;

// Updating an owned number is POST /2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers/{PhoneNumberSid}.json
// with form fields VoiceUrl, VoiceMethod, StatusCallback, StatusCallbackMethod.
// Verified in installed twilio@6.1.2 incomingPhoneNumber.js and incomingPhoneNumber.d.ts
// (IncomingPhoneNumberContextUpdateOptions). Docs:
// https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource#update-an-incomingphonenumber-resource
export async function configureNumberVoice(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  sid: string,
  input: ConfigureNumberVoiceInput,
): Promise<ConfigureNumberVoiceResult> {
  const parsed = configureVoiceInput.safeParse(input);
  if (!ACCOUNT_SID.test(credentials.accountSid) || !NUMBER_SID.test(sid) || !parsed.success)
    return invalid;
  const value = parsed.data;
  const form = new URLSearchParams([
    ['VoiceUrl', value.voiceUrl],
    ['VoiceMethod', 'POST'],
    ['StatusCallback', value.statusCallback],
    ['StatusCallbackMethod', 'POST'],
  ]);
  const response = await exchange(
    transport,
    credentials,
    'api',
    'POST',
    `${accountPath(credentials)}/IncomingPhoneNumbers/${sid}.json`,
    form,
  );
  if (!isSuccess(response)) return writeFailure(response);
  return { outcome: 'accepted' };
}

// --- Verified caller IDs -------------------------------------------------------------------

export const CALLER_ID_PAGE_SIZE = 1000;
export const CALLER_ID_PAGE_LIMIT = 20;

const callerIdBody = z.object({
  sid: z.string().regex(NUMBER_SID),
  account_sid: z.string().regex(ACCOUNT_SID),
  phone_number: z.string().regex(E164),
  friendly_name: optionalText(64),
});
const callerIdPage = z.object({
  outgoing_caller_ids: z.array(callerIdBody).max(CALLER_ID_PAGE_SIZE),
  next_page_uri: z.string().nullable().optional(),
});

export interface VerifiedCallerId {
  /** The OutgoingCallerId SID. */
  readonly sid: string;
  readonly e164: string;
  readonly friendlyName: string;
}
export type ListVerifiedCallerIdsResult =
  | {
      readonly outcome: 'ok';
      readonly callerIds: readonly VerifiedCallerId[];
      /** More caller IDs exist than the page limit allowed us to read. */
      readonly truncated: boolean;
    }
  | NumberReadFailure;

/** ListOutgoingCallerId, following next_page_uri only within this account's own list. */
export async function listVerifiedCallerIds(
  transport: NumberTransport,
  credentials: TwilioCredentials,
): Promise<ListVerifiedCallerIdsResult> {
  if (!ACCOUNT_SID.test(credentials.accountSid)) return invalid;
  const base = `${accountPath(credentials)}/OutgoingCallerIds.json`;
  const callerIds = new Map<string, VerifiedCallerId>();
  let path: string | null = `${base}?PageSize=${String(CALLER_ID_PAGE_SIZE)}`;
  for (let page = 0; page < CALLER_ID_PAGE_LIMIT && path !== null; page += 1) {
    const response = await exchange(transport, credentials, 'api', 'GET', path);
    if (response?.status !== 200) return readFailure(response);
    const parsed = callerIdPage.safeParse(json(response.body));
    if (
      !parsed.success ||
      parsed.data.outgoing_caller_ids.some((each) => each.account_sid !== credentials.accountSid)
    )
      return unavailable;
    for (const each of parsed.data.outgoing_caller_ids)
      callerIds.set(each.sid, {
        sid: each.sid,
        e164: each.phone_number,
        friendlyName: each.friendly_name ?? '',
      });
    const next = parsed.data.next_page_uri ?? '';
    if (next !== '' && !(next.startsWith(`${base}?`) && isAllowedNumberRequest('api', 'GET', next)))
      return unavailable;
    path = next === '' ? null : next;
  }
  return { outcome: 'ok', callerIds: [...callerIds.values()], truncated: path !== null };
}

const verificationInput = z.strictObject({
  e164: z.string().regex(E164),
  friendlyName: name.optional(),
  callDelaySeconds: z.number().int().min(0).max(60).optional(),
  extension: z
    .string()
    .regex(/^[0-9]{1,10}$/)
    .optional(),
  /** Receives VerificationStatus and, on success, OutgoingCallerIdSid. */
  statusCallback: httpsUrl.optional(),
});
export type CallerIdVerificationInput = z.input<typeof verificationInput>;

const validationBody = z.object({
  account_sid: z.string().regex(ACCOUNT_SID),
  call_sid: z.string().regex(CALL_SID),
  phone_number: z.string().regex(E164),
  validation_code: z.string().regex(/^[0-9]{6}$/),
});

export interface CallerIdVerification {
  readonly e164: string;
  /** The verification call Twilio placed. */
  readonly callSid: string;
  /** The six digits the person must enter on that call. */
  readonly validationCode: string;
}
export type StartCallerIdVerificationResult =
  /** The call was requested. The caller ID is verified only when the callback says success. */
  | { readonly outcome: 'accepted'; readonly verification: CallerIdVerification }
  | NumberRejected
  | NumberUnknown;

/** CreateValidationRequest, once: it places a phone call, so it is never repeated here. */
export async function startCallerIdVerification(
  transport: NumberTransport,
  credentials: TwilioCredentials,
  input: CallerIdVerificationInput,
): Promise<StartCallerIdVerificationResult> {
  const parsed = verificationInput.safeParse(input);
  if (!ACCOUNT_SID.test(credentials.accountSid) || !parsed.success) return invalid;
  const value = parsed.data;
  const form = new URLSearchParams([['PhoneNumber', value.e164]]);
  if (value.friendlyName !== undefined) form.append('FriendlyName', value.friendlyName);
  if (value.callDelaySeconds !== undefined)
    form.append('CallDelay', String(value.callDelaySeconds));
  if (value.extension !== undefined) form.append('Extension', value.extension);
  if (value.statusCallback !== undefined) {
    form.append('StatusCallback', value.statusCallback);
    form.append('StatusCallbackMethod', 'POST');
  }
  const response = await exchange(
    transport,
    credentials,
    'api',
    'POST',
    `${accountPath(credentials)}/OutgoingCallerIds.json`,
    form,
  );
  if (!isSuccess(response)) return writeFailure(response);
  const answer = validationBody.safeParse(json(response.body));
  if (
    !answer.success ||
    answer.data.account_sid !== credentials.accountSid ||
    answer.data.phone_number !== value.e164
  )
    return unreadable;
  return {
    outcome: 'accepted',
    verification: {
      e164: answer.data.phone_number,
      callSid: answer.data.call_sid,
      validationCode: answer.data.validation_code,
    },
  };
}
