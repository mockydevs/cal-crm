// @vitest-environment jsdom
// The fields this stage added to the selected element's panel: an image's picture (typed,
// pasted or chosen from Media Storage), its size and its description; a calendar element's
// calendar; when a popup opens; and what stands in the way of an element, said at it.
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import type { MediaFile } from '@repo/contracts';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useMemo, useState, type ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasActionsContext, type CanvasActions } from './canvas-api';
import type { CanvasNode } from './document-map';
import {
  EditorFactsContext,
  ElementProblems,
  NodeFields,
  NodeProblemsContext,
  type EditorFacts,
} from './fields';

const measured = vi.hoisted(() => {
  const answer: (address: string) => Promise<{ width: number; height: number } | null> = () =>
    Promise.resolve({ width: 1200, height: 800 });
  return { asked: [] as string[], answer };
});
vi.mock('./picture-field', async (original) => ({
  ...(await original<typeof import('./picture-field')>()),
  measurePicture: (address: string) => {
    measured.asked.push(address);
    return measured.answer(address);
  },
}));
vi.mock('../workspace', () => ({
  useBusiness: () => ({ id: 'biz_test', name: 'Harbor Lights Events', slug: 'harbor' }),
}));
const library = vi.hoisted(() => ({ address: 'https://crm.example/m/k4v9x2/storefront.jpg' }));
// The library's dialog itself is tested where it is made (src/media, and
// site-media-choice.test.tsx): here it is a button that chooses one file.
vi.mock('../site-media-choice', () => ({
  default: ({
    onChosen,
    onClose,
  }: {
    onChosen: (address: string, file: MediaFile) => void;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Media Storage">
      <button
        type="button"
        onClick={() => {
          onChosen(library.address, { id: 'file_1', name: 'storefront.jpg' } as MediaFile);
        }}
      >
        Choose storefront.jpg
      </button>
      <button type="button" onClick={onClose}>
        Close the library
      </button>
    </div>
  ),
}));

configure({ asyncUtilTimeout: 10000 });
vi.setConfig({ testTimeout: 30000 });

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
beforeEach(() => {
  measured.asked.length = 0;
  measured.answer = () => Promise.resolve({ width: 1200, height: 800 });
});
afterEach(cleanup);

const facts: EditorFacts = {
  funnel: true,
  forms: [],
  calendars: [
    { id: 'cal_1', name: 'Intro call', active: true },
    { id: 'cal_2', name: 'Site visit', active: false },
    { id: 'cal_3', name: 'Yearly review', active: true },
  ],
  scripts: { countdown: true, popup: true },
  steps: [],
  hasNextStep: false,
  notes: new Map(),
};

/** Every change the panel asked of the canvas, in order. */
const sets: Readonly<Record<string, unknown>>[] = [];
let latest: CanvasNode;

/** The panel over one node, kept as the canvas would keep it: a change is drawn. */
function Panel({
  first,
  given = facts,
}: {
  readonly first: CanvasNode;
  readonly given?: EditorFacts;
}): ReactElement {
  const [node, setNode] = useState(first);
  const actions = useMemo(
    (): CanvasActions =>
      ({
        read: () => latest,
        setProps: (_id: string, props: Readonly<Record<string, unknown>>) => {
          sets.push(props);
          const next: Record<string, unknown> = { ...latest.props, ...props };
          for (const [key, value] of Object.entries(props))
            if (value === undefined) Reflect.deleteProperty(next, key);
          latest = { ...latest, props: next as CanvasNode['props'] };
          setNode(latest);
        },
      }) as unknown as CanvasActions,
    [],
  );
  return (
    <I18nProvider i18n={i18n}>
      <EditorFactsContext value={given}>
        <CanvasActionsContext value={actions}>
          <NodeFields node={node} />
        </CanvasActionsContext>
      </EditorFactsContext>
    </I18nProvider>
  );
}

function show(first: CanvasNode, given?: EditorFacts): ReturnType<typeof userEvent.setup> {
  sets.length = 0;
  latest = first;
  render(<Panel first={first} {...(given === undefined ? {} : { given })} />);
  return userEvent.setup();
}

const image = (props: Record<string, unknown> = {}): CanvasNode => ({
  type: 'image',
  props: {
    id: 'picture',
    src: null,
    alt: '',
    action: { type: 'none' },
    optimize: true,
    look: {},
    ...props,
  },
});
const src = 'https://example.com/harbour.jpg';

describe('an image’s picture', () => {
  it('takes a pasted address at once, then stores the picture’s own size', async () => {
    show(image());
    expect(
      screen.getByText("The page can't be published until this image has a picture."),
    ).toBeTruthy();
    expect(screen.queryByTestId('picture-size')).toBeNull();
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: src } });
    // Shown at once, with no size of an earlier picture left behind.
    expect(sets[0]).toStrictEqual({ src, width: undefined, height: undefined });
    await waitFor(() => {
      expect(sets.at(-1)).toStrictEqual({ width: 1200, height: 800 });
    });
    expect(measured.asked).toEqual([src]);
    expect(await screen.findByText('1200 × 800 px')).toBeTruthy();
    expect(latest.props).toMatchObject({ src, width: 1200, height: 800 });
  });

  it('chooses a picture from Media Storage, and stores its address and size as one change', async () => {
    const user = show(image());
    await user.click(
      screen.getByRole('button', { name: 'Image address: choose from Media Storage' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Choose storefront.jpg' }));
    await waitFor(() => {
      expect(sets).toStrictEqual([{ src: library.address, width: 1200, height: 800 }]);
    });
    expect(screen.queryByRole('dialog', { name: 'Media Storage' })).toBeNull();
    expect(screen.getByLabelText('Image address')).toHaveProperty('value', library.address);
    expect(await screen.findByText('1200 × 800 px')).toBeTruthy();
    // The keyboard goes back to what opened the library.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Image address: choose from Media Storage' }),
      );
    });
  });

  it('puts the chosen picture’s address over letters the page would not take', async () => {
    const user = show(image());
    fireEvent.change(screen.getByLabelText('Image address'), {
      target: { value: 'not an address' },
    });
    expect(screen.getByText(/Use a secure web address starting with https/)).toBeTruthy();
    expect(sets).toEqual([]);
    await user.click(
      screen.getByRole('button', { name: 'Image address: choose from Media Storage' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Choose storefront.jpg' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Image address')).toHaveProperty('value', library.address);
    });
    expect(screen.queryByText(/Use a secure web address starting with https/)).toBeNull();
  });

  it('closes the library with nothing chosen and nothing changed', async () => {
    const user = show(image({ src }));
    await user.click(
      screen.getByRole('button', { name: 'Image address: choose from Media Storage' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Close the library' }));
    expect(screen.queryByRole('dialog', { name: 'Media Storage' })).toBeNull();
    expect(sets).toEqual([]);
  });

  it('keeps an old page’s picture working with no size, and reads one when asked', async () => {
    const user = show(image({ src, alt: 'A harbour' }));
    expect(screen.getByText(/Not stored yet\./)).toBeTruthy();
    expect(measured.asked).toEqual([]);
    await user.click(screen.getByRole('button', { name: "Reset to the picture's size" }));
    await waitFor(() => {
      expect(sets).toStrictEqual([{ width: 1200, height: 800 }]);
    });
    expect(await screen.findByText('1200 × 800 px')).toBeTruthy();
  });

  it('says so when the picture cannot be read, and takes a stale size off', async () => {
    measured.answer = () => Promise.resolve(null);
    const user = show(image({ src, alt: 'A harbour', width: 640, height: 480 }));
    expect(screen.getByText('640 × 480 px')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: "Reset to the picture's size" }));
    expect(await screen.findByText(/The picture's size couldn't be read\./)).toBeTruthy();
    expect(sets).toStrictEqual([{ width: undefined, height: undefined }]);
    expect(latest.props).not.toHaveProperty('width');
  });

  it('reads no size from a path on the site or a merge field, and says why', () => {
    show(image({ src: '/harbour.jpg', alt: 'A harbour' }));
    expect(screen.getByText(/a size is read only from a full web address/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "Reset to the picture's size" })).toBeNull();
    fireEvent.change(screen.getByLabelText('Image address'), {
      target: { value: '{{custom_values.logo}}' },
    });
    expect(sets).toStrictEqual([
      { src: '{{custom_values.logo}}', width: undefined, height: undefined },
    ]);
    expect(measured.asked).toEqual([]);
  });

  it('writes only the newest picture’s size when one address follows another', async () => {
    const answers = new Map<string, (size: { width: number; height: number }) => void>();
    measured.answer = (address) =>
      new Promise((resolve) => {
        answers.set(address, resolve);
      });
    show(image());
    const other = 'https://example.com/quay.jpg';
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: src } });
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: other } });
    expect(screen.getByText("Reading the picture's size…")).toBeTruthy();
    // Only what was left standing is loaded: the address typed on the way is never asked for.
    await waitFor(() => {
      expect(measured.asked).toEqual([other]);
    });
    answers.get(other)?.({ width: 300, height: 200 });
    expect(await screen.findByText('300 × 200 px')).toBeTruthy();
    expect(latest.props).toMatchObject({ src: other, width: 300, height: 200 });

    // A picture measured from the library while another answer is still on its way: the
    // late answer is for a picture the element no longer shows, and is dropped.
    const slow = 'https://example.com/slow.jpg';
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: slow } });
    await waitFor(() => {
      expect(measured.asked).toEqual([other, slow]);
    });
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: other } });
    answers.get(slow)?.({ width: 10, height: 10 });
    await waitFor(() => {
      expect(measured.asked).toEqual([other, slow, other]);
    });
    answers.get(other)?.({ width: 300, height: 200 });
    expect(await screen.findByText('300 × 200 px')).toBeTruthy();
    expect(sets).not.toContainEqual({ width: 10, height: 10 });
  });

  it('empties the picture and its size together', () => {
    show(image({ src, alt: 'A harbour', width: 640, height: 480 }));
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: '' } });
    expect(sets).toStrictEqual([{ src: null, width: undefined, height: undefined }]);
    expect(screen.queryByTestId('picture-size')).toBeNull();
  });
});

