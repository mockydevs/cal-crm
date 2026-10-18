// What the bell costs to read. In a database of its own, so the planner's statistics are
// only this file's: one person with twenty thousand read notifications and three unread
// ones, under row-level security, as the API reads them.
import { withTenant } from '@repo/db';
import { describe, expect, it } from 'vitest';

import { place, suite, type Place } from '../test/fixtures.js';
import { countUnread, readNotifications } from './index.js';

const s = suite();

const READ = 20_000;
const UNREAD = 3;

async function busy(): Promise<Place> {
  const at = await place(s);
  await s.database.as('crm_owner', async (sql) => {
    await sql.query(
      `insert into notifications.notifications
         (agency_id, business_id, user_id, kind, source_key, actor_kind, subject_kind, read_at)
       select $1, $2, $3, 'ai.limit_reached', 'plan:' || n, 'system', 'ai_settings',
              case when n > $4::int then now() end
       from generate_series(1, $5::int) n`,
      [at.agencyId, at.businessId, at.owner.id, UNREAD, READ + UNREAD],
    );
    await sql.query('analyze notifications.notifications');
  });
  return at;
}

interface Node {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly 'Relation Name'?: string;
  readonly 'Actual Rows'?: number;
  readonly 'Rows Removed by Filter'?: number;
  readonly Plans?: readonly Node[];
}

/** Every node of a plan, the plan's own first. */
const nodesOf = (node: Node): Node[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

/** The plan PostgreSQL runs for a query as this person, having run it. */
async function planOf(at: Place, query: string): Promise<Node[]> {
  const rows = await s.database.withTenant(at.owner.context, (sql) =>
    sql.query<{ 'QUERY PLAN': readonly { Plan: Node }[] }>(
      `explain (analyze, format json, costs off, timing off, buffers off) ${query}`,
      [at.owner.id, at.businessId],
    ),
  );
  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (plan === undefined) throw new Error('No plan was returned.');
  return nodesOf(plan);
}

/** How many notification rows a plan read, kept or not. */
const rowsRead = (nodes: readonly Node[]) =>
  nodes
    .filter((node) => node['Relation Name'] === 'notifications')
    .reduce(
      (total, node) => total + (node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0),
      0,
    );

describe('reading the bell with twenty thousand read notifications behind it', () => {
  it('counts the unread ones through their own index, touching none that were read', async () => {
    const at = await busy();
    const nodes = await planOf(
      at,
      `select id from notifications.notifications
       where user_id = $1 and business_id = $2 and read_at is null limit 100`,
    );
    const scans = nodes.filter((node) => node['Relation Name'] === 'notifications');
    expect(scans.map((node) => node['Index Name'])).toEqual(['notifications_unread_idx']);
    expect(rowsRead(nodes)).toBe(UNREAD);
    expect(
      await withTenant(s.db, at.owner.context, (trx) => countUnread(trx, at.owner.invocation)),
    ).toEqual({ unread: UNREAD, more: false });
  });

  it('lists a page through the list’s index in order, reading a page and not the rest', async () => {
    const at = await busy();
    const nodes = await planOf(
      at,
      `select * from notifications.notifications
       where user_id = $1 and business_id = $2 order by id desc limit 26`,
    );
    const scans = nodes.filter((node) => node['Relation Name'] === 'notifications');
    expect(scans.map((node) => node['Index Name'])).toEqual(['notifications_list_idx']);
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort');
    expect(rowsRead(nodes)).toBe(26);
    const page = await withTenant(s.db, at.owner.context, (trx) =>
      readNotifications(trx, at.owner.invocation, { state: 'all' }, { actorNames: {} }),
    );
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).not.toBeNull();
  });
});
