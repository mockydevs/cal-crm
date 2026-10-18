import { EMPTY_PAGE_DOCUMENT, pageDocument } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  calendarLabelOf,
  calendarStateOf,
  DEFAULT_CALENDAR_LABEL,
  MAX_DELAY_SECONDS,
  openingOf,
  openingPatch,
  problemsByNode,
  type CalendarChoice,
} from './element-rules';

describe('openingOf', () => {
  it('reads when a popup opens, with the document’s defaults for what it leaves out', () => {
    expect(openingOf({ trigger: 'none', delaySeconds: 0 })).toStrictEqual({
      trigger: 'none',
      delaySeconds: 0,
      frequency: 'session',
    });
    expect(openingOf({ trigger: 'delay', delaySeconds: 12, frequency: 'always' })).toStrictEqual({
      trigger: 'delay',
      delaySeconds: 12,
      frequency: 'always',
    });
    expect(openingOf({ trigger: 'exit', delaySeconds: 0, frequency: 'session' }).trigger).toBe(
      'exit',
    );
  });

  it('reads what it does not know as a popup that opens from a link only', () => {
    expect(openingOf({})).toStrictEqual({ trigger: 'none', delaySeconds: 0, frequency: 'session' });
    expect(openingOf({ trigger: 'scroll', delaySeconds: '5', frequency: 'often' })).toStrictEqual({
      trigger: 'none',
      delaySeconds: 0,
      frequency: 'session',
    });
    expect(openingOf({ delaySeconds: -3 }).delaySeconds).toBe(0);
    expect(openingOf({ delaySeconds: 2.5 }).delaySeconds).toBe(0);
    expect(openingOf({ delaySeconds: 99_999 }).delaySeconds).toBe(MAX_DELAY_SECONDS);
  });
});

describe('openingPatch', () => {
  const asSaved = (patch: Readonly<Record<string, unknown>>): unknown =>
    JSON.parse(JSON.stringify(patch));

  it('keeps how often only where it says something', () => {
    const closed = { trigger: 'none', delaySeconds: 0 };
    // Once in a visit is the default, and a popup opened from a link has no "how often".
    expect(asSaved(openingPatch(closed, { trigger: 'exit' }))).toStrictEqual({
      trigger: 'exit',
      delaySeconds: 0,
    });
    const always = openingPatch({ trigger: 'exit', delaySeconds: 0 }, { frequency: 'always' });
    expect(always).toStrictEqual({ trigger: 'exit', delaySeconds: 0, frequency: 'always' });
    expect(asSaved(openingPatch({ ...always }, { frequency: 'session' }))).toStrictEqual({
      trigger: 'exit',
      delaySeconds: 0,
    });
    // Back to a link only: the key goes, so the page is the page it was.
    expect(openingPatch({ ...always }, { trigger: 'none' })).toStrictEqual({
      trigger: 'none',
      delaySeconds: 0,
      frequency: undefined,
    });
  });

  it('starts a delay at five seconds, and leaves a delay that was set as it is', () => {
    expect(openingPatch({ trigger: 'none', delaySeconds: 0 }, { trigger: 'delay' })).toMatchObject({
      trigger: 'delay',
      delaySeconds: 5,
    });
    expect(openingPatch({ trigger: 'none', delaySeconds: 30 }, { trigger: 'delay' })).toMatchObject(
      { trigger: 'delay', delaySeconds: 30 },
    );
    // A person may set none at all once it opens after a delay.
    expect(openingPatch({ trigger: 'delay', delaySeconds: 5 }, { delaySeconds: 0 })).toMatchObject({
      trigger: 'delay',
      delaySeconds: 0,
    });
    expect(openingPatch({ trigger: 'delay', delaySeconds: 0 }, { trigger: 'delay' })).toMatchObject(
      { delaySeconds: 0 },
    );
  });

  it('gives props the page document takes, whatever is chosen', () => {
    const base = { name: 'Offer', trigger: 'none', delaySeconds: 0, width: 'medium' } as const;
    const changes = [
      { trigger: 'delay' },
      { trigger: 'exit' },
      { trigger: 'none' },
      { frequency: 'always' },
      { frequency: 'session' },
      { delaySeconds: MAX_DELAY_SECONDS },
    ] as const;
    for (const first of changes)
      for (const second of changes) {
        const once = { ...base, ...openingPatch(base, first) };
        const { name, ...props } = { ...once, ...openingPatch(once, second) };
        const parsed = pageDocument.safeParse({
          ...EMPTY_PAGE_DOCUMENT,
          popups: [{ id: 'p', type: 'popup', name, props: asSaved(props), rows: [] }],
        });
        expect(parsed.success, JSON.stringify([first, second, props])).toBe(true);
      }
  });
});

describe('calendarStateOf', () => {
  const calendars = new Map<string, CalendarChoice>([
    ['cal_1', { id: 'cal_1', name: 'Intro call', active: true }],
    ['cal_2', { id: 'cal_2', name: 'Site visit', active: false }],
  ]);

  it('says whether the calendar an element names can be published, and why not', () => {
    expect(calendarStateOf('cal_1', calendars)).toStrictEqual({ at: 'ready', name: 'Intro call' });
    expect(calendarStateOf('cal_2', calendars)).toStrictEqual({
      at: 'inactive',
      name: 'Site visit',
    });
    expect(calendarStateOf('cal_9', calendars)).toStrictEqual({ at: 'gone' });
    expect(calendarStateOf(null, calendars)).toStrictEqual({ at: 'none' });
    expect(calendarStateOf(undefined, calendars)).toStrictEqual({ at: 'none' });
    expect(calendarStateOf('', calendars)).toStrictEqual({ at: 'none' });
    expect(calendarStateOf(7, calendars)).toStrictEqual({ at: 'none' });
  });

  it('gives the link its own words, or the page’s', () => {
    expect(calendarLabelOf(' Book your visit ')).toBe('Book your visit');
    expect(calendarLabelOf('')).toBe(DEFAULT_CALENDAR_LABEL);
    expect(calendarLabelOf('   ')).toBe(DEFAULT_CALENDAR_LABEL);
    expect(calendarLabelOf(undefined)).toBe('Book a time');
  });
});

describe('problemsByNode', () => {
  it('gathers what is wrong with each element, each sentence once, from every list', () => {
    const found = problemsByNode(
      [
        { message: 'This page has no such popup.', nodeId: 'cta', blocking: false },
        { message: 'The page is empty.', nodeId: null, blocking: true },
      ],
      undefined,
      [
        { message: 'Choose a calendar for this calendar element.', nodeId: 'cal', blocking: true },
        { message: 'This page has no such popup.', nodeId: 'cta', blocking: true },
        { message: 'Runs on a connected domain only.', nodeId: 'cta', blocking: false },
        { message: 'Choose a calendar for this calendar element.', nodeId: 'cal', blocking: false },
      ],
    );
    expect([...found.keys()]).toEqual(['cta', 'cal']);
    // Said once, and as blocking if either list says it blocks, whichever came first.
    expect(found.get('cta')).toEqual([
      { message: 'This page has no such popup.', blocking: true },
      { message: 'Runs on a connected domain only.', blocking: false },
    ]);
    expect(found.get('cal')).toEqual([
      { message: 'Choose a calendar for this calendar element.', blocking: true },
    ]);
    expect(problemsByNode().size).toBe(0);
  });
});
