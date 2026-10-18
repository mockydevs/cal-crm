import { resolve as nodeResolve } from 'node:dns/promises';
import { budgetedResolver, type DnsBudget } from './dns.js';
import { checkDmarc } from './dmarc.js';
import { checkMx } from './mx.js';
import { checkReverseDns } from './reverse-dns.js';
import { checkSpf } from './spf.js';
import type { DnsCheckInput, DnsCheckResult, Resolve } from './types.js';

/** Five checks share one deadline/query budget, including nested SPF and DMARC lookups. */
export async function checkDns(
  input: DnsCheckInput,
  resolve: Resolve = nodeResolve,
  budget: DnsBudget = { maxQueries: 100, timeoutMs: 10_000 },
): Promise<readonly DnsCheckResult[]> {
  if (
    !Number.isInteger(budget.maxQueries) ||
    budget.maxQueries < 1 ||
    budget.maxQueries > 1000 ||
    !Number.isInteger(budget.timeoutMs) ||
    budget.timeoutMs < 1 ||
    budget.timeoutMs > 30_000
  )
    throw new RangeError('Invalid DNS check budget.');
  const bounded = budgetedResolver(resolve, budget);
  const [spf, dmarc, mx, reverse] = await Promise.all([
    checkSpf(input, bounded),
    checkDmarc(input, bounded),
    checkMx(input.fromDomain, bounded),
    checkReverseDns(input, bounded),
  ]);
  return [spf, ...dmarc, mx, reverse];
}
