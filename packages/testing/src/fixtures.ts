// Rows for tests, written by the role that writes them in the product, so they pass the
// same privileges and row-level security checks.
import { randomUUID } from 'node:crypto';

import type { TenantContext } from '@repo/kernel';

import type { Transactions } from './transactions.js';

export interface Fixtures {
  /** An agency, as the installer creates it (crm_owner). */
  agency(values?: { name?: string; slug?: string }): Promise<{ id: string }>;
  /** A user, as sign-up creates them (crm_auth). */
  user(values?: { email?: string; name?: string }): Promise<{ id: string; email: string }>;
  /**
   * A business in the agency, created by agency staff (crm_app), with the built-in object
   * types, and a context for acting in it.
   */
  business(
    agencyId: string,
    values?: { name?: string; slug?: string },
  ): Promise<{ id: string; agencyId: string; context: TenantContext }>;
  /** A contact in the context's business, with a primary email address if one is given. */
  contact(
    context: TenantContext,
    values?: { firstName?: string; lastName?: string; email?: string },
  ): Promise<{ id: string }>;
}

// Names and slugs must be unique, so each default gets its own suffix.
const unique = () => randomUUID().slice(0, 8);

export function databaseFixtures(transactions: Transactions): Fixtures {
  return {
    agency: (values = {}) => {
      const suffix = unique();
      return transactions.as('crm_owner', (sql) =>
        sql.one<{ id: string }>(
          'insert into tenancy.agencies (name, slug) values ($1, $2) returning id',
          [values.name ?? `Agency ${suffix}`, values.slug ?? `agency-${suffix}`],
        ),
      );
    },

    user: (values = {}) => {
      const suffix = unique();
      return transactions.as('crm_auth', (sql) =>
        sql.one<{ id: string; email: string }>(
          'insert into auth.users (email, name) values ($1, $2) returning id, email',
          [values.email ?? `user-${suffix}@example.com`, values.name ?? `User ${suffix}`],
        ),
      );
    },

    business: async (agencyId, values = {}) => {
      const suffix = unique();
      const agencyStaff: TenantContext = {
        agencyId,
        actorKind: 'system',
        correlationId: randomUUID(),
      };
      const { id } = await transactions.withTenant(agencyStaff, (sql) =>
        sql.one<{ id: string }>(
          'insert into tenancy.businesses (agency_id, name, slug) values ($1, $2, $3) returning id',
          [agencyId, values.name ?? `Business ${suffix}`, values.slug ?? `business-${suffix}`],
        ),
      );
      const context: TenantContext = { ...agencyStaff, businessId: id };
      await transactions.withTenant(context, (sql) =>
        sql.query(
          `insert into crm.object_types (business_id, kind, key, singular_label, plural_label)
           values (app.business_id(), 'contact', 'contact', 'Contact', 'Contacts'),
                  (app.business_id(), 'company', 'company', 'Company', 'Companies'),
                  (app.business_id(), 'deal', 'deal', 'Deal', 'Deals')`,
        ),
      );
      return { id, agencyId, context };
    },

    contact: (context, values = {}) =>
      transactions.withTenant(context, async (sql) => {
        const contact = await sql.one<{ id: string }>(
          `with record as (
             insert into crm.records (business_id, kind, object_type_id)
             select app.business_id(), 'contact', id from crm.object_types where kind = 'contact'
             returning id
           )
           insert into crm.contacts
             (business_id, id, first_name, last_name, created_by_kind, created_by_id)
           select app.business_id(), id, $1, $2, app.actor_kind(), app.actor_id() from record
           returning id`,
          [values.firstName ?? 'Test', values.lastName ?? null],
        );
        if (values.email !== undefined) {
          await sql.query(
            `insert into crm.contact_identities
               (business_id, contact_id, kind, value, value_normalized, is_primary)
             values (app.business_id(), $1, 'email', $2, lower($2), true)`,
            [contact.id, values.email],
          );
        }
        return contact;
      }),
  };
}
