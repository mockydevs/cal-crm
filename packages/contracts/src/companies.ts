import * as z from 'zod';
import { actor } from './activity.js';
import { defineEndpoint } from './endpoints.js';
import { publicId } from './ids.js';
import { timestamp } from './timestamps.js';
import { fieldQueryShape, refineFieldQuery } from './field-query.js';

const name = z.string().trim().min(1, { error: 'Enter a company name.' }).max(200);
// Plain ASCII hostnames match the current company schema. URLs and IP addresses are not domains.
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
    error: 'Enter a domain such as acme.example, without a URL or path.',
  })
  .nullable();
const phone = z.string().trim().min(1).max(40).nullable();

// What the Companies list shows beside the name.
// GoHighLevel's specification names these fields and gives none a limit or a format
// (apps/businesses.json, CreateBusinessDto), so the limits are the ones this codebase
// already holds for the same things. Each may be left out, null or blank: all three are
// "none", and a blank is stored as null.
const text = (most: number) =>
  z
    .string()
    .trim()
    .max(most, { error: `Use at most ${String(most)} characters.` })
    .nullable();

/** An email address as a contact's is checked: trimmed and lower-cased first. */
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, { error: 'Use at most 320 characters.' })
  .refine((value) => value === '' || z.regexes.email.test(value), {
    error: 'Enter an email address, such as hello@acme.example.',
  })
  .nullable()
  .meta({ examples: ['hello@acme.example'] });

// A host of two or more labels, with or without http:// or https:// before it, then an
// optional port, path, query and fragment without spaces.
const webAddress =
  /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
/**
 * Whether this is a web address a browser can open over http or https. People write one
 * without its scheme (GoHighLevel's own example is www.xyz.com), so none is asked for; any
 * other scheme, sign-in details in the address and a host without a dot are refused.
 */
export function isWebAddress(value: string): boolean {
  return webAddress.test(value);
}
const website = z
  .string()
  .trim()
  .max(2000, { error: 'Use at most 2000 characters.' })
  .refine((value) => value === '' || isWebAddress(value), {
    error: 'Enter a web address, such as www.acme.example.',
  })
  .nullable()
  .meta({
    description: 'As written, with or without http:// or https://.',
    examples: ['www.acme.example'],
  });

// The form the business's own address keeps a country in (business-profile.ts), in either
// case as typed.
const country = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(?:[A-Z]{2})?$/, { error: 'Use a two-letter country code, such as KE.' })
  .nullable()
  .meta({ description: 'A two-letter country code.', examples: ['KE'] });

const details = {
  email: email.optional(),
  website: website.optional(),
  address: text(200).optional().meta({ description: 'The street address, on one line.' }),
  city: text(200).optional(),
  state: text(200).optional(),
  postalCode: text(32).optional(),
  country: country.optional(),
  description: text(5000).optional(),
};

export const createCompanyInput = z
  .strictObject({
    name,
    domain: domain.default(null),
    phone: phone.default(null),
    ...details,
  })
  .meta({ id: 'CreateCompanyInput' });
export type CreateCompanyInput = z.input<typeof createCompanyInput>;
export const updateCompanyInput = z
  .strictObject({
    name: name.optional(),
    domain: domain.optional(),
    phone: phone.optional(),
    ...details,
  })
  .meta({ id: 'UpdateCompanyInput' });
export type UpdateCompanyInput = z.input<typeof updateCompanyInput>;

export const company = z
  .looseObject({
    id: publicId('company'),
    name: z.string(),
    domain: z.string().nullable(),
    phone: z.string().nullable(),
    // The server always sends the nine below. They are optional here so that a company
    // written before they existed (a screen's stand-in) still reads.
    email: z.string().nullable().optional(),
    website: z.string().nullable().optional().meta({
      description: 'As it was written, with or without http:// or https://.',
    }),
    address: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    country: z.string().nullable().optional().meta({ description: 'A two-letter country code.' }),
    description: z.string().nullable().optional(),
    createdBy: actor.optional().meta({
      description:
        "Who or what made the company. Left out of a contact's company links, which do not name it.",
    }),
    trashedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    canManage: z.boolean(),
  })
  .meta({ id: 'Company' });
export type Company = z.infer<typeof company>;
export const COMPANY_PAGE_SIZE = 50;
/** The most companies a page may hold. */
export const MAX_COMPANY_PAGE_SIZE = 100;
/** The orders of the Companies list: one for each column of its table. */
export const companySorts = [
  'name',
  'phone',
  'email',
  'website',
  'address',
  'state',
  'city',
  'description',
  'postalCode',
  'country',
  'created',
  'updated',
  'createdBy',
] as const;
export type CompanySort = (typeof companySorts)[number];
export type CompanySortDirection = 'asc' | 'desc';
/** Which way an order runs when none is given: the two times newest first, the rest from A. */
export const companySortDirection = (
  sort: CompanySort,
  direction?: CompanySortDirection,
): CompanySortDirection => direction ?? (sort === 'created' || sort === 'updated' ? 'desc' : 'asc');
export const listCompaniesQuery = z
  .strictObject({
    q: z.string().trim().max(200).optional().meta({
      description:
        'Any part of the name, email address, phone number, website or domain, in either case.',
    }),
    after: publicId('company').optional().meta({
      description:
        "Start after this company: the previous page's next, with the same sort and direction.",
    }),
    limit: z.coerce
      .number()
      .int()
      .min(1, { error: 'Ask for at least 1 company.' })
      .max(MAX_COMPANY_PAGE_SIZE, {
        error: `Ask for at most ${String(MAX_COMPANY_PAGE_SIZE)} companies.`,
      })
      .optional()
      .meta({
        description: `How many companies a page holds. Left out, ${String(COMPANY_PAGE_SIZE)}.`,
      }),
    sort: z.enum(companySorts).optional().meta({
      description:
        'A column to order by. Left out, newest first. Text runs without regard to case; companies without a value come last both ways; createdBy is by the name shown.',
    }),
    direction: z.enum(['asc', 'desc']).optional().meta({
      description:
        'Which way the sort runs. Left out: newest first for created and updated, from A for the rest.',
    }),
    ...fieldQueryShape,
  })
  .superRefine((input, context) => {
    refineFieldQuery(input, context);
    // One order applies to a list: a column, or a custom field with its own direction.
    if (input.sort !== undefined && input.sortField !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['sortField'],
        message: 'Sort by a column or by a field, not both.',
      });
    if (input.direction !== undefined && input.sort === undefined)
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message:
          input.sortField === undefined
            ? 'A direction belongs to a sort: choose one.'
            : 'A field has its own direction: use fieldOrder.',
      });
  })
  .meta({ id: 'ListCompaniesQuery' });
