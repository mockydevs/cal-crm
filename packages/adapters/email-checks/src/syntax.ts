import { domainToASCII } from 'node:url';

/** Why an address can't be one: each is a breach of RFC 5321, RFC 5322 or RFC 3696. */
export type SyntaxProblem =
  | 'empty'
  | 'no_at'
  | 'bad_local_part'
  | 'local_too_long'
  | 'bad_domain'
  | 'single_label_domain'
  | 'numeric_top_level_domain'
  | 'address_too_long';

/** Forms the RFCs allow that this check doesn't read, so it says nothing about them. */
export type UnsupportedSyntax = 'quoted_local_part' | 'non_ascii_local_part' | 'address_literal';

export type SyntaxCheck =
  | {
      readonly kind: 'ok';
      /** The local part as given: RFC 5321 2.4 says only its own server may fold its case. */
      readonly local: string;
      /** The domain in lower-case ASCII, an internationalized one as its A-labels. */
      readonly domain: string;
      readonly address: string;
    }
  | { readonly kind: 'invalid'; readonly problem: SyntaxProblem }
  | { readonly kind: 'unsupported'; readonly problem: UnsupportedSyntax };

// RFC 5321 4.1.2 Dot-string: atoms of RFC 5322 3.2.3 atext joined by single dots.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const DOT_STRING = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*$`);
// A host name label (RFC 1035 2.3.1, RFC 1123 2.1): letters, digits and inner hyphens.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NON_ASCII = /\P{ASCII}/u;
// ASCII other than letters, digits, dots and hyphens. The URL parser would otherwise
// decode a percent escape or accept an underscore.
const BAD_DOMAIN_ASCII = /[\p{ASCII}--[A-Za-z0-9.\-]]/v;

/**
 * Whether an address is well formed, read as the subset of RFC 5321 that mail is sent to
 * in practice: a dot-atom local part of at most 64 octets (4.5.3.1.1) at a host name of
 * two or more labels whose top-level label isn't all digits (RFC 3696 2), at most 254
 * octets in all (RFC 3696 erratum 1690). An internationalized domain is converted to
 * ASCII first (IDNA, through the WHATWG URL rules Node implements).
 *
 * Quoted local parts, non-ASCII local parts (SMTPUTF8, RFC 6531) and address literals are
 * valid but rare; they come back as unsupported, never as invalid, because refusing them
 * would refuse real addresses.
 */
export function checkSyntax(input: string): SyntaxCheck {
  const text = input.trim();
  if (text === '') return invalid('empty');
  const at = text.lastIndexOf('@');
  if (at === -1) return invalid('no_at');
  const local = text.slice(0, at);
  const given = text.slice(at + 1);
  if (local.startsWith('"')) return { kind: 'unsupported', problem: 'quoted_local_part' };
  if (given.startsWith('[')) return { kind: 'unsupported', problem: 'address_literal' };
  if (NON_ASCII.test(local)) return { kind: 'unsupported', problem: 'non_ascii_local_part' };
  if (!DOT_STRING.test(local)) return invalid('bad_local_part');
  if (local.length > 64) return invalid('local_too_long');
  if (given === '' || BAD_DOMAIN_ASCII.test(given)) return invalid('bad_domain');
  const domain = domainToASCII(given);
  const labels = domain.split('.');
  if (domain === '' || domain.length > 253 || !labels.every((label) => LABEL.test(label)))
    return invalid('bad_domain');
  if (labels.length < 2) return invalid('single_label_domain');
  if (/^\d+$/.test(labels[labels.length - 1] ?? '')) return invalid('numeric_top_level_domain');
  const address = `${local}@${domain}`;
  if (address.length > 254) return invalid('address_too_long');
  return { kind: 'ok', local, domain, address };
}

function invalid(problem: SyntaxProblem): SyntaxCheck {
  return { kind: 'invalid', problem };
}
