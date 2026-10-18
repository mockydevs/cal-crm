import { resolve as nodeResolve } from 'node:dns/promises';
import { dkimVerify } from 'mailauth/lib/dkim/verify.js';
import type { DKIMVerifyResult } from 'mailauth';
import { budgetedResolver, codeOf, dnsError, readTxtRecords } from './dns.js';
import {
  MessageEvidenceError,
  type MessageCheckInput,
  type MessageCheckResult,
} from './message-types.js';
import type { Resolve } from './types.js';
import { messageAlignment } from './message-alignment.js';

// RFC5321 section2.4: domain names are case-insensitive; local parts are not.
function canonicalAuthor(address: string): string {
  const at = address.lastIndexOf('@');
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`;
}

function headerValues(verified: DKIMVerifyResult, key: string): string[] {
  return (verified.headers?.parsed ?? [])
    .filter((header) => header.key === key)
    .map((header) => {
      const line = header.line.toString('utf8').replace(/\r?\n[ \t]+/g, ' ');
      return line.slice(line.indexOf(':') + 1).trim();
    });
}

/** RFC8058 sections3.1/4: one of each field, one HTTPS URI and the single POST pair. */
function validUnsubscribe(verified: DKIMVerifyResult): boolean {
  const links = headerValues(verified, 'list-unsubscribe');
  const post = headerValues(verified, 'list-unsubscribe-post');
  if (links.length !== 1 || post.length !== 1 || post[0] !== 'List-Unsubscribe=One-Click')
    return false;
  const value = links[0] ?? '';
  if (!/^\s*<[^<>\s]+>\s*(?:,\s*<[^<>\s]+>\s*)*$/.test(value)) return false;
  let https = 0;
  for (const item of value.matchAll(/<([^<>]+)>/g)) {
    try {
      const uri = new URL(item[1] ?? '');
      if (uri.protocol === 'http:') return false;
      if (uri.protocol === 'https:') {
        if (uri.hostname === '' || uri.username !== '' || uri.password !== '') return false;
        https += 1;
      }
    } catch {
      return false;
    }
  }
  return https === 1;
}

/** RFC6376 verification uses maintained mailauth7.1.1, strict mode (also RFC8301/8463). */
export async function checkMessage(
  input: MessageCheckInput,
  resolve: Resolve = nodeResolve,
): Promise<readonly MessageCheckResult[]> {
  if (input.source.length > 512 * 1024) throw new MessageEvidenceError('too_large');
  let headerEnd = input.source.indexOf('\r\n\r\n');
  if (headerEnd < 0) headerEnd = input.source.indexOf('\n\n');
  if (headerEnd < 0) throw new MessageEvidenceError('malformed_message');
  if (headerEnd > 64 * 1024) throw new MessageEvidenceError('too_large');
  const headerBlock = input.source.subarray(0, headerEnd).toString('utf8');
  // Match the vendor parser's accepted field-name folds before allocating verifiers.
  if ([...headerBlock.matchAll(/^DKIM-Signature[ \t\r\n]*:/gim)].length > 10)
    throw new MessageEvidenceError('too_many_signatures');
  const bounded = budgetedResolver(resolve, { maxQueries: 100, timeoutMs: 10_000 });
  const dnsFailure = { seen: false };
  const resolver: Resolve = async (name, type) => {
    try {
      const answer = await bounded(name, type);
      if (type === 'TXT' && readTxtRecords(answer) === undefined) throw dnsError('EBADRESP', name);
      return answer;
    } catch (error) {
      if (codeOf(error) !== 'ENOTFOUND' && codeOf(error) !== 'ENODATA') dnsFailure.seen = true;
      throw error;
    }
  };
  const verified = await dkimVerify(input.source, {
    strict: true,
    resolver: resolver as NonNullable<NonNullable<Parameters<typeof dkimVerify>[1]>['resolver']>,
  }).catch(() => {
    throw new MessageEvidenceError('verification');
  });
  const ids = headerValues(verified, 'message-id');
  if (
    verified.fromFields !== 1 ||
    verified.headerFrom.length !== 1 ||
    canonicalAuthor(verified.headerFrom[0] ?? '') !== canonicalAuthor(input.expectedFrom) ||
    ids.length !== 1 ||
    ids[0] !== input.expectedMessageId
  )
    throw new MessageEvidenceError('unexpected_message');
  const signed = headerValues(verified, 'dkim-signature').length > 0;
  const passing = verified.results.filter(
    (result) =>
      result.status.result === 'pass' &&
      (result.status.underSized ?? 0) === 0 &&
      result.signatureTimeValid !== false,
  );
  const unsignedBody = verified.results.some(
    (result) => result.status.result === 'pass' && (result.status.underSized ?? 0) > 0,
  );
  const covered = passing.some((result) => {
    const fields = result.signingHeaders?.keys
      .toLowerCase()
      .split(':')
      .map((key) => key.trim());
    return (
      fields?.includes('list-unsubscribe') === true && fields.includes('list-unsubscribe-post')
    );
  });
  const validHeaders = validUnsubscribe(verified);
  return [
    {
      key: 'dkim',
      status:
        passing.length > 0
          ? 'pass'
          : dnsFailure.seen
            ? 'could_not_check'
            : signed
              ? 'fail'
              : 'could_not_check',
      reason:
        passing.length > 0
          ? 'signature_verified'
          : dnsFailure.seen
            ? 'dns_error'
            : unsignedBody
              ? 'unsigned_body'
              : signed
                ? 'signature_invalid'
                : 'unsigned_local_copy',
      found: {},
    },
    {
      key: 'unsubscribe',
      status: input.campaign ? (covered && validHeaders ? 'pass' : 'fail') : 'not_applicable',
      reason: input.campaign
        ? !validHeaders
          ? 'invalid_headers'
          : covered
            ? 'headers_signed'
            : 'headers_not_signed'
        : 'not_campaign_mail',
      found: {},
    },
    await messageAlignment(verified, passing, resolver),
    {
      key: 'encryption',
      status: input.smtpTls && input.imapTls ? 'could_not_check' : 'fail',
      reason:
        input.smtpTls && input.imapTls ? 'receiving_hop_not_observed' : 'connection_not_encrypted',
      found: { smtpTls: input.smtpTls, imapTls: input.imapTls, selfCopy: true },
    },
  ];
}
