// Checks an install's caching from outside, through whatever CDN is in front
// (docs/HOSTING.md 13.7). Read-only: GET requests with no cookie, no sign-in and no secret.
//
//   node scripts/check-cdn.mjs https://crm.example.com [/s/<key>/<path>]
//
// It asks for a published page twice (when given one), a dashboard file under /assets/ twice,
// an /api/ path twice and the dashboard's HTML twice, prints the cache headers and
// Cloudflare's CF-Cache-Status for each, and says PASS, WARN, FAIL or SKIP for each
// expectation. It exits 1 when anything FAILs. CF-Cache-Status values are Cloudflare's
// (https://developers.cloudflare.com/cache/concepts/cache-responses/).

const [base, pagePath] = process.argv.slice(2);
if (base === undefined || !/^https?:\/\//.test(base)) {
  process.stderr.write('Usage: node scripts/check-cdn.mjs <base-url> [published-page-path]\n');
  process.exit(2);
}
const origin = new URL(base).origin;

/** Kept by the CDN: never on anything signed in or private. */
const KEPT = new Set(['HIT', 'REVALIDATED', 'UPDATING', 'STALE']);
/**
 * What Cloudflare adds to a page when a feature that rewrites HTML is on, as its own pages
 * name them: Email Address Obfuscation's decode script, JavaScript Detections' path, Web
 * Analytics' beacon host, the host Rocket Loader needs, and the /cdn-cgi/ endpoint they share.
 */
const INJECTED = [
  ['email-decode.min.js', 'Email Address Obfuscation'],
  ['/cdn-cgi/challenge-platform/', 'JavaScript Detections (Bot Fight Mode)'],
  ['static.cloudflareinsights.com', 'Web Analytics'],
  ['ajax.cloudflare.com', 'Rocket Loader'],
  ['/cdn-cgi/', 'a Cloudflare feature'],
];

const results = [];
function report(state, check, detail = '') {
  results.push(state);
  process.stdout.write(`  ${state.padEnd(4)}  ${check}${detail === '' ? '' : `  (${detail})`}\n`);
}
const expect = (ok, check, detail) => report(ok ? 'PASS' : 'FAIL', check, detail);

async function get(path, accept) {
  const response = await fetch(new URL(path, origin), {
    redirect: 'manual',
    headers: { accept, 'user-agent': 'crm-check-cdn/1' },
  });
  const body = await response.text();
  const header = (name) => response.headers.get(name) ?? '';
  return {
    status: response.status,
    cacheControl: header('cache-control'),
    cfCacheStatus: header('cf-cache-status').toUpperCase(),
    behindCloudflare: header('cf-ray') !== '',
    header,
    body,
  };
}

function show(label, path, answer) {
  const parts = [
    `${String(answer.status)}`,
    `cache-control: ${answer.cacheControl || '-'}`,
    `cf-cache-status: ${answer.cfCacheStatus || '-'}`,
    `etag: ${answer.header('etag') || '-'}`,
    `age: ${answer.header('age') || '-'}`,
  ];
  process.stdout.write(`\n${label}  ${path}\n  ${parts.join(' | ')}\n`);
}

/** Twice, so a CDN has had the chance to keep the first answer. */
async function twice(label, path, accept) {
  const first = await get(path, accept);
  show(`${label}, first`, path, first);
  const second = await get(path, accept);
  show(`${label}, second`, path, second);
  return [first, second];
}

function neverKept(label, answers) {
  for (const [index, answer] of answers.entries())
    expect(
      !KEPT.has(answer.cfCacheStatus),
      `${label} is not served from the CDN's cache (request ${String(index + 1)})`,
      answer.cfCacheStatus || 'no CF-Cache-Status',
    );
}

process.stdout.write(`Checking ${origin}\n`);

// The dashboard's HTML: never kept, so a release shows on the next load.
const [html, htmlAgain] = await twice('Dashboard HTML', '/', 'text/html');
expect(html.status === 200, 'the dashboard HTML answers 200', String(html.status));
expect(
  /\bno-cache\b/.test(html.cacheControl),
  'the dashboard HTML is sent no-cache',
  html.cacheControl,
);
neverKept('the dashboard HTML', [html, htmlAgain]);
const behindCloudflare = html.behindCloudflare;
report(
  behindCloudflare ? 'PASS' : 'SKIP',
  'the answers come through Cloudflare (CF-Ray)',
  behindCloudflare ? '' : 'no CF-Ray: the record is DNS-only, so CDN expectations are skipped',
);

// A dashboard file: its name carries a hash, so it is kept for a year and never changes.
const asset = /["'](\/assets\/[^"'?#]+\.(?:js|css))["']/.exec(html.body)?.[1];
if (asset === undefined) report('FAIL', 'the dashboard HTML names a file under /assets/');
else {
  const [file, fileAgain] = await twice('Dashboard file', asset, '*/*');
  expect(file.status === 200, 'the file answers 200', String(file.status));
  expect(
    /\bimmutable\b/.test(file.cacheControl) && /\bmax-age=31536000\b/.test(file.cacheControl),
    'the file is sent public for a year, immutable',
    file.cacheControl,
  );
  if (behindCloudflare)
    expect(
      KEPT.has(fileAgain.cfCacheStatus),
      'the CDN serves the file from its cache the second time',
      fileAgain.cfCacheStatus || 'no CF-Cache-Status',
    );
}

// The API: a signed-in person's own data. Asked with no session, so it is refused, and the
// refusal must not be kept either.
const [api, apiAgain] = await twice('API', '/api/v1/me', 'application/json');
expect(/\bno-store\b/.test(api.cacheControl), 'the API is sent no-store', api.cacheControl);
neverKept('the API', [api, apiAgain]);

// A published page: kept and revalidated by the CDN (or kept for SITES_SHARED_CACHE_SECONDS).
if (pagePath === undefined)
  report('SKIP', 'a published page', 'give its path, such as /s/<key>/<path>, to check it');
else {
  const [page, pageAgain] = await twice('Published page', pagePath, 'text/html');
  expect(page.status === 200, 'the page answers 200', String(page.status));
  expect(
    /\bpublic\b/.test(page.cacheControl) && /\bno-transform\b/.test(page.cacheControl),
    'the page is sent public and no-transform',
    page.cacheControl,
  );
  expect(page.header('etag') !== '', 'the page has an ETag', page.header('etag') || 'none');
  for (const [marker, feature] of INJECTED)
    expect(!page.body.includes(marker), `nothing of ${feature} in the page`, marker);
  if (behindCloudflare) {
    const status = pageAgain.cfCacheStatus;
    if (KEPT.has(status)) report('PASS', 'the CDN keeps the page', status);
    else if (status === 'MISS' || status === 'EXPIRED')
      report(
        'WARN',
        'the CDN keeps the page',
        `${status}: correct and never stale, but nothing saved; see HOSTING.md 13.7`,
      );
    else
      report(
        'FAIL',
        'the CDN keeps the page',
        `${status || 'no CF-Cache-Status'}: the Cache Rule for /s/ is missing or below a Bypass`,
      );
  }
}

const failed = results.filter((state) => state === 'FAIL').length;
const warned = results.filter((state) => state === 'WARN').length;
process.stdout.write(
  `\n${String(results.length)} checks: ${String(failed)} failed, ${String(warned)} warned.\n`,
);
process.exit(failed > 0 ? 1 : 0);