describe('an image’s description', () => {
  it('asks a new picture for a description or the decoration mark', async () => {
    const user = show(image());
    expect(screen.queryByTestId('alt-prompt')).toBeNull();
    fireEvent.change(screen.getByLabelText('Image address'), { target: { value: src } });
    // Measured a moment after the typing stops: waited for, so it is not still on its way
    // when the next thing is asked.
    expect(await screen.findByText('1200 × 800 px')).toBeTruthy();
    expect(screen.getByTestId('alt-prompt').textContent).toBe(
      'Describe the picture, or mark it below as decoration only.',
    );
    const mark = screen.getByRole('switch', { name: 'Decoration only' });
    expect(mark.getAttribute('aria-checked')).toBe('false');
    await user.click(mark);
    expect(mark.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('alt-prompt')).toBeNull();
    expect(screen.getByText('Screen readers pass over it. It has no description.')).toBeTruthy();
    // A description takes the mark off again.
    fireEvent.change(screen.getByLabelText('Description for screen readers'), {
      target: { value: 'A harbour at dusk' },
    });
    expect(sets.at(-1)).toStrictEqual({ alt: 'A harbour at dusk' });
    expect(mark.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByTestId('alt-prompt')).toBeNull();
  });

  it('shows a saved picture with no description as the decoration it is published as', async () => {
    const user = show(image({ src, alt: '' }));
    const mark = screen.getByRole('switch', { name: 'Decoration only' });
    expect(mark.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('alt-prompt')).toBeNull();
    await user.click(mark);
    expect(screen.getByTestId('alt-prompt')).toBeTruthy();
    expect(sets).toEqual([]);
  });

  it('marking a described picture as decoration takes its description away', async () => {
    const user = show(image({ src, alt: 'A harbour at dusk' }));
    await user.click(screen.getByRole('switch', { name: 'Decoration only' }));
    await waitFor(() => {
      expect(sets).toStrictEqual([{ alt: '' }]);
    });
    await waitFor(() => {
      expect(screen.getByLabelText('Description for screen readers')).toHaveProperty('value', '');
    });
  });

  it('never offers decoration for a picture that is a link, and says what it needs', () => {
    show(image({ src, alt: '', action: { type: 'next_step' } }));
    expect(screen.queryByRole('switch', { name: 'Decoration only' })).toBeNull();
    expect(screen.getByTestId('alt-prompt').textContent).toContain(
      "The page can't be published without one.",
    );
  });
});

