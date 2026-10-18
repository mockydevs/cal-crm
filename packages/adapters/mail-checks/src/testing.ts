// Test helpers for packages that check mail over DNS: a resolver that answers from fixed
// zones, as node:dns does.
export { fixtureResolver } from './fixture-resolver.js';
export type { FixtureEntry, FixtureResolver, FixtureZone } from './fixture-resolver.js';
