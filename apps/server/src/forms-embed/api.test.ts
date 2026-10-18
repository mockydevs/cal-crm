import { describe, expect, it } from 'vitest';

import {
  createFormApi,
  readChallenge,
  readForm,
  readIssues,
  secureUrl,
  type Fetch,
} from './api.js';

const KEY = 'k'.repeat(32);
const TOKEN = `1790000000000.${'A'.repeat(43)}`;
const shown = {
  title: 'Ask us',
  description: 'We answer within a day.',
  submitLabel: 'Send',
  successMessage: 'Thank you.',
  fields: [
    { key: 'email', type: 'email', label: 'Email', helpText: '', required: true, options: [] },
    {
      key: 'venue',
      type: 'single_choice',
      label: 'Venue',
      helpText: 'Where?',
      required: false,
      options: [{ key: 'garden', label: 'Garden' }],
    },
  ],
  consents: [{ key: 'news', wording: 'Email me news.', required: false }],
  renderToken: TOKEN,
  textLength: 500,
  longTextLength: 5000,
};
const submission = {
  clientSubmissionId: '0198de17-876e-7000-aac7-9bc8ac22900d',
  renderToken: TOKEN,
  values: { email: 'maya@example.test' },
  consents: { news: true },
  trap: '',
  pageUrl: 'https://www.example.com/contact',
};

type Call = Parameters<Fetch>;
function answering(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push([url, init]);
    return Promise.resolve({
      status,
      headers: { get: (name) => headers[name] ?? null },
      json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
    });
  };
  return { api: createFormApi('https://crm.example.test', KEY, fetch), calls };
}

describe('the requests', () => {
  it('reads the form with no cookies, no referrer and no redirect', async () => {
    const { api, calls } = answering(200, shown);
    expect(await api.load()).toEqual({ ok: true, value: shown });
    expect(calls).toEqual([
      [
        `https://crm.example.test/api/v1/public/forms/${KEY}`,
        {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'omit',
          mode: 'cors',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
        },
      ],
    ]);
  });

  it('sends a submission as JSON, with only what the visitor filled in', async () => {
    const { api, calls } = answering(201, { status: 'received' });
    expect(await api.send(submission)).toEqual({ ok: true, value: null });
    expect(calls[0]?.[0]).toBe(`https://crm.example.test/api/v1/public/forms/${KEY}/submissions`);
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(submission),
      credentials: 'omit',
      redirect: 'error',
    });
    expect(Object.keys(calls[0]?.[1].headers ?? {})).toEqual(['accept', 'content-type']);
  });

  it('escapes the key it puts in the address', () => {
    const calls: string[] = [];
    const api = createFormApi('https://crm.example.test', '../admin?x=1#y', (url) => {
      calls.push(url);
      return Promise.reject(new Error('unreachable'));
    });
    void api.load();
    expect(calls).toEqual(['https://crm.example.test/api/v1/public/forms/..%2Fadmin%3Fx%3D1%23y']);
  });
});