describe('a calendar element', () => {
  const calendar = (props: Record<string, unknown> = {}): CanvasNode => ({
    type: 'calendar',
    props: { id: 'booking', calendarId: null, look: {}, ...props },
  });

  it('offers the active calendars, and says a page needs one', async () => {
    const user = show(calendar());
    expect(screen.getByTestId('calendar-state').textContent).toBe(
      "Choose a calendar: the page can't be published without one.",
    );
    await user.click(screen.getByRole('combobox', { name: 'Calendar' }));
    await screen.findByRole('option', { name: 'Intro call' });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No calendar chosen',
      'Intro call',
      'Yearly review',
    ]);
    await user.click(await screen.findByRole('option', { name: 'Yearly review' }));
    expect(sets).toStrictEqual([{ calendarId: 'cal_3' }]);
    expect(screen.queryByTestId('calendar-state')).toBeNull();
  });

  it('keeps an inactive or deleted choice in view, with why it cannot be published', async () => {
    const user = show(calendar({ calendarId: 'cal_2' }));
    expect(screen.getByTestId('calendar-state').textContent).toContain(
      '"Site visit" is not active, so it takes no bookings.',
    );
    await user.click(screen.getByRole('combobox', { name: 'Calendar' }));
    expect(await screen.findByRole('option', { name: 'Site visit (not active)' })).toBeTruthy();
    await user.click(await screen.findByRole('option', { name: 'No calendar chosen' }));
    expect(sets).toStrictEqual([{ calendarId: null }]);
    cleanup();
    show(calendar({ calendarId: 'cal_9' }));
    expect(screen.getByTestId('calendar-state').textContent).toContain(
      'The calendar chosen here was deleted.',
    );
  });

  it('says where to make a calendar when the business has no active one', () => {
    show(calendar(), { ...facts, calendars: [{ id: 'cal_2', name: 'Site visit', active: false }] });
    expect(
      screen.getByText('This business has no active calendar yet. Make one under Calendars.'),
    ).toBeTruthy();
  });

  it('gives the button its own words, or leaves the page’s', () => {
    show(calendar({ calendarId: 'cal_1' }));
    expect(screen.getByText('Left empty, the button says "Book a time".')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Button label'), {
      target: { value: 'Book your visit' },
    });
    expect(sets.at(-1)).toStrictEqual({ label: 'Book your visit' });
    fireEvent.change(screen.getByLabelText('Button label'), { target: { value: ' ' } });
    expect(sets.at(-1)).toStrictEqual({ label: undefined });
    expect(latest.props).not.toHaveProperty('label');
  });
});

