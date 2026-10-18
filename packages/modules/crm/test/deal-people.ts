// What the opportunity tests share: a business with team members (contact-details.ts), a
// pipeline with two stages, and the deal_contact link type every business is seeded with.
import type { TestDatabase } from '@repo/testing';
import { toPublicId } from '@repo/kernel';

import { team, type Team } from './contact-details.js';

export interface DealScene extends Team {
  readonly pipelineId: string;
  readonly stageId: string;
  readonly secondStageId: string;
  /** A new contact's public id. */
  contact(firstName?: string, email?: string): Promise<string>;
  /** The business's events whose type starts with the prefix, oldest first. */
  events(prefix: string): Promise<{ type: string; payload: unknown }[]>;
}

export async function dealScene(database: TestDatabase): Promise<DealScene> {
  const t = await team(database);
  const made = await database.withTenant(t.context, async (sql) => {
    const pipeline = await sql.one<{ id: string }>(
      "insert into crm.pipelines (business_id, name) values ($1, 'Sales') returning id",
      [t.businessId],
    );
    const stage = (name: string, position: number) =>
      sql.one<{ id: string }>(
        `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
         values ($1, $2, $3, $4) returning id`,
        [t.businessId, pipeline.id, name, position],
      );
    const first = await stage('New lead', 0);
    const second = await stage('Proposal', 1);
    await sql.query(
      `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                   label, reverse_label, allows_primary)
       select $1, 'deal_contact', d.id, c.id, 'Contact', 'Deal', true
       from crm.object_types d, crm.object_types c
       where d.business_id = $1 and d.kind = 'deal' and c.business_id = $1 and c.kind = 'contact'
       on conflict do nothing`,
      [t.businessId],
    );
    return { pipeline: pipeline.id, first: first.id, second: second.id };
  });
  return {
    ...t,
    pipelineId: toPublicId('pipeline', made.pipeline),
    stageId: toPublicId('stage', made.first),
    secondStageId: toPublicId('stage', made.second),
    contact: async (firstName = 'Maya', email) =>
      toPublicId(
        'contact',
        (
          await database.fixtures.contact(t.context, {
            firstName,
            ...(email === undefined ? {} : { email }),
          })
        ).id,
      ),
    events: (prefix) =>
      database.as('crm_owner', (sql) =>
        sql.query<{ type: string; payload: unknown }>(
          `select type, payload from events.events
           where business_id = $1 and type like $2 order by recorded_at, id`,
          [t.businessId, `${prefix}%`],
        ),
      ),
  };
}