describe('the answers', () => {
  it.each([
    [403, 'unavailable'],
    [404, 'unavailable'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [409, 'stale'],
    [429, 'limited'],
    [400, 'invalid'],
    [413, 'invalid'],
    [415, 'invalid'],
    [422, 'invalid'],
  ] as const)('reads status %i as %s', async (status, failure) => {
    const { api } = answering(status, { type: 'about:blank', title: 'No', status });
    expect(await api.send(submission)).toEqual({ ok: false, failure });
    expect(await api.load()).toEqual({ ok: false, failure });
  });

  it('reads no answer at all as the network, and never throws', async () => {
    const api = createFormApi('https://crm.example.test', KEY, () =>
      Promise.reject(new TypeError('Failed to fetch')),
    );
    expect(await api.load()).toEqual({ ok: false, failure: 'network' });
    expect(await api.send(submission)).toEqual({ ok: false, failure: 'network' });
    const thrown = createFormApi('https://crm.example.test', KEY, () => {
      throw new Error('blocked');
    });
    expect(await thrown.load()).toEqual({ ok: false, failure: 'network' });
    // A success whose body is not JSON is no answer either.
    const { api: broken } = answering(200, new SyntaxError('Unexpected token <'));
    expect(await broken.load()).toEqual({ ok: false, failure: 'network' });
  });

  it('waits as long as it is told, when it is told sensibly', async () => {
    const wait = async (header: string | undefined) => {
      const { api } = answering(429, {}, header === undefined ? {} : { 'retry-after': header });
      return api.send(submission);
    };
    expect(await wait('2')).toEqual({ ok: false, failure: 'limited', retryAfterSeconds: 2 });
    expect(await wait('86400')).toEqual({
      ok: false,
      failure: 'limited',
      retryAfterSeconds: 86_400,
    });
    for (const header of [undefined, '0', '-1', '1.5', 'soon', '999999', ''])
      expect(await wait(header)).toEqual({ ok: false, failure: 'limited' });
  });

  it('says which answers were refused, as far as they name a question or a box of the form', async () => {
    const { api } = answering(422, {
      type: 'about:blank',
      title: 'Unprocessable Content',
      status: 422,
      errors: [
        { path: '/values/email', code: 'invalid_email', message: 'Enter an email address.' },
        { path: '/consents/news', code: 'required', message: 'Tick this box to continue.' },
        { path: '', code: 'invalid', message: 'Check your details and try again.' },
        // None of these names a question of a form.
        { path: '/values/Email', code: 'x', message: 'no' },
        { path: '/values/email/extra', code: 'x', message: 'no' },
        { path: '/contact/id', code: 'x', message: 'no' },
        { path: '/values/email', code: 'x' },
        { path: 7, code: 'x', message: 'a problem with the form' },
        'nonsense',
        null,
      ],
    });
    expect(await api.send(submission)).toEqual({
      ok: false,
      failure: 'invalid',
      issues: [
        { on: 'values', key: 'email', message: 'Enter an email address.' },
        { on: 'consents', key: 'news', message: 'Tick this box to continue.' },
        { on: 'form', key: '', message: 'Check your details and try again.' },
        { on: 'form', key: '', message: 'a problem with the form' },
      ],
    });
    for (const body of [null, 'text', [], {}, { errors: 'many' }, { errors: [] }])
      expect(readIssues(body)).toEqual([]);
    // A refusal whose body cannot be read still is one, without saying which answer.
    const { api: unreadable } = answering(422, new SyntaxError('not json'));
    expect(await unreadable.send(submission)).toEqual({ ok: false, failure: 'invalid' });
  });

  it('takes a received submission for exactly that, and nothing else for it', async () => {
    for (const body of [{ status: 'stored' }, {}, null, 'received', ['received']]) {
      const { api } = answering(201, body);
      expect(await api.send(submission)).toEqual({ ok: false, failure: 'unavailable' });
    }
  });
});

describe('a form it is given', () => {
  it('is shown only when it is exactly what the contract describes', () => {
    expect(readForm(shown)).toEqual(shown);
    const [email, venue] = shown.fields;
    for (const change of [
      { title: 7 },
      { description: null },
      { submitLabel: undefined },
      { successMessage: ['Thanks'] },
      { renderToken: 'token' },
      { renderToken: `1790000000000.${'A'.repeat(42)}` },
      { textLength: 0 },
      { textLength: '500' },
      { longTextLength: 1.5 },
      { fields: 'many' },
      { consents: null },
      { fields: [{ ...email, key: 'Email' }] },
      { fields: [{ ...email, key: '__proto__' }] },
      { fields: [{ ...email, type: 'file' }] },
      { fields: [{ ...email, label: 7 }] },
      { fields: [{ ...email, helpText: null }] },
      { fields: [{ ...email, required: 'yes' }] },
      { fields: [{ ...email, options: 'none' }] },
      { fields: [{ ...venue, options: [{ key: 'Garden', label: 'Garden' }] }] },
      { fields: [{ ...venue, options: [{ key: 'garden', label: 7 }] }] },
      { fields: [{ ...venue, options: ['garden'] }] },
      { fields: ['email'] },
      { consents: [{ key: 'news', wording: 7, required: false }] },
      { consents: [{ key: 'news', wording: 'Email me news.', required: 'no' }] },
      { consents: [{ key: 'News', wording: 'Email me news.', required: false }] },
      { consents: ['news'] },
    ])
      expect(readForm({ ...shown, ...change }), JSON.stringify(change)).toBeUndefined();
    for (const whole of [null, undefined, 'form', 7, [], [shown]])
      expect(readForm(whole)).toBeUndefined();
  });

  it('keeps only what it knows of, so nothing else the CRM sent can reach the page', () => {
    const extra = {
      ...shown,
      script: '<script>alert(1)</script>',
      fields: [{ ...shown.fields[0], target: { kind: 'contact' }, onclick: 'alert(1)' }],
      consents: [{ ...shown.consents[0], channel: 'email' }],
    };
    expect(readForm(extra)).toEqual({
      ...shown,
      fields: [shown.fields[0]],
      consents: shown.consents,
    });
  });
});

describe('the newer kinds of question', () => {
  const base = { helpText: '', required: false, options: [] };
  const wider = {
    ...shown,
    redirectUrl: 'https://www.example.com/thanks',
    fields: [
      { ...base, key: 'email', type: 'email', label: 'Email', placeholder: 'you@example.com' },
      { ...base, key: 'about', type: 'content', label: '', text: 'About you', style: 'heading' },
      { ...base, key: 'note', type: 'content', label: '', text: 'Small print', style: 'paragraph' },
      {
        ...base,
        key: 'room',
        type: 'single_choice',
        label: 'Room',
        options: [{ key: 'harbor', label: 'Harbor' }],
        display: 'radio',
      },
      {
        ...base,
        key: 'interests',
        type: 'multi_choice',
        label: 'Interests',
        options: [{ key: 'food', label: 'Food' }],
        display: 'checkboxes',
      },
      { ...base, key: 'site', type: 'url', label: 'Website' },
      { ...base, key: 'stars', type: 'rating', label: 'Rating' },
      { ...base, key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
      {
        ...base,
        key: 'rules',
        type: 'terms',
        label: '',
        required: true,
        text: 'I accept the terms.',
        linkUrl: 'https://www.example.com/terms',
        linkLabel: 'Read them',
      },
    ],
  };

  it('are read with what each needs, and a block of text as a heading or not', () => {
    const read = readForm(wider);
    expect(read?.redirectUrl).toBe('https://www.example.com/thanks');
    expect(read?.fields).toEqual([
      { ...base, key: 'email', type: 'email', label: 'Email', placeholder: 'you@example.com' },
      { ...base, key: 'about', type: 'content', label: '', text: 'About you', heading: true },
      { ...base, key: 'note', type: 'content', label: '', text: 'Small print' },
      {
        ...base,
        key: 'room',
        type: 'single_choice',
        label: 'Room',
        options: [{ key: 'harbor', label: 'Harbor' }],
        display: 'radio',
      },
      {
        ...base,
        key: 'interests',
        type: 'multi_choice',
        label: 'Interests',
        options: [{ key: 'food', label: 'Food' }],
        display: 'checkboxes',
      },
      { ...base, key: 'site', type: 'url', label: 'Website' },
      { ...base, key: 'stars', type: 'rating', label: 'Rating' },
      { ...base, key: 'campaign', type: 'hidden', label: 'Campaign', parameter: 'utm_campaign' },
      {
        ...base,
        key: 'rules',
        type: 'terms',
        label: '',
        required: true,
        text: 'I accept the terms.',
        linkUrl: 'https://www.example.com/terms',
        linkLabel: 'Read them',
      },
    ]);
    // Nothing the contract does not name is kept, whatever arrives.
    const extra = readForm({
      ...wider,
      fields: [{ ...wider.fields[0], defaultValue: 'x', target: { kind: 'none' } }],
    });
    expect(extra?.fields[0]).not.toHaveProperty('defaultValue');
    expect(extra?.fields[0]).not.toHaveProperty('target');
    // A form that sends nobody on has no address to send them to.
    expect(readForm(shown)).not.toHaveProperty('redirectUrl');
  });

  it('are not shown at all when any part of one is not what the contract says', () => {
    const [first] = wider.fields;
    for (const change of [
      { placeholder: 7 },
      { display: 'grid' },
      { display: 7 },
      { parameter: 'not a parameter' },
      { parameter: 'a'.repeat(61) },
      { parameter: 7 },
      { text: ['words'] },
      { style: 'banner' },
      { linkLabel: 7 },
      { linkUrl: 'http://www.example.com/terms' },
      { linkUrl: 'javascript:alert(1)' },
      { linkUrl: 'data:text/html,x' },
      { linkUrl: '/terms' },
      { linkUrl: 7 },
      { linkUrl: `https://www.example.com/${'t'.repeat(2000)}` },
    ])
      expect(
        readForm({ ...wider, fields: [{ ...first, ...change }] }),
        JSON.stringify(change),
      ).toBeUndefined();
    // Somewhere to send the visitor on to is a secure address or nothing is shown.
    for (const redirectUrl of [
      'http://www.example.com/thanks',
      'javascript:alert(1)',
      '//www.example.com/thanks',
      '/thanks',
      '',
      7,
      null,
    ])
      expect(readForm({ ...wider, redirectUrl }), String(redirectUrl)).toBeUndefined();
  });

  it('take only a secure web address as one, by the browser’s own reading of it', () => {
    expect(secureUrl('https://www.example.com/terms?x=1#top')).toBe(
      'https://www.example.com/terms?x=1#top',
    );
    // Given back as the browser read it: what is used is exactly what was checked.
    expect(secureUrl('HTTPS://WWW.Example.com')).toBe('https://www.example.com/');
    expect(secureUrl('  https://www.example.com/a b ')).toBe('https://www.example.com/a%20b');
    for (const bad of [
      'http://www.example.com',
      'javascript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'ftp://example.com',
      'www.example.com',
      '//www.example.com',
      '',
      undefined,
      null,
      7,
      { href: 'https://www.example.com' },
    ])
      expect(secureUrl(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('send several choices as a list of their keys', async () => {
    const { api, calls } = answering(201, { status: 'received' });
    const values = { email: 'maya@example.test', interests: ['food'], rules: true };
    expect(await api.send({ ...submission, values })).toEqual({ ok: true, value: null });
    const [, init] = calls[0] ?? [];
    expect(JSON.parse(init?.body ?? '{}')).toMatchObject({ values });
  });
});

describe('the CRM’s own pages', () => {
  const PREVIEW = `${'P'.repeat(70)}.${'S'.repeat(22)}`;
  function client(options: { preview?: boolean; ownPage?: boolean }, key = KEY) {
    const calls: Call[] = [];
    const fetch: Fetch = (url, init) => {
      calls.push([url, init]);
      return Promise.resolve({
        status: url.endsWith('/submissions') ? 201 : 200,
        headers: { get: () => null },
        json: () => Promise.resolve(url.endsWith('/submissions') ? { status: 'received' } : shown),
      });
    };
    return { api: createFormApi('https://crm.example.test', key, fetch, options), calls };
  }

  it('say they are the CRM’s own with a header, on every request, and a website never does', async () => {
    const own = client({ ownPage: true });
    await own.api.load();
    await own.api.send(submission);
    expect(own.calls.map(([url, init]) => [url, init.headers])).toEqual([
      [
        `https://crm.example.test/api/v1/public/forms/${KEY}`,
        { accept: 'application/json', 'x-crm-form': '1' },
      ],
      [
        `https://crm.example.test/api/v1/public/forms/${KEY}/submissions`,
        { accept: 'application/json', 'content-type': 'application/json', 'x-crm-form': '1' },
      ],
    ]);
    for (const options of [{}, { ownPage: false }, { preview: false }]) {
      const website = client(options);
      await website.api.load();
      expect(website.calls[0]?.[1].headers).toEqual({ accept: 'application/json' });
    }
  });

  it('read and rehearse a draft by its preview link, with nothing else changed', async () => {
    const { api, calls } = client({ preview: true, ownPage: true }, PREVIEW);
    expect(await api.load()).toEqual({ ok: true, value: shown });
    expect(await api.send(submission)).toEqual({ ok: true, value: null });
    expect(calls.map(([url]) => url)).toEqual([
      `https://crm.example.test/api/v1/public/forms/preview/${PREVIEW}`,
      `https://crm.example.test/api/v1/public/forms/preview/${PREVIEW}/submissions`,
    ]);
    for (const [, init] of calls)
      expect(init).toMatchObject({
        credentials: 'omit',
        mode: 'cors',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
  });
});

describe('bot protection', () => {
  const given = {
    kind: 'altcha',
    challenge: {
      parameters: {
        algorithm: 'PBKDF2/SHA-256',
        nonce: 'ab'.repeat(16),
        salt: 'cd'.repeat(16),
        cost: 1000,
        keyLength: 32,
        keyPrefix: 'ef'.repeat(16),
        keySignature: '01'.repeat(32),
        expiresAt: 1_790_003_600,
        data: { render: 'A'.repeat(43) },
      },
      signature: '02'.repeat(32),
    },
  };

  it('reads whether a form asks for it, and refuses a kind it cannot give', () => {
    expect(readForm({ ...shown, botProtection: 'altcha' })?.botProtection).toBe('altcha');
    expect(readForm(shown)).not.toHaveProperty('botProtection');
    expect(readForm({ ...shown, botProtection: 'off' })).not.toHaveProperty('botProtection');
    expect(readForm({ ...shown, botProtection: 'turnstile' })).toBeUndefined();
  });

  it('reads a challenge it can solve, whole, and nothing else', () => {
    // Kept as it came, for the CRM to check its signature.
    expect(readChallenge(given)).toEqual(given.challenge);
    const changed = (parameters: Record<string, unknown>) => ({
      ...given,
      challenge: {
        ...given.challenge,
        parameters: { ...given.challenge.parameters, ...parameters },
      },
    });
    for (const bad of [
      null,
      { ...given, kind: 'turnstile' },
      changed({ algorithm: 'SCRYPT' }),
      changed({ nonce: 'xyz' }),
      changed({ salt: '' }),
      changed({ keyPrefix: 'EF' }),
      changed({ cost: 0 }),
      changed({ cost: 100_001 }),
      changed({ keyLength: 65 }),
      changed({ expiresAt: -1 }),
      { ...given, challenge: { ...given.challenge, signature: 7 } },
    ])
      expect(readChallenge(bad)).toBeUndefined();
  });

  it('asks for the challenge of the showing it holds, with a JSON post', async () => {
    const { api, calls } = answering(200, given);
    const answer = await api.challenge(TOKEN);
    expect(answer).toEqual({ ok: true, value: given.challenge });
    expect(calls[0]?.[0]).toBe(`https://crm.example.test/api/v1/public/forms/${KEY}/challenge`);
    expect(calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ renderToken: TOKEN }),
      credentials: 'omit',
    });
    expect(await answering(409, {}).api.challenge(TOKEN)).toEqual({ ok: false, failure: 'stale' });
  });
});
