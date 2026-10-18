import { mkdir, writeFile } from 'node:fs/promises';
import {
  capacityProfile,
  renderHttpScenario,
  type CapacityProfileInput,
} from './capacity-profile.js';

// Preparation emits scenarios and assumptions; it neither starts load nor creates users.
const directory = new URL('../capacity-preparation/', import.meta.url);
await mkdir(directory, { recursive: true });
const origin = process.argv[2] ?? 'http://127.0.0.1:3000';
const environment = process.argv[3] ?? 'local';
if (environment !== 'local' && environment !== 'isolated-staging')
  throw new Error('Choose local or isolated-staging.');
const plans = [10, 20, 50].map((staffPercent) => {
  const profile: CapacityProfileInput = {
    users: 1_000_000,
    staffPercent,
    staffReadsPerMinute: 6,
    publicReadsPerMinute: 2,
    publicCacheHitPercent: 90,
    zones: 3,
  };
  return { assumptions: profile, estimate: capacityProfile(profile) };
});
for (const plan of plans) {
  const script = renderHttpScenario({
    profile: plan.assumptions,
    origin,
    environment,
    fixtureFile: './capacity-fixtures.json',
    duration: '30m',
  });
  await writeFile(new URL(`http-${String(plan.assumptions.staffPercent)}.js`, directory), script);
}
await writeFile(
  new URL('planning-estimates.json', directory),
  `${JSON.stringify(plans, null, 2)}\n`,
);
process.stdout.write('Prepared HTTP scenarios and planning estimates. No load test was run.\n');
