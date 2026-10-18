import type { SiteRedirect } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkedHostname,
  checkedRedirect,
  redirectAddress,
  redirectDraftOf,
  redirectReady,
  redirectRejection,
  REGISTRAR_URL,
} from './domain-rules';

const at = '2026-10-11T09:00:00.000Z';
const domainId = 'sdom_01h455vb4pex5vsknk084sn02q';
const siteId = 'site_01h455vb4pex5vsknk084sn02q';

function redirectOf(rest: Partial<SiteRedirect> = {}): SiteRedirect {
  return {
    id: 'srdr_01h455vb4pex5vsknk084sn02q',
    domainId,
    hostname: 'go.harborlights.example',
    path: '/spring',
    target: { type: 'url', url: 'https://example.com/spring' },
    status: 302,
    revision: 4,
    createdAt: at,
    updatedAt: at,
    ...rest,
  };
}

describe('checkedHostname', () => {
  it('forgives case and surrounding space, as the server does', () => {
    expect(checkedHostname('  WWW.Example.COM ')).toEqual({
      ok: true,
      body: { hostname: 'www.example.com' },
    });
  });

  it("says the server's own words for something that is not a domain name", () => {
    expect(checkedHostname('not a domain')).toEqual({
      ok: false,
      problem: {
        fields: { hostname: 'Enter a domain name, such as www.example.com.' },
        form: undefined,
      },
    });
  });

  it('refuses an address with its scheme or a path', () => {
    expect(checkedHostname('https://example.com').ok).toBe(false);
    expect(checkedHostname('example.com/offer').ok).toBe(false);
  });
});

describe('redirectDraftOf', () => {
  it('starts a new redirect at / on the first domain, permanent, to a web address', () => {
    expect(redirectDraftOf(undefined, domainId)).toEqual({
      domainId,
      path: '/',
      targetType: 'url',
      siteId: '',
      url: '',
      status: '301',
    });
  });

  it('reads a redirect to a web address', () => {
    expect(redirectDraftOf(redirectOf(), 'ignored')).toEqual({
      domainId,
      path: '/spring',
      targetType: 'url',
      siteId: '',
      url: 'https://example.com/spring',
      status: '302',
    });
  });

  it('reads a redirect to a site', () => {
    const draft = redirectDraftOf(
      redirectOf({
        target: { type: 'site', siteId, siteName: 'Spring offer', siteKind: 'funnel' },
        status: 301,
      }),
      'ignored',
    );
    expect(draft).toMatchObject({ targetType: 'site', siteId, url: '', status: '301' });
  });
});

describe('redirectReady', () => {
  const draft = redirectDraftOf(undefined, domainId);

  it('waits for a domain, a path and a target', () => {
    expect(redirectReady(draft)).toBe(false);
    expect(redirectReady({ ...draft, url: 'https://example.com' })).toBe(true);
    expect(redirectReady({ ...draft, url: 'https://example.com', path: ' ' })).toBe(false);
    expect(redirectReady({ ...draft, url: 'https://example.com', domainId: '' })).toBe(false);
    expect(redirectReady({ ...draft, targetType: 'site' })).toBe(false);
    expect(redirectReady({ ...draft, targetType: 'site', siteId })).toBe(true);
  });
});

describe('checkedRedirect', () => {
  const draft = { ...redirectDraftOf(undefined, domainId), path: ' /spring ' };

  it('makes the body of a new redirect to a web address', () => {
    expect(checkedRedirect({ ...draft, url: ' https://example.com/a ' }, undefined)).toEqual({
      ok: true,
      body: {
        domainId,
        path: '/spring',
        target: { type: 'url', url: 'https://example.com/a' },
        status: 301,
      },
    });
  });

  it('makes the body of a change, with the revision and without the domain', () => {
    expect(
      checkedRedirect({ ...draft, targetType: 'site', siteId, url: 'left over', status: '302' }, 4),
    ).toEqual({
      ok: true,
      body: { revision: 4, path: '/spring', target: { type: 'site', siteId }, status: 302 },
    });
  });

  it('puts what the contract refuses under the box that holds it', () => {
    expect(checkedRedirect({ ...draft, path: 'spring', url: 'example.com' }, undefined)).toEqual({
      ok: false,
      problem: {
        fields: {
          path: 'Start the path with / and leave out any ? or #.',
          url: 'Use a web address starting with http:// or https://.',
        },
        form: undefined,
      },
    });
  });
});

describe('redirectRejection', () => {
  it("sorts the server's pointers into the dialog's boxes", () => {
    expect(
      redirectRejection([
        { path: '/path', message: 'This domain already has a redirect at this path.' },
        { path: '/path', message: 'A second reason.' },
        { path: '/target/siteId', message: 'Choose a funnel or website of this business.' },
        { path: '/target/url', message: 'Use a web address.' },
        { path: '/target', message: 'Choose where it goes.' },
        { path: '/domainId', message: 'Choose a domain of this business.' },
        { path: '/status', message: 'Use 301 or 302.' },
        { path: '', message: 'Something about the whole redirect.' },
        { path: '/revision', message: 'Not a box.' },
      ]),
    ).toEqual({
      fields: {
        path: 'This domain already has a redirect at this path.',
        siteId: 'Choose a funnel or website of this business.',
        url: 'Use a web address.',
        targetType: 'Choose where it goes.',
        domainId: 'Choose a domain of this business.',
        status: 'Use 301 or 302.',
      },
      form: 'Something about the whole redirect.',
    });
  });
});

describe('redirectAddress', () => {
  it('is the host name and the path', () => {
    expect(redirectAddress(redirectOf())).toBe('go.harborlights.example/spring');
  });
});

describe('REGISTRAR_URL', () => {
  it("is a registrar's own site, not a purchase inside the product", () => {
    expect(REGISTRAR_URL).toBe('https://www.cloudflare.com/products/registrar/');
  });
});
