import { expect, it } from 'vitest';

import { embedCode, EMBED_HEIGHT } from './calendar-embed';

it('frames the booking page and loads the sizing script from the install', () => {
  expect(
    embedCode('https://crm.example/book/bluebird/harbor/tours', 'https://crm.example', 'Tours'),
  ).toBe(
    [
      `<iframe src="https://crm.example/book/bluebird/harbor/tours" title="Tours" data-crm-booking width="100%" height="${String(EMBED_HEIGHT)}" style="border:0;width:100%" loading="lazy"></iframe>`,
      '<script async src="https://crm.example/calendars/embed.js"></script>',
    ].join('\n'),
  );
});

it('writes a calendar’s name as text, never as markup', () => {
  const code = embedCode(
    'https://crm.example/book/a/b/c',
    'https://crm.example',
    'Tours "& more" <script>',
  );
  expect(code).toContain('title="Tours &quot;&amp; more&quot; &lt;script&gt;"');
  expect(code.match(/<script/g)).toHaveLength(1);
});
