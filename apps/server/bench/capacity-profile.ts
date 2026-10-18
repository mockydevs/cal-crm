/** Planning arithmetic, never a substitute for observed concurrent users or throughput. */
export interface CapacityProfileInput {
  readonly users: number;
  readonly staffPercent: number;
  readonly staffReadsPerMinute: number;
  readonly publicReadsPerMinute: number;
  readonly publicCacheHitPercent: number;
  readonly zones: number;
}

function finite(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError('Invalid capacity input.');
}

function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  finite(value, minimum, maximum);
  if (!Number.isSafeInteger(value)) throw new RangeError('Expected a whole capacity count.');
}

export function capacityProfile(input: CapacityProfileInput): {
  readonly measured: false;
  readonly staffUsers: number;
  readonly publicUsers: number;
  readonly realtimeSockets: number;
  readonly nominalHttpReadsPerSecond: number;
  readonly nominalOriginReadsPerSecond: number;
  readonly zoneLossCapacityMultiplier: number;
} {
  integer(input.users, 1);
  integer(input.staffPercent, 0, 100);
  finite(input.staffReadsPerMinute, 0);
  finite(input.publicReadsPerMinute, 0);
  finite(input.publicCacheHitPercent, 0, 100);
  integer(input.zones, 2);
  const staffUsers = Math.floor((input.users * input.staffPercent) / 100);
  const publicUsers = input.users - staffUsers;
  const staffReads = (staffUsers * input.staffReadsPerMinute) / 60;
  const publicReads = (publicUsers * input.publicReadsPerMinute) / 60;
  return {
    measured: false,
    staffUsers,
    publicUsers,
    realtimeSockets: staffUsers,
    nominalHttpReadsPerSecond: staffReads + publicReads,
    nominalOriginReadsPerSecond: staffReads + publicReads * (1 - input.publicCacheHitPercent / 100),
    zoneLossCapacityMultiplier: input.zones / (input.zones - 1),
  };
}

/** Zero-based, half-open ranges. No actor is shared or silently lost at shard boundaries. */
export function shardRange(
  users: number,
  shards: number,
  index: number,
): { readonly start: number; readonly end: number; readonly users: number } {
  integer(users, 1);
  integer(shards, 1, users);
  integer(index, 0, shards - 1);
  const start = Math.floor((users * index) / shards);
  const end = Math.floor((users * (index + 1)) / shards);
  return { start, end, users: end - start };
}

export interface CapacityHttpPlan {
  readonly profile: CapacityProfileInput;
  readonly origin: string;
  readonly environment: 'local' | 'isolated-staging';
  readonly fixtureFile: string;
  readonly duration: string;
}

/** Uses k6's documented constant-VU executor; generated files contain no session secrets. */
export function renderHttpScenario(plan: CapacityHttpPlan): string {
  capacityProfile(plan.profile);
  const origin = new URL(plan.origin);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname);
  if (
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    (plan.environment === 'local'
      ? !local || origin.protocol !== 'http:'
      : origin.protocol !== 'https:')
  )
    throw new Error('Use a loopback local origin or an explicitly isolated HTTPS staging origin.');
  if (!/^[1-9]\d*(?:s|m|h)$/.test(plan.duration) || !plan.fixtureFile.endsWith('.json'))
    throw new Error('Invalid test duration or fixture file.');
  if (
    (plan.profile.staffPercent > 0 && plan.profile.staffReadsPerMinute <= 0) ||
    (plan.profile.staffPercent < 100 && plan.profile.publicReadsPerMinute <= 0)
  )
    throw new Error('Active cohorts need a positive request cadence.');
  return `// Generated capacity HTTP scenario. No capacity claim follows from configuring a target.
import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
const plan = ${JSON.stringify({ ...plan, origin: origin.origin })};
const users = Number(__ENV.CAPACITY_USERS || '10');
const duration = __ENV.CAPACITY_DURATION || plan.duration;
if (!/^[1-9]\\d*(?:s|m|h)$/.test(duration)) throw new Error('Invalid duration.');
if (!Number.isSafeInteger(users) || users < 1 || users > plan.profile.users) throw new Error('Invalid user count.');
if (users > 100 && (plan.environment !== 'isolated-staging' || __ENV.ISOLATED_STAGING !== '1')) throw new Error('Large runs require explicitly isolated staging.');
const needed = Math.floor(users * plan.profile.staffPercent / 100);
const staff = new SharedArray('capacity-staff', () => {
  const fixture = JSON.parse(open(plan.fixtureFile));
  if (!Array.isArray(fixture.staff)) throw new Error('Invalid staff fixture manifest.');
  const ids = new Set(); const cookies = new Set();
  for (const actor of fixture.staff) {
    if (typeof actor.userId !== 'string' || typeof actor.businessId !== 'string' || typeof actor.cookie !== 'string' || actor.cookie.length === 0 || ids.has(actor.userId) || cookies.has(actor.cookie)) throw new Error('Invalid or repeated staff identity.');
    ids.add(actor.userId); cookies.add(actor.cookie);
  }
  return fixture.staff;
});
if (staff.length < needed) throw new Error('Not enough distinct authenticated staff fixtures.');
const pages = new SharedArray('capacity-pages', () => {
  const fixture = JSON.parse(open(plan.fixtureFile));
  if (!Array.isArray(fixture.pages)) throw new Error('Invalid page fixture manifest.');
  for (const path of fixture.pages) if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) throw new Error('Page paths must stay on the test origin.');
  return fixture.pages;
});
if (plan.profile.staffPercent < 100 && pages.length === 0) throw new Error('Supply native published-page paths.');
export const options = {
  discardResponseBodies: true,
  scenarios: { population: { executor: 'constant-vus', vus: users, duration, gracefulStop: '5s' } },
  thresholds: { http_req_failed: ['rate<0.001'], http_req_duration: ['p(95)<500', 'p(99)<1000'], checks: ['rate>0.999'] },
};
export default function () {
  const index = exec.vu.idInTest - 1;
  const before = Math.floor(index * plan.profile.staffPercent / 100);
  const isStaff = Math.floor((index + 1) * plan.profile.staffPercent / 100) > before;
  let response;
  if (isStaff) {
    const actor = staff[before];
    if (!actor) throw new Error('Missing global staff identity for this execution segment.');
    const paths = ['/api/v1/contacts', '/api/v1/pipelines', '/api/v1/calendars'];
    response = http.get(plan.origin + paths[exec.scenario.iterationInTest % paths.length], { redirects: 0, headers: { Cookie: actor.cookie, 'Business-Id': actor.businessId, Origin: plan.origin }, timeout: '10s', tags: { name: 'capacity_crm_read', audience: 'staff' } });
  } else {
    response = http.get(plan.origin + pages[index % pages.length], { redirects: 0, timeout: '10s', tags: { name: 'capacity_public_read', audience: 'public' } });
  }
  check(response, { 'native read succeeds': value => value.status === 200 });
  sleep(60 / (isStaff ? plan.profile.staffReadsPerMinute : plan.profile.publicReadsPerMinute));
}
`;
}
