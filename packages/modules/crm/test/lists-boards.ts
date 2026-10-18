// Shared set-up for the lists and boards tests: a business to work in, the module's routes
// called as the server calls them, events written as the modules that own them write them,
// and deals in bulk.
import { randomUUID } from 'node:crypto';

import {
  allowEveryone,
  defineCommand,
  runCommand,
  type Invocation,
  type Services,
} from '@repo/commands';
import { connectDatabase, type Database } from '@repo/db';
import { parsePublicId, toPublicId } from '@repo/kernel';
import { testDatabase, type DatabaseServer, type TestDatabase } from '@repo/testing';
import * as z from 'zod';

import { createCrmRoutes } from '../src/index.js';

export interface World {
  readonly database: TestDatabase;
  readonly db: Database;
  readonly services: Services;
  close(): Promise<void>;
  /** Someone acting in a new business: every permission unless told otherwise. */
  inBusiness(options?: {
    readonly permissions?: Invocation['permissions'];
    readonly agencyId?: string;
  }): Promise<Invocation>;
  /** Calls one of the module's routes, as the server would. */
  call(
    operationId: string,
    invocation: Invocation,
    request?: {
      readonly params?: Record<string, string>;
      readonly query?: Record<string, string>;
      readonly body?: unknown;
    },
  ): Promise<unknown>;
  /** A contact, by the module's own command; its public id. */
  contact(invocation: Invocation, firstName: string): Promise<string>;
  /**
   * Something that happened to a contact, written through the command layer as its module
   * writes it: an event, and its entry on the contact's timeline. Gives the event's id.
   */
  happen(
    invocation: Invocation,
    contactId: string,
    type: string,
    payload?: Record<string, unknown>,
  ): Promise<string>;
  /** A pipeline with these stages, in order; their public ids. */
  pipeline(
    invocation: Invocation,
    stages: readonly string[],
  ): Promise<{ readonly pipelineId: string; readonly stageIds: readonly string[] }>;
}

// An event with a contact among its records, as message.received, form.submitted and
// appointment.booked are emitted by the modules that own them.
const happenCommand = defineCommand({
  name: 'test.happen',
  permission: 'contacts.manage',
  input: z.strictObject({
    contactId: z.string(),
    type: z.string(),
    payload: z.record(z.string(), z.unknown()),
  }),
  handle: (_trx, input, command) =>
    command.emit({
      type: input.type,
      subject: { kind: 'message', id: randomUUID() },
      records: [parsePublicId('contact', input.contactId) ?? ''],
      payload: input.payload,
    }),
});

export async function lists(server: DatabaseServer): Promise<World> {
  const database = await testDatabase(server);
  const db = connectDatabase({
    connectionString: database.url('crm_app'),
    onConnectionError: () => undefined,
  });
  const services: Services = { db, authorize: allowEveryone };
  const routes = createCrmRoutes();
  // Async, so a route that refuses its input before it starts rejects like any other.
  const call: World['call'] = async (operationId, invocation, request = {}) => {
    const route = routes.find((each) => each.endpoint.operationId === operationId);
    if (route === undefined) throw new Error(`Missing ${operationId}`);
    return route.run(
      {
        invocation,
        params: request.params ?? {},
        query: request.query ?? {},
        body: request.body,
      },
      services,
    );
  };
  return {
    database,
    db,
    services,
    call,
    async close() {
      await db.destroy();
      await database.close();
    },
    async inBusiness(options = {}) {
      const agencyId = options.agencyId ?? (await database.fixtures.agency()).id;
      const business = await database.fixtures.business(agencyId);
      // The links seedBusinessDefaults gives every business, which the fixture leaves out.
      await database.withTenant(business.context, (sql) =>
        sql.query(
          `insert into crm.link_types (business_id, key, from_object_type_id, to_object_type_id,
                                       label, reverse_label, allows_primary)
           select app.business_id(), link.key, origin.id, target.id, link.label, link.reverse_label, true
           from (values ('contact_company', 'contact', 'company', 'Company', 'Person'),
                        ('deal_contact', 'deal', 'contact', 'Contacts', 'Deals'))
                  as link (key, origin, target, label, reverse_label)
           join crm.object_types origin on origin.kind = link.origin
           join crm.object_types target on target.kind = link.target`,
        ),
      );
      return {
        context: { ...business.context, actorKind: 'system', correlationId: randomUUID() },
        permissions: options.permissions ?? 'all',
      };
    },
    async contact(invocation, firstName) {
      const created = z
        .looseObject({ id: z.string() })
        .parse(await call('createContact', invocation, { body: { firstName } }));
      return created.id;
    },
    happen: (invocation, contactId, type, payload = {}) =>
      runCommand(services, happenCommand, { contactId, type, payload }, invocation),
    async pipeline(invocation, stages) {
      return database.withTenant(invocation.context, async (sql) => {
        const created = await sql.one<{ id: string }>(
          `insert into crm.pipelines (business_id, name)
           values (app.business_id(), $1) returning id`,
          [`Sales ${randomUUID().slice(0, 8)}`],
        );
        const stageIds: string[] = [];
        for (const [position, name] of stages.entries()) {
          const stage = await sql.one<{ id: string }>(
            `insert into crm.pipeline_stages (business_id, pipeline_id, name, position)
             values (app.business_id(), $1, $2, $3) returning id`,
            [created.id, name, position],
          );
          stageIds.push(toPublicId('stage', stage.id));
        }
        return { pipelineId: toPublicId('pipeline', created.id), stageIds };
      });
    },
  };
}
