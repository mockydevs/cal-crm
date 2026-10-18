// Snippets, trigger links and manual actions: what their inputs accept, what the automation
// catalogue gained for them, and that every operation is published.
import { describe, expect, it } from 'vitest';

import { validateAutomation, type AutomationSetup } from './automations-validate.js';
import { harborLights } from './automations-validate.test.js';
import {
  assignManualActionInput,
  automationStepTypes,
  automationTriggerTypes,
  createSnippetInput,
  createTriggerLinkInput,
  endpoints,
  listManualActionsQuery,
  listSnippetsQuery,
  listTriggerLinkClicksQuery,
  listTriggerLinksQuery,
  manualActionEndpoints,
  moveSnippetsInput,
  parseInput,
  renderSnippetInput,
  SNIPPET_LIMITS,
  snippetEndpoints,
  snippetTextIssues,
  triggerLinkEndpoints,
  triggerLinkKeys,
  triggerLinkMergeKey,
  triggerLinkToken,
  updateSnippetInput,
  updateTriggerLinkInput,
} from './index.js';

const snippetId = 'snip_01h455vb4pex5vsknk084sn02q';
const folderId = 'snf_01h455vb4pex5vsknk084sn02q';
const contactId = 'con_01h455vb4pex5vsknk084sn02q';
const membershipId = 'mem_01h455vb4pex5vsknk084sn02q';
const revision = 'a'.repeat(64);

