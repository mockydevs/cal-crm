import { assistantPageContext } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { assistantPageItself, pageContextOf, pathInBusiness, recordOf, type Place } from './pages';

const id = (prefix: string): string => `${prefix}_01k8e2wzr0e008000000000001`;
const place = (path: string, rest: Partial<Place> = {}): Place => ({
  path,
  params: {},
  search: {},
  ...rest,
});

describe('pathInBusiness', () => {
  it('is what follows the business in the address', () => {
    expect(pathInBusiness('/b/harbor/settings/forms', 'harbor')).toBe('/settings/forms');
    expect(pathInBusiness('/b/harbor/contacts/', 'harbor')).toBe('/contacts');
  });

  it('is "/" for the Dashboard', () => {
    expect(pathInBusiness('/b/harbor', 'harbor')).toBe('/');
    expect(pathInBusiness('/b/harbor/', 'harbor')).toBe('/');
  });

  it('keeps an address outside the business as it is', () => {
    expect(pathInBusiness('/agency', 'harbor')).toBe('/agency');
  });
});

describe('recordOf', () => {
  it.each([
    ['/contacts/x', { params: { contactId: id('con') } }, 'contact', id('con')],
    ['/contacts/x/edit', { params: { contactId: id('con') } }, 'contact', id('con')],
    ['/contacts/companies/x', { params: { companyId: id('com') } }, 'company', id('com')],
    ['/deals', { search: { deal: id('deal') } }, 'deal', id('deal')],
    ['/deals/pipelines', { search: { pipeline: id('pipe') } }, 'pipeline', id('pipe')],
    ['/inbox', { search: { conversation: id('conv') } }, 'conversation', id('conv')],
    ['/automations', { search: { automation: id('aut') } }, 'automation', id('aut')],
    ['/settings/calendars/x', { params: { calendarId: id('cal') } }, 'calendar', id('cal')],
    ['/settings/forms', { search: { form: id('form') } }, 'form', id('form')],
  ] as const)('reads the record of %s from the address', (path, rest, kind, recordId) => {
    expect(recordOf(place(path, rest))).toEqual({ kind, id: recordId });
  });

  it('names no record on a list', () => {
    expect(recordOf(place('/contacts'))).toBeUndefined();
    expect(recordOf(place('/deals'))).toBeUndefined();
    expect(recordOf(place('/'))).toBeUndefined();
  });

  it('names no record where the address holds something that is not an id', () => {
    expect(recordOf(place('/deals', { search: { deal: 'new' } }))).toBeUndefined();
    expect(recordOf(place('/contacts/new'))).toBeUndefined();
    expect(recordOf(place('/inbox', { search: { conversation: 7 } }))).toBeUndefined();
  });

  it('reads a company before the contact its address is under', () => {
    const both = { params: { companyId: id('com'), contactId: id('con') } };
    expect(recordOf(place('/contacts/companies/x', both))?.kind).toBe('company');
  });
});

describe('pageContextOf', () => {
  it('sends the path and no selection, which the contract accepts', () => {
    const context = pageContextOf(place('/contacts'));
    expect(context).toEqual({ route: '/contacts', selection: [] });
    expect(assistantPageContext.parse(context)).toEqual(context);
  });

  it('sends the record with the path', () => {
    const context = pageContextOf(place('/deals', { search: { deal: id('deal') } }));
    expect(context).toEqual({
      route: '/deals',
      record: { kind: 'deal', id: id('deal') },
      selection: [],
    });
    expect(assistantPageContext.safeParse(context).success).toBe(true);
  });

  it('names the forms pages as the server knows them', () => {
    expect(pageContextOf(place('/settings/forms')).route).toBe('/forms');
    expect(pageContextOf(place('/settings/forms', { search: { form: id('form') } }))).toEqual({
      route: `/forms/${id('form')}`,
      record: { kind: 'form', id: id('form') },
      selection: [],
    });
  });

  it('cuts a path longer than the contract takes', () => {
    const context = pageContextOf(place(`/sites/${'a'.repeat(400)}`));
    expect(context.route).toHaveLength(300);
    expect(assistantPageContext.safeParse(context).success).toBe(true);
  });

  it('has a page for the full-screen view itself', () => {
    expect(assistantPageContext.safeParse(assistantPageItself).success).toBe(true);
  });
});
