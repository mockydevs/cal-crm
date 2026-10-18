// The DNS checks of a mailbox's domains, as messaging.mailbox_check_results records them.
// Points belong to the score.

/** How a check came out (messaging.mailbox_check_results.status). */
export type CheckStatus = 'pass' | 'fail' | 'not_applicable' | 'could_not_check';

/** The checks DNS alone can make (messaging.mailbox_check_results.check_key). */
export type DnsCheckKey = 'spf' | 'dmarc' | 'dmarc_enforcement' | 'mx' | 'reverse_dns';

export type RecordType = 'A' | 'AAAA' | 'MX' | 'TXT' | 'PTR' | 'NS';

export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

/**
 * Answers a DNS query as node:dns's resolve does: TXT as a list of character-string lists,
 * MX as exchanges with priorities, everything else as a list of names or addresses. A name
 * or type with no records rejects with code ENOTFOUND or ENODATA; any other code is a
 * failure to look it up.
 */
export type Resolve = (name: string, type: RecordType) => Promise<unknown>;

/**
 * The exact change that fixes a failing check: a DNS record to publish, or a request for
 * the company that controls something the user can't change themselves.
 */
export type DnsFix =
  | {
      readonly kind: 'record';
      readonly type: 'TXT';
      readonly name: string;
      readonly value: string;
      /** Set when the record is proven to need more than SPF's 10 DNS lookups. */
      readonly exceedsLookupLimit?: true;
    }
  | {
      readonly kind: 'ask';
      /** Only the owner of the IP address (the hosting company) can set its PTR record. */
      readonly who: 'ip_owner';
      readonly ip: string;
      /** A host name that resolves to the IP, proven by a lookup; absent when none is. */
      readonly ptr?: string;
    };

export interface DnsCheckResult {
  readonly key: DnsCheckKey;
  readonly status: CheckStatus;
  /** Why, as a stable code the dashboard words in the reader's language. */
  readonly reason: string;
  /** What the lookups found, as plain JSON for mailbox_check_results.details. */
  readonly found: Readonly<Record<string, unknown>>;
  readonly fix?: DnsFix;
}

export interface DnsCheckInput {
  /** The envelope sender's domain: SPF checks this one. */
  readonly returnPathDomain: string;
  /** The From header's domain: DMARC and MX check this one. */
  readonly fromDomain: string;
  /** The IP the test message was sent from. Absent when only DNS was checked. */
  readonly sendingIp?: string;
  /** The mailbox's SMTP host: offered as the PTR name only if it resolves to sendingIp. */
  readonly smtpHost?: string;
  /**
   * The provider the connector detected (Google, Microsoft, a sending service), never a
   * caller's choice: their servers' reverse DNS isn't the user's to set.
   */
  readonly detectedProvider?: string;
  /** An SPF mechanism the provider context proves is needed, such as include:_spf.google.com. */
  readonly spfAuthorize?: string;
  /** Where DMARC aggregate reports should go, as a mailto: URI, for a new DMARC record. */
  readonly dmarcReportUri?: string;
}
