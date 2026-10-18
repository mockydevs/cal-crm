import { runCommand, type ApiRoute, type Route } from '@repo/commands';
import {
  createRelation,
  createRelationInput,
  deleteRelation,
  getRecordAssociations,
  parseInput,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { toPublicId } from '@repo/kernel';

import { linkContactCompanyCommand, unlinkContactCompanyCommand } from '../companies/links.js';
import { linkDealContactCommand } from '../deals/contact-links.js';
import { DEAL_CONTACT_LINK } from '../deals/link-type.js';
import { requireRecord } from '../records/access.js';
import { readRecordAssociations } from './panel.js';
import {
  CONTACT_COMPANY_LINK,
  orient,
  presentRelation,
  relationBetween,
  relationRow,
  relationType,
  removeRelationCommands,
  writeRelationCommands,
} from './relations.js';

/** A record's Associations panel, and relating two records under an association. */
export const relationRoutes: readonly ApiRoute[] = [
  {
    endpoint: getRecordAssociations,
    run: ({ invocation, params, query }, { db }) => {
      const { id } = parseInput(getRecordAssociations.params, params);
      const parsed = parseInput(getRecordAssociations.query, query);
      return withTenant(db, invocation.context, (trx) =>
        readRecordAssociations(trx, invocation, id, parsed),
      );
    },
  } satisfies Route<typeof getRecordAssociations>,
  {
    endpoint: createRelation,
    // The command a relation from a custom record runs; the routes below pick the one the
    // association and its from record name.
    command: writeRelationCommands.custom,
    async run({ invocation, body }, services) {
      const input = parseInput(createRelationInput, body);
      // Which association, and which record is its from: read first, so another business's
      // association or record is not found before anything is written.
      const plan = await withTenant(services.db, invocation.context, async (trx) => {
        const type = await relationType(trx, input.associationId);
        const first = await requireRecord(trx, input.firstRecordId);
        const second = await requireRecord(trx, input.secondRecordId);
        const sides = orient(
          type,
          { id: input.firstRecordId, objectTypeId: first.objectTypeId },
          { id: input.secondRecordId, objectTypeId: second.objectTypeId },
        );
        const [from, to] = sides.fromId === input.firstRecordId ? [first, second] : [second, first];
        return { type, ...sides, from, to };
      });
      const primary = input.primary === undefined ? {} : { primary: input.primary };
      const builtIn = async (): Promise<boolean> => {
        if (!plan.type.is_system) return false;
        if (plan.type.key === DEAL_CONTACT_LINK)
          await runCommand(
            services,
            linkDealContactCommand,
            { id: plan.fromId, contactId: plan.toId, ...primary },
            invocation,
          );
        else if (plan.type.key === CONTACT_COMPANY_LINK)
          await runCommand(
            services,
            linkContactCompanyCommand,
            { id: plan.fromId, companyId: plan.toId, ...primary },
            invocation,
          );
        else return false;
        return true;
      };
      if (await builtIn())
        return withTenant(services.db, invocation.context, async (trx) =>
          presentRelation(
            trx,
            (
              await relationBetween(
                trx,
                plan.type.id,
                plan.from.id,
                plan.to.id,
              ).executeTakeFirstOrThrow()
            ).id,
          ),
        );
      return runCommand(
        services,
        writeRelationCommands[plan.from.kind],
        {
          associationId: input.associationId,
          fromRecordId: plan.fromId,
          toRecordId: plan.toId,
          ...primary,
        },
        invocation,
      );
    },
  } satisfies Route<typeof createRelation>,
  {
    endpoint: deleteRelation,
    command: removeRelationCommands.custom,
    async run({ invocation, params }, services) {
      const input = parseInput(deleteRelation.params, params);
      const relation = await withTenant(services.db, invocation.context, async (trx) => {
        const row = await relationRow(trx, input.relationId);
        const type = await relationType(trx, toPublicId('link_type', row.link_type_id));
        return { ...row, type };
      });
      if (relation.type.is_system && relation.type.key === CONTACT_COMPANY_LINK)
        await runCommand(
          services,
          unlinkContactCompanyCommand,
          {
            id: toPublicId('contact', relation.from_record_id),
            companyId: toPublicId('company', relation.to_record_id),
          },
          invocation,
        );
      else
        await runCommand(services, removeRelationCommands[relation.from_kind], input, invocation);
      return undefined;
    },
  } satisfies Route<typeof deleteRelation>,
];
