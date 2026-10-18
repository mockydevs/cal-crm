import { webchatWidgetInput, type WebchatWidget } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { issuesOf } from './problems';
import {
  draftOf,
  emptyDraft,
  inputOf,
  websiteLines,
  widgetProblem,
  type WidgetDraft,
} from './webchat-settings-rules';

const widget: WebchatWidget = {
  id: 'wcw_01k8e2wzr0e008000000000001',
  name: 'Main site',
  publicKey: 'k'.repeat(32),
  enabled: false,
  allowedOrigins: ['https://example.com', 'https://www.example.com'],
  settings: {
    title: 'Chat with us',
    greeting: '',
    emailRequired: false,
    marketingConsentWording: 'Email me news and offers.',
  },
  embedSnippet: '<script async src="https://crm.example.test/webchat/widget.js"></script>',
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
};
const about = (website: string, message: string): string => `${website}: ${message}`;

describe('websiteLines', () => {
  it('reads one website a line, without the spaces around each or the empty lines', () => {
    expect(websiteLines('  https://example.com \r\n\n\thttps://www.example.com\n   \n')).toEqual([
      'https://example.com',
      'https://www.example.com',
    ]);
    expect(websiteLines('')).toEqual([]);
  });

  it('keeps what is wrong with a line for the API to refuse, and never repairs it', () => {
    expect(websiteLines('https://example.com, https://evil.test')).toEqual([
      'https://example.com, https://evil.test',
    ]);
    expect(websiteLines('https://*.example.com')).toEqual(['https://*.example.com']);
  });
});

describe('a draft', () => {
  it('starts on, asking for an email address, with no marketing box', () => {
    const draft = emptyDraft('Chat with us', 'Hello.');
    expect(draft).toMatchObject({
      enabled: true,
      emailRequired: true,
      offerMarketing: false,
      title: 'Chat with us',
      greeting: 'Hello.',
    });
    expect(inputOf(draft)).toMatchObject({
      allowedOrigins: [],
      settings: { marketingConsentWording: null },
    });
  });

  it('shows a stored widget as it is, and sends it back unchanged', () => {
    const draft = draftOf(widget);
    expect(draft).toEqual({
      name: 'Main site',
      websites: 'https://example.com\nhttps://www.example.com',
      enabled: false,
      title: 'Chat with us',
      greeting: '',
      emailRequired: false,
      offerMarketing: true,
      marketingWording: 'Email me news and offers.',
    } satisfies WidgetDraft);
    expect(webchatWidgetInput.parse(inputOf(draft))).toEqual({
      name: widget.name,
      allowedOrigins: widget.allowedOrigins,
      enabled: widget.enabled,
      settings: widget.settings,
    });
  });

  it('sends no wording when the box is not offered, whatever was typed before', () => {
    const draft = { ...draftOf(widget), offerMarketing: false };
    expect(inputOf(draft).settings).toMatchObject({ marketingConsentWording: null });
  });

  it('is refused by the schema when the box is offered with no words beside it', () => {
    const parsed = webchatWidgetInput.safeParse(
      inputOf({ ...draftOf(widget), offerMarketing: true, marketingWording: '   ' }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('widgetProblem', () => {
  it('puts each issue under the field that shows it', () => {
    const websites = 'https://example.com\nhttps://*.example.com';
    const parsed = webchatWidgetInput.safeParse(
      inputOf({ ...draftOf(widget), name: '', title: '', marketingWording: '', websites }),
    );
    if (parsed.success) throw new Error('The draft should be refused.');
    const problem = widgetProblem(issuesOf(parsed.error), websites, about);
    expect(problem.form).toBeUndefined();
    expect(Object.keys(problem.fields).sort()).toEqual([
      'marketingWording',
      'name',
      'title',
      'websites',
    ]);
    expect(problem.fields.name).toBe('Enter a name.');
    expect(problem.fields.websites).toBe(
      'https://*.example.com: Enter a website address with nothing after the host, such as https://www.example.com.',
    );
  });

  it('names the website an issue is about, counting as the API does: empty lines skipped', () => {
    const problem = widgetProblem(
      [{ path: '/allowedOrigins/1', message: 'Enter a secure website address.' }],
      '\n\nhttps://example.com\n\nhttp://example.com\n',
      about,
    );
    expect(problem.fields.websites).toBe('http://example.com: Enter a secure website address.');
  });

  it('keeps the first issue of a field, and shows what no field can above the buttons', () => {
    const problem = widgetProblem(
      [
        { path: '/allowedOrigins', message: 'Add at most 20 websites.' },
        { path: '/allowedOrigins/0', message: 'Second.' },
        { path: '/enabled', message: 'Choose on or off.' },
        { path: '', message: 'Later.' },
      ],
      'https://example.com',
      about,
    );
    expect(problem).toEqual({
      fields: { websites: 'Add at most 20 websites.' },
      form: 'Choose on or off.',
    });
  });

  it('shows the message alone when the website it names is not in the box any more', () => {
    expect(
      widgetProblem([{ path: '/allowedOrigins/7', message: 'Not an address.' }], '', about).fields,
    ).toEqual({ websites: 'Not an address.' });
  });
});
