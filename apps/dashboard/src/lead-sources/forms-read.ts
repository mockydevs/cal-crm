// The business's forms that take leads now (not archived), by name: what "Check a link"
// offers to check a link against. Read a page at a time, to a bound.
import { listForms } from '@repo/contracts';
import type { Client } from '@repo/sdk';

/** As many forms as are offered: four pages of fifty. */
const FORM_PAGES = 4;

export interface FormChoice {
  readonly id: string;
  readonly name: string;
  readonly draft: boolean;
}

export async function readFormChoices(client: Client): Promise<FormChoice[]> {
  const found: FormChoice[] = [];
  let after: string | undefined;
  for (let page = 0; page < FORM_PAGES; page += 1) {
    const list = await client.request(listForms, {
      query: { limit: 50, archived: 'false', ...(after === undefined ? {} : { after }) },
    });
    found.push(
      ...list.items.map((form) => ({
        id: form.id,
        name: form.name,
        draft: form.status === 'draft',
      })),
    );
    if (list.nextCursor === null) break;
    after = list.nextCursor;
  }
  return found;
}
