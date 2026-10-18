import { builtInRoles } from '../../packages/modules/tenancy/src/agency/install.ts';

export const DEVELOPMENT_AGENCY_ID = '0199a000-0000-7000-8000-000000000001';

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Add missing canonical roles after the fixed development owner rows have been seeded. */
export function builtInRoleSeedSql(agencyId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(agencyId))
    throw new Error('Use an agency UUID.');
  const rows = builtInRoles
    .map(({ scope, key, name }) => `(${literal(scope)}, ${literal(key)}, ${literal(name)})`)
    .join(',\n');
  return `insert into tenancy.roles (agency_id, scope, key, name, is_builtin)
select ${literal(agencyId)}::uuid, role.scope, role.key, role.name, true
from (values ${rows}) as role(scope, key, name)
on conflict on constraint roles_key_unique do nothing;`;
}
