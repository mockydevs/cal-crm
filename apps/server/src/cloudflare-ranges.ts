// Cloudflare's addresses, for TRUST_PROXY's `cloudflare` name (docs/HOSTING.md 13.4).
//
// Cloudflare calls https://www.cloudflare.com/ips/ "the definitive source"; the same lists
// are at https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6 and
// https://api.cloudflare.com/client/v4/ips. Verbatim copies of the two text lists are kept
// in test/cloudflare-ips-v4.txt and test/cloudflare-ips-v6.txt, and cloudflare-ranges.test.ts
// fails when this list and those copies differ.
//
// To refresh: `node scripts/cloudflare-ips.mjs` compares the live lists with the copies and
// exits 1 when they differ; `--write` replaces the copies. Then change this list until the
// test passes, and release. Cloudflare adds a range to its lists "before being put into
// production" (https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/).

/** The day the lists were last compared with Cloudflare's. */
export const CLOUDFLARE_RANGES_CHECKED = '2026-10-14';

export const CLOUDFLARE_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
