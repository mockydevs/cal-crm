import { requireBusiness, type ApiRoute, type Route } from '@repo/commands';
import {
  explainEvent,
  listAudit,
  listRecordActivity,
  listRecordAudit,
  parseInput,
  parseRecordId,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { ForbiddenError, NotFoundError, parsePublicId } from '@repo/kernel';

import { readActivity, readChain, type ActorNames } from './activity.js';
import { readAudit, readRecordAudit, type AuditMembers } from './audit.js';

export interface ActivityOptions {
  /** How to name each kind of actor; the server passes the owning modules' lookups. */
  readonly actorNames: ActorNames;
  /**
   * Who a membership id names, for the audit log's member filter; the server passes the
   * lookup tasks use. Without it the filter knows only "me".
   */
  readonly members?: AuditMembers;
}

/**
 * The routes for a record's activity and "Why?", for its audit log and for the audit log of
 * the whole business. All four only read.
 */
export function activityRoutes({ actorNames, members }: ActivityOptions): readonly ApiRoute[] {
  const listRecordActivityRoute = {
    endpoint: listRecordActivity,
    async run({ invocation, params, query }, { db }) {
      const { context } = invocation;
      requireBusiness(context);
      const { id } = parseInput(listRecordActivity.params, params);
      const { after } = parseInput(listRecordActivity.query, query);
      const record = parseRecordId(id);
      const page =
        record === undefined
          ? undefined
          : await withTenant(db, context, (trx) =>
              readActivity(
                trx,
                context,
                actorNames,
                record,
                after === undefined ? undefined : parsePublicId('event', after),
              ),
            );
      if (page === undefined) {
        throw new NotFoundError('record', id);
      }
      return page;
    },
  } satisfies Route<typeof listRecordActivity>;

  const explainEventRoute = {
    endpoint: explainEvent,
    async run({ invocation, params }, { db }) {
      const { context } = invocation;
      const { id } = parseInput(explainEvent.params, params);
      const eventId = parsePublicId('event', id);
      const chain =
        eventId === undefined
          ? undefined
          : await withTenant(db, context, (trx) => readChain(trx, context, actorNames, eventId));
      if (chain === undefined) {
        throw new NotFoundError('event', id);
      }
      return chain;
    },
  } satisfies Route<typeof explainEvent>;

  // Who ran which command on the record. Unlike the activity, which anyone in the business
  // reads, this needs `audit.read`: it shows the reason someone gave for a change. The
  // permission is checked before the record is looked for, so a refusal says nothing of it.
  const listRecordAuditRoute = {
    endpoint: listRecordAudit,
    async run({ invocation, params, query }, { db }) {
      const { context, permissions } = invocation;
      const businessId = requireBusiness(context);
      if (permissions !== 'all' && !permissions.has('audit.read'))
        throw new ForbiddenError(
          "Your role doesn't allow this: it needs audit.read.",
          'audit.read',
        );
      const { id } = parseInput(listRecordAudit.params, params);
      const { after } = parseInput(listRecordAudit.query, query);
      const record = parseRecordId(id);
      const page =
        record === undefined
          ? undefined
          : await withTenant(db, context, (trx) =>
              readRecordAudit(
                trx,
                { ...context, businessId },
                actorNames,
                record,
                after === undefined ? undefined : parsePublicId('audit_entry', after),
              ),
            );
      if (page === undefined) {
        throw new NotFoundError('record', id);
      }
      return page;
    },
  } satisfies Route<typeof listRecordAudit>;

  // The same log across every record of the business, behind the same permission: it shows
  // nothing of an entry that a record's own log does not.
  const listAuditRoute = {
    endpoint: listAudit,
    async run({ invocation, query }, { db }) {
      const { context, permissions } = invocation;
      const businessId = requireBusiness(context);
      if (permissions !== 'all' && !permissions.has('audit.read'))
        throw new ForbiddenError(
          "Your role doesn't allow this: it needs audit.read.",
          'audit.read',
        );
      const parsed = parseInput(listAudit.query, query);
      return withTenant(db, context, (trx) =>
        readAudit(trx, { ...context, businessId }, actorNames, members, parsed),
      );
    },
  } satisfies Route<typeof listAudit>;

  return [listRecordActivityRoute, explainEventRoute, listRecordAuditRoute, listAuditRoute];
}
