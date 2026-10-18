// What every business starts with in the CRM: contacts, companies and deals, how they link,
// a sales pipeline, and the CRM's settings. business.create runs it in the new business's
// transaction, with the tenant context set to that business.
import type { DatabaseTransaction } from '@repo/db';

const objectTypes = {
  contact: { kind: 'contact', key: 'contact', singular_label: 'Contact', plural_label: 'Contacts' },
  company: {
    kind: 'company',
    key: 'company',
    singular_label: 'Company',
    plural_label: 'Companies',
  },
  deal: { kind: 'deal', key: 'deal', singular_label: 'Deal', plural_label: 'Deals' },
} as const;

type ObjectKey = keyof typeof objectTypes;

// Each says what the "to" record is to the "from" one, and back. A primary link marks the
// one that matters most, such as a deal's main contact.
const linkTypes: readonly {
  key: string;
  from: ObjectKey;
  to: ObjectKey;
  label: string;
  reverse_label: string;
  description: string;
}[] = [
  {
    key: 'deal_contact',
    from: 'deal',
    to: 'contact',
    label: 'Contact',
    reverse_label: 'Deal',
    description: "The people a deal is with. The primary one is the deal's main contact.",
  },
  {
    key: 'contact_company',
    from: 'contact',
    to: 'company',
    label: 'Company',
    reverse_label: 'Person',
    description: 'Where someone works. The primary one is their main company.',
  },
  {
    key: 'deal_company',
    from: 'deal',
    to: 'company',
    label: 'Company',
    reverse_label: 'Deal',
    description: 'The companies a deal is with. The primary one is the customer.',
  },
];

// The assistant reads each description to decide when a deal belongs in the stage. Won and
// lost are a deal's status, not stages.
const stages: readonly { name: string; description: string; winProbability: string }[] = [
  {
    name: 'New lead',
    description: 'Just came in. Nobody has spoken to them yet.',
    winProbability: '0.1',
  },
  {
    name: 'Contacted',
    description: "We've spoken to them, and they're interested.",
    winProbability: '0.2',
  },
  {
    name: 'Proposal sent',
    description: 'They have our quote or proposal.',
    winProbability: '0.5',
  },
  {
    name: 'Negotiating',
    description: "We're agreeing on price and terms.",
    winProbability: '0.75',
  },
];

/** Seeds a new business's CRM: its object types, link types, sales pipeline and settings. */
export async function seedBusinessDefaults(
  trx: DatabaseTransaction,
  businessId: string,
): Promise<void> {
  const objectType = async (key: ObjectKey): Promise<string> =>
    (
      await trx
        .insertInto('crm.object_types')
        .values({ ...objectTypes[key], business_id: businessId })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const ids: Record<ObjectKey, string> = {
    contact: await objectType('contact'),
    company: await objectType('company'),
    deal: await objectType('deal'),
  };
  await trx
    .insertInto('crm.link_types')
    .values(
      linkTypes.map((link) => ({
        business_id: businessId,
        key: link.key,
        from_object_type_id: ids[link.from],
        to_object_type_id: ids[link.to],
        label: link.label,
        reverse_label: link.reverse_label,
        description: link.description,
        allows_primary: true,
        // The product's own: code reads them by key, so only their labels may change.
        is_system: true,
      })),
    )
    .execute();
  const pipeline = await trx
    .insertInto('crm.pipelines')
    .values({
      business_id: businessId,
      name: 'Sales',
      description: 'From a new lead to a signed deal.',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('crm.pipeline_stages')
    .values(
      stages.map((stage, position) => ({
        business_id: businessId,
        pipeline_id: pipeline.id,
        name: stage.name,
        description: stage.description,
        position,
        win_probability: stage.winProbability,
      })),
    )
    .execute();
  await trx.insertInto('crm.settings').values({ business_id: businessId }).execute();
}
