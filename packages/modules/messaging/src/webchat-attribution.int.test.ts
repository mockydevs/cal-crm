// A web chat records where its visitor came from, against a migrated Postgres: one touch on
// the contact the first message makes, which knows the website the widget was on and
// nothing else, since the widget reads nothing more of its page.
import { afterAll, beforeAll, expect, inject, it } from 'vitest';

import { ORIGIN, startWebchat, type WebchatWorld } from '../test/webchat.js';

let world: WebchatWorld;
beforeAll(async () => {
  world = await startWebchat(inject('databaseServer'));
});
afterAll(async () => {
  await world.close();
});

it('gives the contact a chat makes one touch: a chat, on the widget’s website', async () => {
  const f = await world.fixture();
  const session = await world.started(f, { email: 'maya@example.test' });
  // No contact, and so no touch, until there is a message.
  const touches = () =>
    world.database.withTenant(f.context, (sql) =>
      sql.query(
        `select t.medium, t.session_source, t.utm_source, t.referrer_domain, t.landing_url,
                t.subject_kind, t.is_first, t.is_latest, s.id is not null as of_session
         from crm.contact_attributions t
         left join messaging.webchat_sessions s
           on s.business_id = t.business_id and s.id = t.subject_id and s.contact_id = t.contact_id`,
      ),
    );
  expect(await touches()).toEqual([]);
  await world.sent(f, session, 'Hello');
  await world.sent(f, session, 'Are you open on Sunday?');
  // One touch, however many messages: the contact's first, filled in by the chat.
  expect(await touches()).toEqual([
    {
      medium: 'chat',
      session_source: 'direct',
      utm_source: null,
      referrer_domain: null,
      landing_url: ORIGIN,
      subject_kind: 'webchat_session',
      is_first: true,
      is_latest: true,
      of_session: true,
    },
  ]);
});
