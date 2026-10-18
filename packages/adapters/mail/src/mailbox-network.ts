import { lookup } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';

export type MailboxNetworkCode = 'private_address' | 'dns' | 'timeout' | 'invalid_host';

export class MailboxNetworkError extends Error {
  constructor(readonly code: MailboxNetworkCode) {
    super(code);
    this.name = 'MailboxNetworkError';
  }
}

export interface MailboxNetworkOptions {
  /** Trusted install configuration, never taken from a business's request. */
  readonly allowedPrivateHosts?: readonly string[];
  /** DNS boundary, injectable for deterministic resolver tests. */
  readonly resolve?: (host: string) => Promise<readonly string[]>;
  readonly timeoutMs?: number;
}

export async function mailboxDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new MailboxNetworkError('timeout'));
          onTimeout?.();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function mailboxTimeout(options: MailboxNetworkOptions): number {
  const value = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(value) || value < 1 || value > 30_000)
    throw new RangeError('Mailbox timeout must be between 1 and 30000 milliseconds.');
  return value;
}

/** Resolve once, reject every non-public answer, then dial only the checked IP. */
export async function mailboxAddress(
  host: string,
  options: MailboxNetworkOptions,
): Promise<string> {
  const direct = ipaddr.isValid(host);
  const name = direct ? host : domainToASCII(host).toLowerCase().replace(/\.$/, '');
  if (
    !direct &&
    (name.length > 253 ||
      name.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
  )
    throw new MailboxNetworkError('invalid_host');
  const addresses = direct
    ? [host]
    : await mailboxDeadline(
        () =>
          options.resolve?.(name) ??
          lookup(name, { all: true, verbatim: true }).then((items) =>
            items.map((item) => item.address),
          ),
        mailboxTimeout(options),
      ).catch((failure: unknown) => {
        if (failure instanceof MailboxNetworkError) throw failure;
        throw new MailboxNetworkError('dns');
      });
  if (addresses.length === 0 || addresses.some((address) => !ipaddr.isValid(address)))
    throw new MailboxNetworkError('dns');
  const parsed = addresses.map((address) => ipaddr.process(address));
  const allowed = options.allowedPrivateHosts?.some(
    (item) => item.toLowerCase().replace(/\.$/, '') === name,
  );
  if (!allowed && parsed.some((address) => address.range() !== 'unicast'))
    throw new MailboxNetworkError('private_address');
  const selected = parsed[0];
  if (selected === undefined) throw new MailboxNetworkError('dns');
  return selected.toString();
}
