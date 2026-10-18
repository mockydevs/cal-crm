// What the two suites that try every endpoint need for Reporting: a saved report added
// directly; an input for each operation that the business's own member could send and have
// accepted; and an example of every command for the permission matrix.
import { BLANK_REPORT_DEFINITION } from '@repo/contracts';
import { toPublicId } from '@repo/kernel';
import type { TestDatabase } from '@repo/testing';
import type { LightMyRequestResponse } from 'fastify';

/** A saved report of the business, at revision 1, by its public id. */
export async function addReport(database: TestDatabase, businessId: string): Promise<string> {
  const row = await database.as('crm_owner', (sql) =>
    sql.one<{ id: string }>(
      `insert into reporting.reports
         (business_id, name, definition, definition_version, created_by_kind)
       values ($1, 'Business B only', $2::jsonb, 1, 'system') returning id`,
      [businessId, JSON.stringify(BLANK_REPORT_DEFINITION)],
    ),
  );
  return toPublicId('report', row.id);
}

const QUERY = { source: 'contacts', measures: ['count'], range: { preset: 'last_30_days' } };

/** What the business's own member could send for each Reporting operation. */
export function reportingInputs(): Readonly<Record<string, { payload?: unknown; query?: string }>> {
  return {
    runReportQuery: { payload: QUERY },
    updateReport: {
      payload: { name: 'Reached from A', definition: BLANK_REPORT_DEFINITION, revision: 1 },
    },
    cloneReport: { payload: { name: 'Reached from A' } },
    deleteReport: { payload: { revision: 1 } },
  };
}

type Call = (
  method: 'POST' | 'PUT' | 'PATCH' | 'GET' | 'DELETE',
  path: string,
  options: { payload: unknown; type?: string; inBusiness: boolean },
) => Promise<LightMyRequestResponse>;

interface Example {
  readonly run: (call: Call, run: number) => Promise<LightMyRequestResponse>;
}

/** An example of every Reporting command, each on a report added for that try. */
export function reportingExamples(
  database: () => TestDatabase,
  business: () => string,
): Readonly<Record<string, Example>> {
  const fresh = (): Promise<string> => addReport(database(), business());
  const here = (payload: unknown) => ({ inBusiness: true, payload });
  const inputs = reportingInputs();
  return {
    'report.create': {
      run: (call, run) => call('POST', '/reports', here({ name: `Matrix ${String(run)}` })),
    },
    'report.update': {
      run: async (call) =>
        call('PUT', `/reports/${await fresh()}`, here(inputs['updateReport']?.payload)),
    },
    'report.clone': {
      run: async (call) => call('POST', `/reports/${await fresh()}/clone`, here({})),
    },
    'report.delete': {
      run: async (call) => call('DELETE', `/reports/${await fresh()}`, here({ revision: 1 })),
    },
  };
}

/** The names of the Reporting commands: reports.manage, which owners and admins have. */
export const REPORTING_COMMANDS: readonly string[] = Object.keys(
  reportingExamples(
    () => {
      throw new Error('Names only.');
    },
    () => '',
  ),
);
