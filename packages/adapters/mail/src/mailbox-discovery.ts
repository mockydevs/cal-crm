import { randomInt } from 'node:crypto';
import type { MxRecord, SrvRecord } from 'node:dns';
import { resolveMx, resolveSrv } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { mailboxDeadline, mailboxTimeout } from './mailbox-network.js';

export interface MailServerSuggestion {
  readonly host: string;
  readonly port: number;
  readonly security: 'tls' | 'starttls';
  readonly source: 'srv' | 'provider' | 'mx';
  readonly requiresConfirmation: boolean;
}

export interface MailboxDiscoveryResult {
  readonly domain: string;
  readonly smtp: MailServerSuggestion | null;
  readonly imap: MailServerSuggestion | null;
  readonly detectedProvider: 'google' | 'microsoft' | null;
  readonly authentication: 'password' | 'app_password_or_oauth' | 'oauth_required';
  readonly warnings: readonly 'dns_unavailable'[];
}

export interface MailboxDiscoveryOptions {
  readonly resolveSrv?: (name: string) => Promise<readonly SrvRecord[]>;
  readonly resolveMx?: (name: string) => Promise<readonly MxRecord[]>;
  readonly timeoutMs?: number;
  /** Uniform integer from zero through the inclusive upper bound (RFC 2782). */
  readonly chooseInteger?: (upperInclusive: number) => number;
}

function hostname(value: string): string | null {
  const name = domainToASCII(value).toLowerCase().replace(/\.$/, '');
  return name.length <= 253 &&
    name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ? name
    : null;
}

function endpoint(
  host: string,
  port: number,
  security: 'tls' | 'starttls',
  source: MailServerSuggestion['source'],
  requiresConfirmation: boolean,
): MailServerSuggestion {
  return { host, port, security, source, requiresConfirmation };
}

function provider(domain: string): {
  smtp: MailServerSuggestion;
  imap: MailServerSuggestion;
  detectedProvider: 'google' | 'microsoft';
  authentication: 'app_password_or_oauth' | 'oauth_required';
} | null {
  if (domain === 'gmail.com') {
    return {
      smtp: endpoint('smtp.gmail.com', 465, 'tls', 'provider', false),
      imap: endpoint('imap.gmail.com', 993, 'tls', 'provider', false),
      detectedProvider: 'google',
      authentication: 'app_password_or_oauth',
    };
  }
  if (['outlook.com', 'hotmail.com', 'live.com'].includes(domain)) {
    return {
      smtp: endpoint('smtp-mail.outlook.com', 587, 'starttls', 'provider', false),
      imap: endpoint('outlook.office365.com', 993, 'tls', 'provider', false),
      detectedProvider: 'microsoft',
      authentication: 'oauth_required',
    };
  }
  return null;
}

interface Candidate {
  readonly host: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
  readonly security: 'tls' | 'starttls';
}

function candidates(records: readonly SrvRecord[], security: Candidate['security']): Candidate[] {
  return records.flatMap((record) => {
    const host = hostname(record.name);
    if (
      host === null ||
      ![record.port, record.priority, record.weight].every(
        (value) => Number.isInteger(value) && value >= 0 && value <= 65_535,
      ) ||
      record.port === 0
    )
      return [];
    return [
      { host, port: record.port, priority: record.priority, weight: record.weight, security },
    ];
  });
}

function select(
  records: readonly Candidate[],
  domain: string,
  choose: (upper: number) => number,
): MailServerSuggestion | null {
  const first = [...records].sort(
    (a, b) =>
      a.priority - b.priority || (a.security === b.security ? 0 : a.security === 'tls' ? -1 : 1),
  )[0];
  if (first === undefined) return null;
  const peers = records
    .filter((item) => item.priority === first.priority && item.security === first.security)
    .sort((a, b) => a.weight - b.weight);
  const total = peers.reduce((sum, item) => sum + item.weight, 0);
  const draw = choose(total);
  if (!Number.isInteger(draw) || draw < 0 || draw > total)
    throw new RangeError('Invalid SRV random selection.');
  let running = 0;
  const selected = peers.find((item) => {
    running += item.weight;
    return running >= draw;
  });
  if (selected === undefined) return null;
  return endpoint(
    selected.host,
    selected.port,
    selected.security,
    'srv',
    selected.host !== domain && !selected.host.endsWith(`.${domain}`),
  );
}

/** Suggestions only. No credentials or connections; MX and off-domain SRV need confirmation. */
export async function discoverMailbox(
  email: string,
  options: MailboxDiscoveryOptions = {},
): Promise<MailboxDiscoveryResult> {
  const at = email.lastIndexOf('@');
  const domain = at > 0 ? hostname(email.slice(at + 1)) : null;
  if (domain === null) throw new TypeError('A mailbox address with a valid domain is required.');
  const timeout = mailboxTimeout(options);
  async function query<T>(
    read: () => Promise<readonly T[]>,
  ): Promise<{ records: readonly T[]; failed: boolean }> {
    try {
      return { records: await mailboxDeadline(read, timeout), failed: false };
    } catch (failure) {
      const absent =
        failure instanceof Error &&
        'code' in failure &&
        (failure.code === 'ENODATA' || failure.code === 'ENOTFOUND');
      return { records: [], failed: !absent };
    }
  }
  const srv = options.resolveSrv ?? resolveSrv;
  const mx = options.resolveMx ?? resolveMx;
  const [submissions, submission, imaps, imap, exchanges] = await Promise.all([
    query(() => srv(`_submissions._tcp.${domain}`)),
    query(() => srv(`_submission._tcp.${domain}`)),
    query(() => srv(`_imaps._tcp.${domain}`)),
    query(() => srv(`_imap._tcp.${domain}`)),
    query(() => mx(domain)),
  ]);
  const known = provider(domain);
  const choose = options.chooseInteger ?? ((upper: number) => randomInt(upper + 1));
  const smtp = select(
    [...candidates(submissions.records, 'tls'), ...candidates(submission.records, 'starttls')],
    domain,
    choose,
  );
  const incoming = select(
    [...candidates(imaps.records, 'tls'), ...candidates(imap.records, 'starttls')],
    domain,
    choose,
  );
  const exchange = [...exchanges.records].sort((a, b) => a.priority - b.priority)[0];
  const mxHost = exchange === undefined ? null : hostname(exchange.exchange);
  const smtpDisabled = [...submissions.records, ...submission.records].some(
    (item) => item.name === '.',
  );
  const imapDisabled = [...imaps.records, ...imap.records].some((item) => item.name === '.');
  return {
    domain,
    smtp:
      smtp ??
      (smtpDisabled
        ? null
        : (known?.smtp ??
          (mxHost === null ? null : endpoint(mxHost, 587, 'starttls', 'mx', true)))),
    imap:
      incoming ??
      (imapDisabled
        ? null
        : (known?.imap ?? (mxHost === null ? null : endpoint(mxHost, 993, 'tls', 'mx', true)))),
    detectedProvider: known?.detectedProvider ?? null,
    authentication: known?.authentication ?? 'password',
    warnings: [submissions, submission, imaps, imap, exchanges].some((item) => item.failed)
      ? ['dns_unavailable']
      : [],
  };
}