describe('a snippet’s inputs', () => {
  it('make a text snippet from a name and a body, in no folder and with no subject', () => {
    expect(
      parseInput(createSnippetInput, { type: 'text', name: '  Running late ', body: ' Hi\n' }),
    ).toEqual({ type: 'text', name: 'Running late', subject: null, body: ' Hi\n', folderId: null });
  });

  it('need a subject for an email, on one line, and refuse one for a text', () => {
    expect(createSnippetInput.safeParse({ type: 'email', name: 'Quote', body: 'Hi' }).success).toBe(
      false,
    );
    expect(
      createSnippetInput.safeParse({ type: 'email', name: 'Quote', subject: 'A\nB', body: 'Hi' })
        .success,
    ).toBe(false);
    expect(
      createSnippetInput.safeParse({ type: 'text', name: 'Quote', subject: 'Hello', body: 'Hi' })
        .success,
    ).toBe(false);
    expect(
      createSnippetInput.safeParse({ type: 'email', name: 'Quote', subject: 'Hello', body: 'Hi' })
        .success,
    ).toBe(true);
  });

  it('hold a text snippet to one text message, and an email to 100,000 characters', () => {
    const body = 'x'.repeat(SNIPPET_LIMITS.text);
    expect(createSnippetInput.safeParse({ type: 'text', name: 'Long', body }).success).toBe(true);
    expect(
      createSnippetInput.safeParse({ type: 'text', name: 'Long', body: `${body}x` }).success,
    ).toBe(false);
    expect(
      createSnippetInput.safeParse({ type: 'email', name: 'Long', subject: 'S', body: `${body}x` })
        .success,
    ).toBe(true);
    expect(
      createSnippetInput.safeParse({
        type: 'email',
        name: 'Long',
        subject: 'S',
        body: 'x'.repeat(SNIPPET_LIMITS.email + 1),
      }).success,
    ).toBe(false);
  });

  it('save the whole snippet from a revision, and never its type', () => {
    const whole = { name: 'Quote', subject: null, body: 'Hi', folderId, revision };
    expect(parseInput(updateSnippetInput, whole)).toEqual(whole);
    expect(updateSnippetInput.safeParse({ ...whole, type: 'email' }).success).toBe(false);
    expect(updateSnippetInput.safeParse({ ...whole, revision: undefined }).success).toBe(false);
  });

  it('say what a saved text must hold for the type the snippet already has', () => {
    expect(snippetTextIssues({ type: 'text', subject: null, body: 'Hi' })).toEqual([]);
    expect(snippetTextIssues({ type: 'email', subject: null, body: 'Hi' })).toEqual([
      { path: '/subject', message: 'Give the email a subject.' },
    ]);
    expect(snippetTextIssues({ type: 'text', subject: 'S', body: 'x'.repeat(1601) })).toEqual([
      { path: '/subject', message: 'A text snippet has no subject.' },
      { path: '/body', message: 'A text snippet holds at most 1,600 characters.' },
    ]);
  });

  it('move 1 to 100 snippets, each named once', () => {
    expect(moveSnippetsInput.safeParse({ snippetIds: [], folderId: null }).success).toBe(false);
    expect(
      moveSnippetsInput.safeParse({ snippetIds: [snippetId, snippetId], folderId }).success,
    ).toBe(false);
    expect(moveSnippetsInput.safeParse({ snippetIds: [snippetId], folderId: null }).success).toBe(
      true,
    );
  });

  it('page the list by 20 unless asked, 100 at most, with a search, a type and a folder', () => {
    expect(parseInput(listSnippetsQuery, {})).toEqual({ limit: 20 });
    expect(
      parseInput(listSnippetsQuery, { q: ' late ', type: 'email', folder: 'none', limit: '100' }),
    ).toEqual({ q: 'late', type: 'email', folder: 'none', limit: 100 });
    expect(listSnippetsQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(listSnippetsQuery.safeParse({ type: 'whatsapp' }).success).toBe(false);
  });

  it('are filled in for a contact, and nothing else', () => {
    expect(parseInput(renderSnippetInput, { contactId })).toEqual({ contactId });
    expect(renderSnippetInput.safeParse({ contactId, values: {} }).success).toBe(false);
  });
});

describe('a trigger link’s inputs', () => {
  it('take a name and a full web address; the server makes the key', () => {
    expect(
      parseInput(createTriggerLinkInput, {
        name: ' Spring offer ',
        url: ' https://x.example/a?b=1 ',
      }),
    ).toEqual({ name: 'Spring offer', url: 'https://x.example/a?b=1' });
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,hi',
    'ftp://x.example/file',
    '//x.example/path',
    '/offer',
    'x.example',
    'https://user:secret@x.example/',
    'https://x.example/a b',
    'https://x.example/a\nb',
    'https://x.example/?e={{contact.email}}',
    `https://x.example/${'a'.repeat(2000)}`,
  ])('refuse %s as where a link goes', (url) => {
    expect(createTriggerLinkInput.safeParse({ name: 'Offer', url }).success).toBe(false);
    expect(updateTriggerLinkInput.safeParse({ name: 'Offer', url, revision }).success).toBe(false);
  });

  it('never take a key on a save: a link keeps the key it was made with', () => {
    const whole = { name: 'Offer', url: 'http://x.example/', revision };
    expect(parseInput(updateTriggerLinkInput, whole)).toEqual(whole);
    expect(updateTriggerLinkInput.safeParse({ ...whole, key: 'offer' }).success).toBe(false);
    expect(
      createTriggerLinkInput.safeParse({ ...whole, revision: undefined, key: 'Offer' }).success,
    ).toBe(false);
  });

  it('are written into a message by key, and found there again', () => {
    expect(triggerLinkMergeKey('spring_offer')).toBe('trigger_link.spring_offer');
    expect(
      triggerLinkKeys(['contact.firstName', 'trigger_link.a', 'trigger_link.b', 'trigger_link.a']),
    ).toEqual(['a', 'b']);
  });

  it('are opened by a token of 43 URL-safe characters and nothing else', () => {
    expect(triggerLinkToken.safeParse('A'.repeat(43)).success).toBe(true);
    expect(triggerLinkToken.safeParse('A'.repeat(42)).success).toBe(false);
    expect(triggerLinkToken.safeParse(`${'A'.repeat(42)}/`).success).toBe(false);
  });

  it('page both lists by 20 unless asked, 100 at most, and take a range of clicks', () => {
    expect(parseInput(listTriggerLinksQuery, {})).toEqual({ limit: 20 });
    expect(listTriggerLinksQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(
      parseInput(listTriggerLinkClicksQuery, { from: '2026-10-01T00:00:00Z', limit: '5' }),
    ).toEqual({ from: '2026-10-01T00:00:00Z', limit: 5 });
    expect(listTriggerLinkClicksQuery.safeParse({ from: 'yesterday' }).success).toBe(false);
  });
});

describe('the manual actions queue', () => {
  it('shows what is pending for anyone unless asked, 20 at a time and 100 at most', () => {
    expect(parseInput(listManualActionsQuery, {})).toEqual({
      status: 'pending',
      assignee: 'anyone',
      limit: 20,
    });
    expect(
      parseInput(listManualActionsQuery, { status: 'all', type: 'sms', assignee: membershipId }),
    ).toEqual({ status: 'all', type: 'sms', assignee: membershipId, limit: 20 });
    expect(listManualActionsQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(listManualActionsQuery.safeParse({ type: 'email' }).success).toBe(false);
  });

  it('assigns to a member, to the reader or to nobody, from a revision', () => {
    for (const assignee of [membershipId, 'me', null])
      expect(assignManualActionInput.safeParse({ assignee, revision }).success).toBe(true);
    expect(assignManualActionInput.safeParse({ assignee: 'anyone', revision }).success).toBe(false);
    expect(assignManualActionInput.safeParse({ assignee: null }).success).toBe(false);
  });
});

describe('the automation catalogue', () => {
  const links: AutomationSetup = {
    ...harborLights,
    triggerLinks: [{ id: 'tlnk_offer', name: 'Spring offer', key: 'spring_offer' }],
  };
  const clicked = (link: string, message: string, setup: AutomationSetup) =>
    validateAutomation(
      {
        name: 'Clicked',
        triggers: [{ id: 'clicked', type: 'trigger_link.clicked', config: { link } }],
        start: 'text',
        steps: {
          text: { type: 'manual.sms', config: { message }, next: 'call' },
          call: { type: 'manual.call', config: { notes: 'Ask about {{contact.firstName}}' } },
        },
      },
      setup,
    );

  it('has a trigger for a clicked link, which must say which link', () => {
    expect(automationTriggerTypes['trigger_link.clicked'].label).toBe('Trigger link clicked');
    expect(automationTriggerTypes['trigger_link.clicked'].config.safeParse({}).success).toBe(false);
  });

  it('has a manual call and a manual text, each with one way on and its outcome', () => {
    for (const type of ['manual.call', 'manual.sms'] as const) {
      expect(automationStepTypes[type].branches).toEqual({ kind: 'none' });
      expect(automationStepTypes[type].outputs.map((output) => output.key)).toEqual(['outcome']);
    }
    expect(automationStepTypes['manual.sms'].config.safeParse({}).success).toBe(false);
    expect(automationStepTypes['manual.call'].config.safeParse({}).success).toBe(true);
  });

  it('resolves the link a trigger names by name, and accepts its key in a step’s text', () => {
    const result = clicked('spring offer', 'Here: {{trigger_link.spring_offer}}', links);
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({ link: 'tlnk_offer' });
  });

  it('refuses a link the business does not have, as a trigger and as a merge field', () => {
    const result = clicked('Summer offer', 'Here: {{trigger_link.spring_ofer}}', links);
    expect(result.errors.map(({ path, code, message }) => ({ path, code, message }))).toEqual([
      {
        path: '/triggers/0/config/link',
        code: 'unknown_reference',
        message: 'There\'s no trigger link "Summer offer".',
      },
      {
        path: '/steps/text/config/message',
        code: 'unknown_merge_field',
        message: 'trigger_link.spring_ofer is not a trigger link.',
      },
    ]);
    expect(result.errors[1]?.suggestion).toBe('Did you mean spring_offer?');
  });

  it('checks nothing about links for a setup that cannot tell which exist', () => {
    const result = clicked('Summer offer', 'Here: {{trigger_link.anything}}', harborLights);
    expect(result.errors).toEqual([]);
    expect(result.document?.triggers[0]?.config).toEqual({ link: 'Summer offer' });
  });

  it('resolves who a manual action is for, as any step that names a team member', () => {
    const result = validateAutomation(
      {
        name: 'Call',
        triggers: [{ id: 'created', type: 'contact.created', config: {} }],
        start: 'call',
        steps: { call: { type: 'manual.call', config: { user: 'Nobody Here' } } },
      },
      links,
    );
    expect(result.errors.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: '/steps/call/config/user', code: 'unknown_reference' },
    ]);
  });
});

describe('the published API', () => {
  it('lists every snippet, trigger link and manual action operation once', () => {
    const mine = [...snippetEndpoints, ...triggerLinkEndpoints, ...manualActionEndpoints];
    expect(mine).toHaveLength(22);
    const published = endpoints.map((endpoint) => endpoint.operationId);
    for (const endpoint of mine)
      expect(published.filter((id) => id === endpoint.operationId)).toHaveLength(1);
    expect(new Set(mine.map(({ method, path }) => `${method} ${path}`)).size).toBe(22);
  });
});
