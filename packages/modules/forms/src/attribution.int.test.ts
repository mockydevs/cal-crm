// Attribution captured by a form, through the real public handlers against a migrated
// Postgres: what the page's address and the site before it say of the visit is kept on the
// contact the submission reaches, as its first touch and then as its latest.
import { expect, it } from 'vitest';

import { formSuite, WEBSITE, type FormFixture } from '../test/form-fixtures.js';

const suite = formSuite();
const { fixture, published, submit } = suite;
const OK = { outcome: 'ok', receipt: { status: 'received' } };

const touchesOf = (f: FormFixture) =>
  suite.database.withTenant(f.business.context, (sql) =>
    sql.query(
      `select t.medium, t.session_source, t.utm_source, t.utm_medium, t.utm_campaign,
              t.utm_term, t.match_type, t.campaign_id, t.ad_group_id, t.ad_id, t.gclid,
              t.fbclid, t.referrer_domain, t.landing_url, t.subject_kind, t.is_first, t.is_latest,
              t.subject_id = s.id as of_submission
       from crm.contact_attributions t
       left join forms.submissions s
         on s.business_id = t.business_id and s.id = t.subject_id and s.contact_id = t.contact_id
       order by t.touched_at, t.id`,
    ),
  );

it('keeps where a visitor came from on the contact their submission makes, and then on each return', async () => {
  const f = await fixture();
  const form = await published(f);
  const first = await submit(
    form,
    { first_name: 'Maya', email: 'maya@example.test' },
    {
      // A Google Ads click, with a visitor's own detail in the query that must not be kept.
      pageUrl: `${WEBSITE}/venues/hire?utm_source=adwords&utm_medium=Ad%201&utm_campaign=Spring&utm_keyword=venue+hire&utm_matchtype=e&campaign_id=111&ad_group_id=222&ad_id=333&gclid=Cj0abc&email=maya@example.test#form`,
      referrer: 'https://www.google.com/',
    },
  );
  expect(first.result).toEqual(OK);
  expect(await touchesOf(f)).toEqual([
    {
      medium: 'form',
      session_source: 'paid_search',
      utm_source: 'adwords',
      utm_medium: 'Ad 1',
      utm_campaign: 'Spring',
      utm_term: 'venue hire',
      match_type: 'e',
      campaign_id: '111',
      ad_group_id: '222',
      ad_id: '333',
      gclid: 'Cj0abc',
      fbclid: null,
      referrer_domain: 'www.google.com',
      landing_url: `${WEBSITE}/venues/hire`,
      // One touch: the contact's own first touch, filled in by the form that made it.
      subject_kind: 'form_submission',
      is_first: true,
      is_latest: true,
      of_submission: true,
    },
  ]);

  // The same person comes back from Facebook and sends the form again.
  const again = await submit(
    form,
    { email: 'maya@example.test' },
    { pageUrl: `${WEBSITE}/venues/hire?fbclid=IwAR0`, referrer: 'https://m.facebook.com' },
  );
  expect(again.result).toEqual(OK);
  const touches = await touchesOf(f);
  expect(
    touches.map((touch) => [
      touch['session_source'],
      touch['fbclid'],
      touch['referrer_domain'],
      touch['is_first'],
      touch['is_latest'],
      touch['of_submission'],
    ]),
  ).toEqual([
    ['paid_search', null, 'www.google.com', true, false, true],
    ['social_media', 'IwAR0', 'm.facebook.com', false, true, true],
  ]);
});

it('reads nothing of a page on another website, and calls a visit with nothing to say direct', async () => {
  const f = await fixture();
  const form = await published(f);
  // The page is whatever the embed says: one that is not the admitted website is not read.
  await submit(
    form,
    { email: 'amina@example.test' },
    { pageUrl: 'https://elsewhere.example/?utm_source=adwords&gclid=x' },
  );
  await submit(form, { email: 'brian@example.test' }, { pageUrl: `${WEBSITE}/contact` });
  await submit(form, { email: 'carol@example.test' });
  expect(
    (await touchesOf(f)).map((touch) => [
      touch['session_source'],
      touch['utm_source'],
      touch['gclid'],
      touch['landing_url'],
    ]),
  ).toEqual([
    ['direct', null, null, null],
    ['direct', null, null, `${WEBSITE}/contact`],
    ['direct', null, null, null],
  ]);
});