export const companyList = z
  .looseObject({
    items: z.array(company),
    next: publicId('company').nullable(),
    total: z.int().min(0).optional().meta({
      description:
        'How many companies match the search and the field filter, the same on every page. The server always sends it.',
    }),
    canManage: z.boolean(),
  })
  .meta({ id: 'CompanyList' });
export type CompanyList = z.infer<typeof companyList>;
export const listCompanies = defineEndpoint({
  operationId: 'listCompanies',
  method: 'get',
  path: '/companies',
  group: 'Companies',
  summary: 'Find live companies, newest first',
  query: listCompaniesQuery,
  response: {
    status: 200,
    description:
      'A page of companies (50 unless a limit is given) with how many match, in the order asked for.',
    schema: companyList,
  },
});
export const companyIdInput = z.strictObject({ id: publicId('company') });
export const updateCompanyCommandInput = updateCompanyInput.extend(companyIdInput.shape);
export const createCompany = defineEndpoint({
  operationId: 'createCompany',
  method: 'post',
  path: '/companies',
  group: 'Companies',
  summary: 'Create a company',
  body: createCompanyInput,
  response: { status: 201, description: 'The new company.', schema: company },
});
export const getCompany = defineEndpoint({
  operationId: 'getCompany',
  method: 'get',
  path: '/companies/{id}',
  group: 'Companies',
  summary: 'Read a company, including one in trash',
  params: companyIdInput,
  response: { status: 200, description: 'The company.', schema: company },
});
export const updateCompany = defineEndpoint({
  operationId: 'updateCompany',
  method: 'patch',
  path: '/companies/{id}',
  group: 'Companies',
  summary: 'Change a company',
  params: companyIdInput,
  body: updateCompanyInput,
  response: { status: 200, description: 'The changed company.', schema: company },
});
export const trashCompany = defineEndpoint({
  operationId: 'trashCompany',
  method: 'delete',
  path: '/companies/{id}',
  group: 'Companies',
  summary: 'Move a company to trash',
  params: companyIdInput,
  response: {
    status: 200,
    description: 'The company, retaining its links in trash.',
    schema: company,
  },
});
export const restoreCompany = defineEndpoint({
  operationId: 'restoreCompany',
  method: 'post',
  path: '/companies/{id}/restore',
  group: 'Companies',
  summary: 'Restore a company when its domain is available',
  params: companyIdInput,
  response: { status: 200, description: 'The restored company.', schema: company },
});
export const contactCompany = z
  .looseObject({ company, isPrimary: z.boolean(), linkedAt: timestamp })
  .meta({ id: 'ContactCompany' });
export const contactCompanies = z
  .looseObject({
    items: z.array(contactCompany),
    next: publicId('company').nullable(),
    canManage: z.boolean(),
  })
  .meta({ id: 'ContactCompanies' });
export type ContactCompanies = z.infer<typeof contactCompanies>;
export const companyLinkParams = z.strictObject({
  id: publicId('contact'),
  companyId: publicId('company'),
});
export const companyLinkInput = z
  .strictObject({
    primary: z.boolean().optional().meta({
      description: 'Omit to preserve an existing link’s primary state; new links default to false.',
    }),
  })
  .meta({ id: 'CompanyLinkInput' });
export const companyLinkCommandInput = companyLinkInput.extend(companyLinkParams.shape);
export const getContactCompanies = defineEndpoint({
  operationId: 'getContactCompanies',
  method: 'get',
  path: '/contacts/{id}/companies',
  group: 'Companies',
  summary: 'Read a contact’s company links, including retained trash',
  params: z.strictObject({ id: publicId('contact') }),
  query: z.strictObject({ after: publicId('company').optional() }),
  response: {
    status: 200,
    description: 'Company links, newest company first, 50 per page.',
    schema: contactCompanies,
  },
});
export const linkContactCompany = defineEndpoint({
  operationId: 'linkContactCompany',
  method: 'put',
  path: '/contacts/{id}/companies/{companyId}',
  group: 'Companies',
  summary: 'Link a company and optionally make it the contact’s primary company',
  params: companyLinkParams,
  body: companyLinkInput,
  response: {
    status: 200,
    description: 'The saved company link. Repeating it is idempotent.',
    schema: contactCompany,
  },
});
export const unlinkContactCompany = defineEndpoint({
  operationId: 'unlinkContactCompany',
  method: 'delete',
  path: '/contacts/{id}/companies/{companyId}',
  group: 'Companies',
  summary: 'Remove a company link',
  params: companyLinkParams,
  response: { status: 204, description: 'The link was removed, or was already absent.' },
});
