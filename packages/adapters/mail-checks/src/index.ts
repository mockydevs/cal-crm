export type {
  CheckStatus,
  DnsCheckInput,
  DnsCheckKey,
  DnsCheckResult,
  DnsFix,
  MxRecord,
  RecordType,
  Resolve,
} from './types.js';
export { checkDns } from './check-dns.js';
export type { DnsBudget, Lookup } from './dns.js';
export { budgetedResolver, lookupAddresses, lookupMx } from './dns.js';
export { checkMessage } from './message.js';
export type { MessageCheckInput, MessageCheckResult } from './message-types.js';
export { MessageEvidenceError } from './message-types.js';