describe('when a popup opens', () => {
  const popup = (props: Record<string, unknown> = {}): CanvasNode => ({
    type: 'popup',
    props: {
      id: 'offer',
      name: 'Offer',
      trigger: 'none',
      delaySeconds: 0,
      width: 'medium',
      rows: [],
      look: {},
      ...props,
    },
  });

  it('opens from a link only until told otherwise, then after a delay, once in a visit', async () => {
    const user = show(popup());
    expect(screen.queryByLabelText('Delay (seconds)')).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Once in a visit' })).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Opens' }));
    await user.click(await screen.findByRole('option', { name: 'By itself, after a delay' }));
    expect(sets.at(-1)).toStrictEqual({ trigger: 'delay', delaySeconds: 5, frequency: undefined });
    fireEvent.change(screen.getByLabelText('Delay (seconds)'), { target: { value: '12' } });
    expect(sets.at(-1)).toMatchObject({ trigger: 'delay', delaySeconds: 12 });
    const once = screen.getByRole('switch', { name: 'Once in a visit' });
    expect(once.getAttribute('aria-checked')).toBe('true');
    await user.click(once);
    expect(sets.at(-1)).toStrictEqual({ trigger: 'delay', delaySeconds: 12, frequency: 'always' });
    expect(screen.getByText('It opens by itself every time a page with it is shown.')).toBeTruthy();
    expect(latest.props).toMatchObject({ trigger: 'delay', delaySeconds: 12, frequency: 'always' });
  });

  it('opens when the visitor is about to leave, and says what that means on a phone', async () => {
    const user = show(popup());
    await user.click(screen.getByRole('combobox', { name: 'Opens' }));
    await user.click(
      await screen.findByRole('option', { name: 'By itself, when the visitor is about to leave' }),
    );
    expect(sets.at(-1)).toMatchObject({ trigger: 'exit' });
    expect(screen.getByText(/A phone has no pointer/)).toBeTruthy();
    expect(screen.queryByLabelText('Delay (seconds)')).toBeNull();
    expect(screen.queryByTestId('popup-script-off')).toBeNull();
  });

  it('says so where this install cannot open a popup by itself', () => {
    show(popup({ trigger: 'delay', delaySeconds: 5 }), {
      ...facts,
      scripts: { countdown: false, popup: false },
    });
    expect(screen.getByTestId('popup-script-off').textContent).toContain(
      'opens from a link or a button only',
    );
    cleanup();
    // Nothing is said of a popup that opens from a link anyway, or while it is not known.
    show(popup(), { ...facts, scripts: { countdown: false, popup: false } });
    expect(screen.queryByTestId('popup-script-off')).toBeNull();
    cleanup();
    show(popup({ trigger: 'delay', delaySeconds: 5 }), { ...facts, scripts: null });
    expect(screen.queryByTestId('popup-script-off')).toBeNull();
  });
});

describe('what stands in the way of an element', () => {
  it('is said at the element, by the id the saved page knows it by', () => {
    const problems = new Map([
      [
        'booking',
        [
          { message: 'Choose a calendar for this calendar element.', blocking: true },
          { message: 'A second thing.', blocking: false },
        ],
      ],
      // A node the canvas named itself is known to a saved page by a shortened id.
      [
        'n3f2504e04f8941d39a0c0305e82c3301',
        [{ message: 'This image has no picture yet.', blocking: true }],
      ],
    ]);
    const at = (id: string): string =>
      render(
        <NodeProblemsContext value={problems}>
          <ElementProblems id={id} />
        </NodeProblemsContext>,
      ).container.textContent;
    expect(at('booking')).toBe('Choose a calendar for this calendar element.A second thing.');
    expect(at('image-3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('This image has no picture yet.');
    expect(at('title')).toBe('');
    // What stops the page and what is only worth a look are told apart.
    cleanup();
    render(
      <NodeProblemsContext value={problems}>
        <ElementProblems id="booking" />
      </NodeProblemsContext>,
    );
    expect(
      screen.getAllByRole('listitem').map((item) => item.getAttribute('data-blocking')),
    ).toEqual(['true', 'false']);
  });
});
