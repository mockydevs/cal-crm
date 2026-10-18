import type { TenantContext } from '@repo/kernel';

import type { Role } from './postgres.js';

/** Runs SQL inside a test's transaction. */
export interface Sql {
  /** The rows the statement returns. */
  query<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[]>;
  /** The one row the statement returns; anything else is an error. */
  one<Row extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row>;
}

export interface Transactions {
  /**
   * Runs the work in one transaction as crm_app, with the tenant context set first, as
   * the API and the worker do. The transaction commits when the work succeeds.
   */
  withTenant<T>(context: TenantContext, work: (sql: Sql) => Promise<T>): Promise<T>;
  /** Runs the work in one transaction as a role, with no tenant context. */
  as<T>(role: Role, work: (sql: Sql) => Promise<T>): Promise<T>;
}
