// The business's forms with whether each is published, a draft or archived: read for a
// "Form submitted" trigger's panel, so a draft it names is called by its name
// (automation-trigger-filters.ts). On its own, so the forms' contract is fetched with the
// read and not with the panel.
import { listForms } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import type { FormRecord } from './automation-trigger-filters';

/** As many of the business's forms as are read of each kind: four pages of fifty. */
const FORM_PAGES = 4;

export async function readFormRecords(client: Client): Promise<FormRecord[]> {
  const found: FormRecord[] = [];
  for (const archived of ['false', 'true'] as const) {
    let after: string | undefined;
    for (let page = 0; page < FORM_PAGES; page += 1) {
      const list = await client.request(listForms, {
        query: { limit: 50, archived, ...(after === undefined ? {} : { after }) },
      });
      found.push(
        ...list.items.map((form) => ({ id: form.id, name: form.name, status: form.status })),
      );
      if (list.nextCursor === null) break;
      after = list.nextCursor;
    }
  }
  return found;
}
