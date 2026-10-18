import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { builtInRoleSeedSql, DEVELOPMENT_AGENCY_ID } from './builtin-roles.ts';

test('seeds every canonical built-in role without replacing existing rows or memberships', () => {
  const sql = builtInRoleSeedSql(DEVELOPMENT_AGENCY_ID);
  for (const role of [
    "('agency', 'owner', 'Owner')",
    "('agency', 'admin', 'Admin')",
    "('agency', 'member', 'Member')",
    "('business', 'owner', 'Owner')",
    "('business', 'admin', 'Admin')",
    "('business', 'member', 'Member')",
    "('business', 'viewer', 'Viewer')",
  ])
    assert(sql.includes(role));
  assert(sql.includes('on conflict on constraint roles_key_unique do nothing'));
  assert(!/\b(update|delete|memberships)\b/i.test(sql));
});

test('uses the actual development agency seeded before the missing-role repair', async () => {
  const seed = await readFile('scripts/dev/seed.sql', 'utf8');
  assert(seed.includes(`values ('${DEVELOPMENT_AGENCY_ID}', 'Bluebird Digital'`));
});

test('rejects an invalid target before composing SQL', () => {
  assert.throws(() => builtInRoleSeedSql("'; drop table tenancy.roles; --"), /agency UUID/);
});
