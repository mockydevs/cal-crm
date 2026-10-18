// The business's country, read for phone numbers written in national form. Its own file so
// field validation can read it without importing the contacts module (which writes fields).
//
// A business that has not given its address still has a country for phone numbers (US
// market first): the one its currency belongs to, then the region its locale names, then
// the United States for a business that trades in US dollars from a time zone in the
// Americas or none at all ('UTC', what a new business starts with). A business with nothing
// that says where it is keeps asking for the country code.
import type { DatabaseTransaction } from '@repo/db';
import { sql } from 'kysely';
import type { CountryCode } from 'libphonenumber-js';

import { phoneCountry } from './phones.js';

/**
 * Currencies that belong to one country's phone plan. The US dollar is not here: it is
 * also Ecuador's, El Salvador's and Panama's, so it counts only with a time zone that
 * agrees (inTheAmericas).
 */
const currencyCountries: Readonly<Record<string, CountryCode>> = {
  AUD: 'AU',
  BRL: 'BR',
  CAD: 'CA',
  GBP: 'GB',
  GHS: 'GH',
  INR: 'IN',
  JPY: 'JP',
  KES: 'KE',
  MXN: 'MX',
  NGN: 'NG',
  NZD: 'NZ',
  RWF: 'RW',
  TZS: 'TZ',
  UGX: 'UG',
  ZAR: 'ZA',
};

/** A time zone of the United States' plan, or none that says anything ('UTC'). */
function inTheAmericas(timeZone: string): boolean {
  return (
    timeZone === 'UTC' ||
    timeZone === 'GMT' ||
    timeZone.startsWith('Etc/') ||
    timeZone.startsWith('America/') ||
    timeZone.startsWith('US/') ||
    timeZone === 'Pacific/Honolulu'
  );
}

/** The region a locale names itself (en-US), never one guessed from a bare language. */
function regionOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region;
  } catch {
    return undefined;
  }
}

export interface BusinessPlace {
  readonly addressCountry: string | null | undefined;
  readonly currency: string;
  readonly locale: string;
  readonly timezone: string;
}

/** The country national-form phone numbers are read in, by the order at the top. */
export function phoneCountryOf(place: BusinessPlace): CountryCode | undefined {
  return (
    phoneCountry(place.addressCountry) ??
    currencyCountries[place.currency] ??
    phoneCountry(regionOf(place.locale)) ??
    (place.currency === 'USD' && inTheAmericas(place.timezone) ? 'US' : undefined)
  );
}

/** The business's country, for phone numbers written in national form. */
export async function countryOf(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<CountryCode | undefined> {
  const business = await trx
    .selectFrom('tenancy.businesses')
    .select(['currency', 'locale', 'timezone'])
    .select(sql<string | null>`address ->> 'country'`.as('country'))
    .where('id', '=', businessId)
    .executeTakeFirst();
  if (business === undefined) return undefined;
  return phoneCountryOf({
    addressCountry: business.country,
    currency: business.currency,
    locale: business.locale,
    timezone: business.timezone,
  });
}
