// The panel of the selected element: what it says and does (its own props), and how it
// looks on the device being edited (its `look`: device.ts). One set of fields for each of
// the thirteen element types of the page document, and for a section, a row, a column, a
// popup and the page itself. Text is edited as runs, never as HTML. A change is one call to
// the canvas (canvas-api.ts); nothing here knows which canvas that is.
//
// A picture, wherever a page has one (an image element, a background, the page's picture
// for social sharing), is typed, pasted or chosen from Media Storage (picture-field.tsx).
//
// Left out on purpose, because nothing a published page does reads them yet: an image's
// "optimize" switch, a font by name (no font is loaded for a page), and the page's head
// and body code. Their stored values ride through untouched.
import { Trans, useLingui } from '@lingui/react/macro';
import type { PageAction, PageStyle, PageText } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  ArrowDown,
  ArrowUp,
  Bold,
  Italic,
  Plus,
  Strikethrough,
  Trash2,
  Underline,
} from 'lucide-react';
import { createContext, use, useState, type ReactElement, type ReactNode } from 'react';
import { useCanvas, useCanvasActions, useDevice } from './canvas-api';
import { isOwnValue, setHidden, setStyle, styleOn, type Device, type Look } from './device';
import { documentId, type CanvasNode } from './document-map';
import {
  calendarStateOf,
  DEFAULT_CALENDAR_LABEL,
  MAX_DELAY_SECONDS,
  openingOf,
  openingPatch,
  type CalendarChoice,
  type ElementProblem,
} from './element-rules';
import { ImageFields } from './image-fields';
import { PictureField } from './picture-field';
import {
  AddressBox,
  Choice,
  ColorBox,
  EdgesBox,
  Group,
  LengthBox,
  NumberBox,
  smallLabelClassName,
  SwitchRow,
  TextBox,
  type ChoiceOption,
} from './field-parts';

/** What the fields need to know from outside the page. */
export interface EditorFacts {
  readonly funnel: boolean;
  /** The forms of the business, for the form element's picker. */
  readonly forms: readonly {
    readonly id: string;
    readonly name: string;
    readonly published: boolean;
  }[];
  /** The calendars of the business, for the calendar element's picker. */
  readonly calendars: readonly CalendarChoice[];
  /**
   * Which of its small page scripts this install has to send (`getSitePublicStatus`): a
   * countdown that ticks, popups that open by themselves. Null while that is not known.
   */
  readonly scripts: { readonly countdown: boolean; readonly popup: boolean } | null;
  /** The steps of the site, for a link to one of them. */
  readonly steps: readonly { readonly id: string; readonly name: string }[];
  /** Whether the funnel has a step after this one, for "the next step". */
  readonly hasNextStep: boolean;
  /** What a published page does not do yet for an element type, in the server's words. */
  readonly notes: ReadonlyMap<string, string>;
}
export const EditorFactsContext = createContext<EditorFacts>({
  funnel: true,
  forms: [],
  calendars: [],
  scripts: null,
  steps: [],
  hasNextStep: false,
  notes: new Map(),
});

const toggleClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-input text-body -outline-offset-2 hover:bg-muted aria-pressed:border-primary aria-pressed:bg-accent aria-pressed:text-link lg:size-8';
const iconClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 lg:size-8';
const noteClassName = 'rounded-control bg-secondary px-3 py-2 text-xs leading-normal text-body';
const promptClassName =
  'rounded-control bg-attention px-3 py-2 text-xs leading-normal text-attention-foreground';

/** What a published page does not do yet for this kind of element, when there is something. */
export function ElementNote({ type }: { readonly type: string }): ReactElement | null {
  const note = use(EditorFactsContext).notes.get(type);
  return note === undefined ? null : <p className={noteClassName}>{note}</p>;
}

/**
 * What is wrong with each element, by the id the saved page knows it by: what the page as
 * it stands cannot be saved with, and what the server found in the way of publishing.
 */
export const NodeProblemsContext = createContext<ReadonlyMap<string, readonly ElementProblem[]>>(
  new Map(),
);

/**
 * What stands in the way of this element, said at the element itself: what stops the page
 * being saved or published as a problem, and what is only worth a look as a note.
 */
export function ElementProblems({ id }: { readonly id: string }): ReactElement | null {
  const problems = use(NodeProblemsContext).get(documentId(id));
  if (problems === undefined || problems.length === 0) return null;
  return (
    <ul data-testid="element-problems" className="flex min-w-0 list-none flex-col gap-1.5">
      {problems.map((problem) => (
        <li
          key={problem.message}
          data-blocking={problem.blocking}
          className={
            problem.blocking
              ? 'rounded-control border border-destructive px-3 py-2 text-xs leading-normal font-medium wrap-anywhere text-destructive'
              : `${noteClassName} wrap-anywhere`
          }
        >
          {problem.message}
        </li>
      ))}
    </ul>
  );
}

const NONE: PageAction = { type: 'none' };

/** Where pressing something leads: nowhere, an address, a step, a popup or a section. */
export function ActionField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: PageAction | undefined;
  readonly onChange: (action: PageAction) => void;
}): ReactElement {
  const { t } = useLingui();
  const { funnel, steps, hasNextStep } = use(EditorFactsContext);
  const { data } = useCanvas();
  const action = value ?? NONE;
  // "Web address" is chosen before an address is typed; the page gets the link once there
  // is an address, so a half-made link is never part of the page.
  const [typing, setTyping] = useState(false);
  const kind = typing && action.type === 'none' ? 'url' : action.type;
  const popups = data.root.props.popups.map((popup) => ({
    value: popup.props.id,
    label: typeof popup.props['name'] === 'string' ? popup.props['name'] : popup.props.id,
  }));
  const sections = data.root.props.sections.map((section, at) => {
    const name = section.props['name'];
    const place = at + 1;
    return {
      value: section.props.id,
      label: typeof name === 'string' && name !== '' ? name : t`Section ${place}`,
    };
  });
  const kinds: ChoiceOption<PageAction['type']>[] = [
    { value: 'none', label: t`Nothing` },
    { value: 'url', label: t`A web address` },
    ...(funnel ? [{ value: 'next_step' as const, label: t`The next step of the funnel` }] : []),
    ...(steps.length > 0
      ? [
          {
            value: 'step' as const,
            label: funnel ? t`A step of this funnel` : t`A page of this website`,
          },
        ]
      : []),
    ...(popups.length > 0 ? [{ value: 'popup' as const, label: t`A popup of this page` }] : []),
    ...(sections.length > 0
      ? [{ value: 'anchor' as const, label: t`A section of this page` }]
      : []),
  ];
  const choose = (next: PageAction['type']): void => {
    setTyping(next === 'url');
    if (next === 'none' || next === 'url') {
      if (action.type !== 'none' && (next === 'none' || action.type !== 'url')) onChange(NONE);
      return;
    }
    if (next === 'next_step') onChange({ type: 'next_step' });
    else if (next === 'step') {
      const first = steps[0];
      if (first !== undefined) onChange({ type: 'step', stepId: first.id });
    } else if (next === 'popup') {
      const first = popups[0];
      if (first !== undefined) onChange({ type: 'popup', popupId: first.value });
    } else {
      const first = sections[0];
      if (first !== undefined) onChange({ type: 'anchor', sectionId: first.value });
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Choice label={label} value={kind} options={kinds} onChange={choose} />
      {kind === 'url' ? (
        <>
          <AddressBox
            label={t`Address`}
            kind="link"
            value={action.type === 'url' ? action.href : null}
            onChange={(href) => {
              if (href === null) onChange(NONE);
              else
                onChange({
                  type: 'url',
                  href,
                  newTab: action.type === 'url' ? action.newTab : false,
                });
            }}
          />
          {action.type === 'url' ? (
            <SwitchRow
              label={t`Open in a new tab`}
              checked={action.newTab}
              onChange={(newTab) => {
                onChange({ ...action, newTab });
              }}
            />
          ) : null}
        </>
      ) : null}
      {action.type === 'next_step' && !hasNextStep ? (
        <p className={noteClassName}>
          <Trans>This is the funnel's last step, so there is no next step to go to yet.</Trans>
        </p>
      ) : null}
      {action.type === 'step' ? (
        <Choice
          label={funnel ? t`Step` : t`Page`}
          value={action.stepId}
          options={[
            ...steps.map((step) => ({ value: step.id, label: step.name })),
            ...(steps.some((step) => step.id === action.stepId)
              ? []
              : [{ value: action.stepId, label: t`One that is no longer here` }]),
          ]}
          onChange={(stepId) => {
            onChange({ type: 'step', stepId });
          }}
        />
      ) : null}
      {action.type === 'popup' ? (
        <Choice
          label={t`Popup`}
          value={action.popupId}
          options={popups}
          onChange={(popupId) => {
            onChange({ type: 'popup', popupId });
          }}
        />
      ) : null}
      {action.type === 'anchor' ? (
        <Choice
          label={t`Section`}
          value={action.sectionId}
          options={sections}
          onChange={(sectionId) => {
            onChange({ type: 'anchor', sectionId });
          }}
        />
      ) : null}
    </div>
  );
}

type Run = PageText[number];

/**
 * An element's text as the document keeps it: runs, never HTML. Most text is one run; a
 * word that is bold, coloured or a link is a run of its own ("part").
 */
export function RunsField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: PageText | undefined;
  readonly onChange: (text: PageText) => void;
}): ReactElement {
  const { t } = useLingui();
  const runs = Array.isArray(value) ? value : [];
  const change = (index: number, patch: Partial<Run>): void => {
    onChange(
      runs.map((run, at) => {
        if (at !== index) return run;
        const next: Record<string, unknown> = { ...run, ...patch };
        // A look that is off is not kept: a page edited and put back is the page it was.
        for (const [key, each] of Object.entries(patch))
          if (each === false || each === undefined) Reflect.deleteProperty(next, key);
        return next as Run;
      }),
    );
  };
  const several = runs.length > 1;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className={smallLabelClassName}>{label}</legend>
      {runs.map((run, index) => {
        const part = index + 1;
        const name = several ? t`${label}, part ${part}` : label;
        const toggle = (
          key: 'bold' | 'italic' | 'underline' | 'strike',
          title: string,
          icon: ReactNode,
        ): ReactElement => (
          <button
            type="button"
            className={toggleClassName}
            aria-pressed={run[key] === true}
            aria-label={several ? t`${title}, part ${part}` : title}
            title={title}
            onClick={() => {
              change(index, { [key]: run[key] !== true });
            }}
          >
            {icon}
          </button>
        );
        return (
          // eslint-disable-next-line @eslint-react/no-array-index-key -- runs have no id; their order is their identity
          <div key={index} className="flex min-w-0 flex-col gap-1.5">
            <textarea
              aria-label={name}
              rows={2}
              maxLength={20000}
              className="w-full min-w-0 resize-y rounded-control border border-input bg-card px-3 py-2 text-md text-foreground"
              value={run.text}
              onChange={(event) => {
                change(index, { text: event.target.value });
              }}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {toggle('bold', t`Bold`, <Bold aria-hidden className="size-4" strokeWidth={2} />)}
              {toggle(
                'italic',
                t`Italic`,
                <Italic aria-hidden className="size-4" strokeWidth={2} />,
              )}
              {toggle(
                'underline',
                t`Underline`,
                <Underline aria-hidden className="size-4" strokeWidth={2} />,
              )}
              {toggle(
                'strike',
                t`Strikethrough`,
                <Strikethrough aria-hidden className="size-4" strokeWidth={2} />,
              )}
              {several ? (
                <button
                  type="button"
                  className={iconClassName}
                  aria-label={t`Remove part ${part}`}
                  title={t`Remove this part`}
                  onClick={() => {
                    onChange(runs.filter((_, at) => at !== index));
                  }}
                >
                  <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
            <details className="min-w-0">
              <summary className="cursor-pointer text-xs font-medium text-link -outline-offset-2">
                {several ? (
                  <Trans>Colour and link of part {part}</Trans>
                ) : (
                  <Trans>Colour and link</Trans>
                )}
              </summary>
              <div className="flex min-w-0 flex-col gap-2 pt-2">
                <ColorBox
                  label={several ? t`Colour of part ${part}` : t`Text colour of this part`}
                  value={run.color}
                  onChange={(color) => {
                    change(index, { color });
                  }}
                />
                <ActionField
                  label={several ? t`Part ${part} links to` : t`This text links to`}
                  value={run.link}
                  onChange={(link) => {
                    change(index, { link: link.type === 'none' ? undefined : link });
                  }}
                />
              </div>
            </details>
          </div>
        );
      })}
      <Button
        variant="secondary"
        size="small"
        className="self-start"
        onClick={() => {
          onChange([...runs, { text: '' }]);
        }}
      >
        <Plus aria-hidden className="size-4" strokeWidth={2} />
        <Trans>Add a part</Trans>
      </Button>
    </fieldset>
  );
}

/** The points of a bullet list: each a text of its own, in an order that can be changed. */
function ItemsField({
  value,
  onChange,
}: {
  readonly value: readonly PageText[] | undefined;
  readonly onChange: (items: PageText[]) => void;
}): ReactElement {
  const { t } = useLingui();
  const items = value ?? [];
  const moved = (from: number, to: number): PageText[] => {
    const next = [...items];
    const [item] = next.splice(from, 1);
    if (item !== undefined) next.splice(to, 0, item);
    return next;
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {items.map((item, index) => {
        const place = index + 1;
        return (
          <div
            // eslint-disable-next-line @eslint-react/no-array-index-key -- items have no id; their order is their identity
            key={index}
            className="flex min-w-0 flex-col gap-1 rounded-control border border-border p-2"
          >
            <RunsField
              label={t`Point ${place}`}
              value={item}
              onChange={(text) => {
                onChange(items.map((each, at) => (at === index ? text : each)));
              }}
            />
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                className={iconClassName}
                aria-label={t`Move point ${place} up`}
                disabled={index === 0}
                onClick={() => {
                  onChange(moved(index, index - 1));
                }}
              >
                <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={iconClassName}
                aria-label={t`Move point ${place} down`}
                disabled={index === items.length - 1}
                onClick={() => {
                  onChange(moved(index, index + 1));
                }}
              >
                <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={iconClassName}
                aria-label={t`Remove point ${place}`}
                // A list keeps at least one point: the contract refuses an empty one.
                disabled={items.length <= 1}
                onClick={() => {
                  onChange(items.filter((_, at) => at !== index));
                }}
              >
                <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
              </button>
            </div>
          </div>
        );
      })}
      {items.length >= 100 ? (
        <p className={noteClassName}>
          <Trans>A list holds at most 100 points.</Trans>
        </p>
      ) : (
        <Button
          variant="secondary"
          size="small"
          className="self-start"
          onClick={() => {
            onChange([...items, [{ text: '' }]]);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
          <Trans>Add a point</Trans>
        </Button>
      )}
    </div>
  );
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean => value === true;

/** A moment as the browser's own date-and-time box takes it, in the reader's own time zone. */
function localMoment(iso: string | null): string {
  if (iso === null) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type WhenOver =
  | { readonly type: 'hide' }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'url'; readonly href: string };

function CountdownFields({ node }: { readonly node: CanvasNode }): ReactElement {
  const { t } = useLingui();
  const { setProps } = useCanvasActions();
  const { props } = node;
  const whenOver = props['whenOver'] as WhenOver | undefined;
  // "A link" is chosen before its address is typed; the page gets the link once there is
  // an address, so a half-made link is never part of the page.
  const [typing, setTyping] = useState(false);
  const kind = typing && whenOver?.type !== 'url' ? 'url' : (whenOver?.type ?? 'hide');
  const endsAt = typeof props['endsAt'] === 'string' ? props['endsAt'] : null;
  const set = (next: WhenOver): void => {
    setProps(props.id, { whenOver: next });
  };
  return (
    <>
      <label className={`flex min-w-0 flex-col gap-1 ${smallLabelClassName}`}>
        <Trans>Ends at (your time)</Trans>
        <input
          type="datetime-local"
          className="min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-3 text-md font-normal text-foreground lg:min-h-9"
          value={localMoment(endsAt)}
          onChange={(event) => {
            const typed = new Date(event.target.value);
            setProps(props.id, {
              endsAt: Number.isNaN(typed.getTime()) ? null : typed.toISOString(),
            });
          }}
        />
      </label>
      <Choice
        label={t`When it is over`}
        value={kind}
        options={[
          { value: 'hide', label: t`Show nothing` },
          { value: 'text', label: t`Show a line of text` },
          { value: 'url', label: t`Show a link to go on` },
        ]}
        onChange={(next) => {
          setTyping(next === 'url');
          if (next === 'text') set({ type: 'text', text: '' });
          else if (next === 'hide' || whenOver?.type !== 'url') set({ type: 'hide' });
        }}
      />
      {whenOver?.type === 'text' ? (
        <TextBox
          label={t`Text`}
          value={whenOver.text}
          maxLength={500}
          onChange={(text) => {
            set({ type: 'text', text });
          }}
        />
      ) : null}
      {kind === 'url' ? (
        <AddressBox
          label={t`Address`}
          kind="link"
          value={whenOver?.type === 'url' ? whenOver.href : null}
          onChange={(href) => {
            set(href === null ? { type: 'hide' } : { type: 'url', href });
          }}
        />
      ) : null}
    </>
  );
}

/** The calendar a calendar element links to, and what its link says. */
function CalendarFields({ node }: { readonly node: CanvasNode }): ReactElement {
  const { t } = useLingui();
  const { setProps } = useCanvasActions();
  const { calendars } = use(EditorFactsContext);
  const { props } = node;
  const chosen = typeof props['calendarId'] === 'string' ? props['calendarId'] : '';
  const state = calendarStateOf(
    chosen,
    new Map(calendars.map((calendar) => [calendar.id, calendar])),
  );
  const active = calendars.filter((calendar) => calendar.active);
  const inactiveName = state.at === 'inactive' ? state.name : '';
  return (
    <>
      <Choice
        label={t`Calendar`}
        value={chosen}
        options={[
          { value: '', label: t`No calendar chosen` },
          ...active.map((calendar) => ({ value: calendar.id, label: calendar.name })),
          // What is chosen stays in the list while it is chosen, so it can be seen and changed.
          ...(state.at === 'inactive'
            ? [{ value: chosen, label: t`${inactiveName} (not active)` }]
            : state.at === 'gone'
              ? [{ value: chosen, label: t`One that is no longer here` }]
              : []),
        ]}
        onChange={(calendarId) => {
          setProps(props.id, { calendarId: calendarId === '' ? null : calendarId });
        }}
        hint={
          active.length === 0 ? (
            <Trans>This business has no active calendar yet. Make one under Calendars.</Trans>
          ) : (
            <Trans>
              The page shows a button that opens this calendar's own booking page. Only active
              calendars are listed.
            </Trans>
          )
        }
      />
      {state.at === 'inactive' ? (
        <p className={promptClassName} data-testid="calendar-state">
          <Trans>
            "{inactiveName}" is not active, so it takes no bookings. Make it active under Calendars,
            or choose another: the page can't be published with it.
          </Trans>
        </p>
      ) : state.at === 'gone' ? (
        <p className={promptClassName} data-testid="calendar-state">
          <Trans>
            The calendar chosen here was deleted. Choose another: the page can't be published with
            it.
          </Trans>
        </p>
      ) : state.at === 'none' ? (
        <p className={promptClassName} data-testid="calendar-state">
          <Trans>Choose a calendar: the page can't be published without one.</Trans>
        </p>
      ) : null}
      <TextBox
        label={t`Button label`}
        value={typeof props['label'] === 'string' ? props['label'] : ''}
        maxLength={200}
        onChange={(label) => {
          setProps(props.id, { label: label.trim() === '' ? undefined : label });
        }}
        hint={<Trans>Left empty, the button says "{DEFAULT_CALENDAR_LABEL}".</Trans>}
      />
    </>
  );
}

/** When a popup opens: from a link or a button only, or also by itself. */
function PopupOpeningFields({ node }: { readonly node: CanvasNode }): ReactElement {
  const { t } = useLingui();
  const { setProps } = useCanvasActions();
  const { scripts } = use(EditorFactsContext);
  const { props } = node;
  const opening = openingOf(props);
  return (
    <>
      <Choice
        label={t`Opens`}
        value={opening.trigger}
        options={[
          { value: 'none', label: t`Only from a link or a button` },
          { value: 'delay', label: t`By itself, after a delay` },
          { value: 'exit', label: t`By itself, when the visitor is about to leave` },
        ]}
        onChange={(trigger) => {
          setProps(props.id, openingPatch(props, { trigger }));
        }}
        hint={
          opening.trigger === 'exit' ? (
            <Trans>
              When the pointer leaves the top of the page. A phone has no pointer, so there it opens
              from a link or a button only.
            </Trans>
          ) : (
            <Trans>A link or a button that goes to this popup opens it in any case.</Trans>
          )
        }
      />
      {opening.trigger === 'delay' ? (
        <NumberBox
          label={t`Delay (seconds)`}
          value={opening.delaySeconds}
          min={0}
          max={MAX_DELAY_SECONDS}
          required
          onChange={(delaySeconds) => {
            if (delaySeconds !== undefined)
              setProps(props.id, openingPatch(props, { delaySeconds }));
          }}
        />
      ) : null}
      {opening.trigger === 'none' ? null : (
        <SwitchRow
          label={t`Once in a visit`}
          checked={opening.frequency === 'session'}
          onChange={(once) => {
            setProps(props.id, openingPatch(props, { frequency: once ? 'session' : 'always' }));
          }}
          hint={
            opening.frequency === 'session' ? (
              <Trans>
                It opens by itself once, then not again until the visitor closes the tab.
              </Trans>
            ) : (
              <Trans>It opens by itself every time a page with it is shown.</Trans>
            )
          }
        />
      )}
      {scripts?.popup === false && opening.trigger !== 'none' ? (
        <p className={promptClassName} data-testid="popup-script-off">
          <Trans>
            This install's server was built without the page scripts, so on its pages this popup
            opens from a link or a button only.
          </Trans>
        </p>
      ) : null}
    </>
  );
}

/** What an element says and does: its own props, kind by kind. */
function ContentFields({ node }: { readonly node: CanvasNode }): ReactElement | null {
  const { t } = useLingui();
  const { setProps } = useCanvasActions();
  const facts = use(EditorFactsContext);
  const { props } = node;
  const id = props.id;
  const set = (patch: Readonly<Record<string, unknown>>): void => {
    setProps(id, patch);
  };
  switch (node.type) {
    case 'headline':
    case 'sub_headline':
      return (
        <>
          <RunsField
            label={t`Text`}
            value={props['text'] as PageText | undefined}
            onChange={(text) => {
              set({ text });
            }}
          />
          <Choice
            label={t`Heading level`}
            value={String(num(props['level']) ?? 2)}
            options={[1, 2, 3, 4, 5, 6].map((level) => ({
              value: String(level),
              label: t`Heading ${level}`,
            }))}
            onChange={(level) => {
              set({ level: Number(level) });
            }}
            hint={
              <Trans>
                One "Heading 1" a page, then 2, 3 in order, helps people who have the page read out.
              </Trans>
            }
          />
        </>
      );
    case 'paragraph':
      return (
        <RunsField
          label={t`Text`}
          value={props['text'] as PageText | undefined}
          onChange={(text) => {
            set({ text });
          }}
        />
      );
    case 'bullet_list':
      return (
        <>
          <Choice
            label={t`Marker`}
            value={str(props['marker']) || 'disc'}
            options={[
              { value: 'disc', label: t`Dots` },
              { value: 'number', label: t`Numbers` },
              { value: 'check', label: t`Ticks` },
              { value: 'none', label: t`None` },
            ]}
            onChange={(marker) => {
              set({ marker });
            }}
          />
          <ItemsField
            value={props['items'] as readonly PageText[] | undefined}
            onChange={(items) => {
              set({ items });
            }}
          />
        </>
      );
    case 'image':
      return (
        <ImageFields
          node={node}
          action={(value, onChange) => (
            <ActionField label={t`Pressing the image goes to`} value={value} onChange={onChange} />
          )}
        />
      );
    case 'video': {
      const source = str(props['source']) || 'youtube';
      return (
        <>
          <Choice
            label={t`Video from`}
            value={source}
            options={[
              // eslint-disable-next-line lingui/no-unlocalized-strings -- the name of a service, the same in every language
              { value: 'youtube', label: 'YouTube' },
              // eslint-disable-next-line lingui/no-unlocalized-strings -- the name of a service, the same in every language
              { value: 'vimeo', label: 'Vimeo' },
              { value: 'file', label: t`A video file` },
            ]}
            onChange={(next) => {
              set({ source: next });
            }}
          />
          <AddressBox
            label={t`Video address`}
            kind="media"
            value={typeof props['url'] === 'string' ? props['url'] : null}
            onChange={(url) => {
              set({ url });
            }}
          />
          <SwitchRow
            label={t`Start by itself`}
            checked={flag(props['autoplay'])}
            onChange={(autoplay) => {
              set({ autoplay });
            }}
          />
          <SwitchRow
            label={t`Show the player's controls`}
            checked={flag(props['controls'])}
            onChange={(controls) => {
              set({ controls });
            }}
          />
          <SwitchRow
            label={t`Start without sound`}
            checked={flag(props['muted'])}
            onChange={(muted) => {
              set({ muted });
            }}
          />
          <SwitchRow
            label={t`Play again when it ends`}
            checked={flag(props['loop'])}
            onChange={(loop) => {
              set({ loop });
            }}
          />
        </>
      );
    }
    case 'button': {
      const label = str(props['label']);
      return (
        <>
          <TextBox
            label={t`Label`}
            value={label}
            maxLength={200}
            onChange={(next) => {
              set({ label: next });
            }}
            accepts={(text) => text !== ''}
            refusal={<Trans>A button needs a label.</Trans>}
          />
          <TextBox
            label={t`Second line`}
            value={str(props['subLabel'])}
            maxLength={200}
            onChange={(subLabel) => {
              set({ subLabel });
            }}
          />
          <ActionField
            label={t`Pressing the button goes to`}
            value={props['action'] as PageAction | undefined}
            onChange={(action) => {
              set({ action });
            }}
          />
        </>
      );
    }
    case 'divider':
      return (
        <>
          <NumberBox
            label={t`Thickness (px)`}
            value={num(props['thickness'])}
            min={1}
            max={50}
            required
            onChange={(thickness) => {
              if (thickness !== undefined) set({ thickness });
            }}
          />
          <Choice
            label={t`Line`}
            value={str(props['line']) || 'solid'}
            options={[
              { value: 'solid', label: t`Solid` },
              { value: 'dashed', label: t`Dashed` },
              { value: 'dotted', label: t`Dotted` },
            ]}
            onChange={(line) => {
              set({ line });
            }}
          />
          <ColorBox
            label={t`Line colour`}
            value={typeof props['color'] === 'string' ? props['color'] : undefined}
            onChange={(color) => {
              set({ color: color ?? null });
            }}
          />
        </>
      );
    case 'form': {
      const chosen = typeof props['formId'] === 'string' ? props['formId'] : '';
      const known = facts.forms.some((form) => form.id === chosen);
      return (
        <Choice
          label={t`Form`}
          value={chosen}
          options={[
            { value: '', label: t`No form chosen` },
            ...facts.forms.map((form) => {
              const formName = form.name;
              return {
                value: form.id,
                label: form.published ? form.name : t`${formName} (not published)`,
              };
            }),
            ...(chosen === '' || known
              ? []
              : [{ value: chosen, label: t`One that is no longer here` }]),
          ]}
          onChange={(formId) => {
            set({ formId: formId === '' ? null : formId });
          }}
          hint={
            facts.forms.length === 0 ? (
              <Trans>This business has no forms yet. Make one under Sites, Forms.</Trans>
            ) : (
              <Trans>A page can be published only with a form that is itself published.</Trans>
            )
          }
        />
      );
    }
    case 'calendar':
      return <CalendarFields node={node} />;
    case 'countdown':
      return <CountdownFields node={node} />;
    case 'custom_code':
      return (
        <TextBox
          label={t`HTML and JavaScript`}
          value={str(props['code'])}
          maxLength={50000}
          multiline
          mono
          onChange={(code) => {
            set({ code });
          }}
        />
      );
    case 'container':
      return (
        <>
          <Choice
            label={t`What is inside lies`}
            value={str(props['direction']) || 'vertical'}
            options={[
              { value: 'vertical', label: t`One under the other` },
              { value: 'horizontal', label: t`Side by side` },
            ]}
            onChange={(direction) => {
              set({ direction });
            }}
          />
          <NumberBox
            label={t`Space between (px)`}
            value={num(props['gap'])}
            min={0}
            max={200}
            required
            onChange={(gap) => {
              if (gap !== undefined) set({ gap });
            }}
          />
        </>
      );
    case 'section':
      return (
        <>
          <TextBox
            label={t`Name`}
            value={str(props['name'])}
            maxLength={120}
            onChange={(name) => {
              set({ name: name === '' ? undefined : name });
            }}
            hint={<Trans>Only shown here, in the editor, to tell sections apart.</Trans>}
          />
          <Choice
            label={t`Content width`}
            value={str(props['width']) || 'full'}
            options={[
              { value: 'full', label: t`Full width` },
              { value: 'wide', label: t`Wide (1280 px)` },
              { value: 'medium', label: t`Medium (960 px)` },
              { value: 'small', label: t`Small (640 px)` },
            ]}
            onChange={(width) => {
              set({ width });
            }}
          />
        </>
      );
    case 'column':
      return (
        <NumberBox
          label={t`Width, in twelfths of the row`}
          value={num(props['span'])}
          min={1}
          max={12}
          required
          onChange={(span) => {
            if (span !== undefined) set({ span });
          }}
        />
      );
    case 'popup': {
      const name = str(props['name']);
      return (
        <>
          <TextBox
            label={t`Name`}
            value={name}
            maxLength={120}
            onChange={(next) => {
              set({ name: next });
            }}
            accepts={(text) => text.trim() !== ''}
            refusal={<Trans>A popup needs a name.</Trans>}
          />
          <Choice
            label={t`Width`}
            value={str(props['width']) || 'medium'}
            options={[
              { value: 'small', label: t`Small (400 px)` },
              { value: 'medium', label: t`Medium (640 px)` },
              { value: 'large', label: t`Large (960 px)` },
            ]}
            onChange={(width) => {
              set({ width });
            }}
          />
          <PopupOpeningFields node={node} />
        </>
      );
    }
    default:
      return null;
  }
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
/** A node's own class names, as the page document takes them: up to ten, single spaces between. */
const CLASS_NAMES = /^[A-Za-z_][A-Za-z0-9_-]{0,63}( [A-Za-z_][A-Za-z0-9_-]{0,63}){0,9}$/;
const UNSET = '';

/**
 * How a node looks on the device being edited. The desktop's value is the base; a tablet
 * and a phone show what they were handed down until they are given a value of their own,
 * which "Use the wider screen's" takes away again.
 */
function LookFields({ node }: { readonly node: CanvasNode }): ReactElement {
  const { t } = useLingui();
  const { setProps } = useCanvasActions();
  const device = useDevice();
  const given = node.props['look'];
  const look: Look = typeof given === 'object' && given !== null ? given : {};
  const shown = styleOn(look, device);
  const deviceNames: Record<Device, string> = {
    desktop: t`desktop`,
    tablet: t`tablet`,
    mobile: t`mobile`,
  };
  const deviceName = deviceNames[device];
  const set = <Key extends keyof PageStyle>(key: Key, value: PageStyle[Key] | undefined): void => {
    setProps(node.props.id, { look: setStyle(look, device, key, value) });
  };
  /** Under a field on a narrower device: where its value comes from, and the way back. */
  const origin = (key: keyof PageStyle, label: string): ReactNode => {
    if (device === 'desktop') return null;
    if (isOwnValue(look, device, key))
      return (
        <button
          type="button"
          className="self-start text-xs font-medium text-link underline -outline-offset-2"
          aria-label={t`${label}: use the wider screen's value on ${deviceName}`}
          onClick={() => {
            set(key, undefined);
          }}
        >
          <Trans>Use the wider screen's</Trans>
        </button>
      );
    return shown[key] === undefined ? null : (
      <p className="text-xs text-muted-foreground">
        <Trans>From a wider screen</Trans>
      </p>
    );
  };
  const number = (
    key: 'fontSize' | 'lineHeight' | 'letterSpacing' | 'borderWidth' | 'borderRadius' | 'opacity',
    label: string,
    min: number,
    max: number,
    step = 1,
  ): ReactElement => (
    <div className="flex min-w-0 flex-col gap-1">
      <NumberBox
        label={label}
        value={shown[key]}
        min={min}
        max={max}
        step={step}
        onChange={(value) => {
          set(key, value);
        }}
      />
      {origin(key, label)}
    </div>
  );
  const choice = (
    key: 'textAlign' | 'textTransform' | 'borderStyle' | 'shadow' | 'align' | 'backgroundSize',
    label: string,
    options: readonly ChoiceOption<string>[],
  ): ReactElement => (
    <div className="flex min-w-0 flex-col gap-1">
      <Choice
        label={label}
        value={shown[key] ?? UNSET}
        options={[{ value: UNSET, label: t`Not set` }, ...options]}
        onChange={(value) => {
          // The options are the contract's own values for this property, or "not set".
          set(key, value === UNSET ? undefined : (value as PageStyle[typeof key]));
        }}
      />
      {origin(key, label)}
    </div>
  );
  const color = (
    key: 'textColor' | 'backgroundColor' | 'borderColor',
    label: string,
  ): ReactElement => (
    <div className="flex min-w-0 flex-col gap-1">
      <ColorBox
        label={label}
        value={shown[key]}
        onChange={(value) => {
          set(key, value);
        }}
      />
      {origin(key, label)}
    </div>
  );
  const length = (key: 'width' | 'maxWidth' | 'minHeight', label: string): ReactElement => (
    <div className="flex min-w-0 flex-col gap-1">
      <LengthBox
        label={label}
        value={shown[key]}
        onChange={(value) => {
          set(key, value);
        }}
      />
      {origin(key, label)}
    </div>
  );
  const edges = (key: 'margin' | 'padding', label: string, min: number): ReactElement => (
    <div className="flex min-w-0 flex-col gap-1">
      <EdgesBox
        label={label}
        value={shown[key]}
        min={min}
        onChange={(value) => {
          set(key, value);
        }}
      />
      {origin(key, label)}
    </div>
  );
  const weightLabel = t`Weight`;
  const backgroundLabel = t`Background image address`;
  return (
    <div data-testid="look-fields" data-device={device}>
      <p className="border-t border-border px-3 pt-3 text-xs text-muted-foreground">
        {device === 'desktop' ? (
          <Trans>
            The look below is the desktop's: tablets and phones follow it unless changed.
          </Trans>
        ) : (
          <Trans>
            The look below is for {deviceName} screens. What you change here leaves the wider
            screens as they are.
          </Trans>
        )}
      </p>
      <div className="px-3 py-3">
        <SwitchRow
          label={t`Hide on ${deviceName}`}
          checked={look.hidden?.[device] === true}
          onChange={(hide) => {
            setProps(node.props.id, { look: setHidden(look, device, hide) });
          }}
          hint={
            look.hidden?.[device] === true ? (
              <Trans>Drawn faint here so it can still be selected; visitors won't see it.</Trans>
            ) : undefined
          }
        />
      </div>
      <Group title={<Trans>Text</Trans>} open>
        {number('fontSize', t`Text size (px)`, 1, 400)}
        <div className="flex min-w-0 flex-col gap-1">
          <Choice
            label={weightLabel}
            value={shown.fontWeight === undefined ? UNSET : String(shown.fontWeight)}
            options={[
              { value: UNSET, label: t`Not set` },
              ...WEIGHTS.map((weight) => ({
                value: String(weight),
                label:
                  weight === 400
                    ? t`400 (normal)`
                    : weight === 700
                      ? t`700 (bold)`
                      : String(weight),
              })),
            ]}
            onChange={(value) => {
              set('fontWeight', value === UNSET ? undefined : Number(value));
            }}
          />
          {origin('fontWeight', weightLabel)}
        </div>
        {choice('textAlign', t`Alignment`, [
          { value: 'left', label: t`Left` },
          { value: 'center', label: t`Centre` },
          { value: 'right', label: t`Right` },
          { value: 'justify', label: t`Justified` },
        ])}
        {color('textColor', t`Text colour`)}
        {number('lineHeight', t`Line height`, 0.5, 5, 0.1)}
        {number('letterSpacing', t`Letter spacing (px)`, -10, 50, 0.5)}
        {choice('textTransform', t`Capitals`, [
          { value: 'none', label: t`As written` },
          { value: 'uppercase', label: t`ALL CAPITALS` },
          { value: 'lowercase', label: t`all lowercase` },
          { value: 'capitalize', label: t`First Letter Of Each Word` },
        ])}
      </Group>
      <Group title={<Trans>Spacing</Trans>}>
        {edges('padding', t`Padding (px)`, 0)}
        {edges('margin', t`Margin (px)`, -1000)}
      </Group>
      <Group title={<Trans>Background</Trans>}>
        {color('backgroundColor', t`Background colour`)}
        <div className="flex min-w-0 flex-col gap-1">
          <PictureField
            label={backgroundLabel}
            value={shown.backgroundImageUrl ?? null}
            pickerTitle={<Trans>Choose a background picture</Trans>}
            onChange={(value) => {
              set('backgroundImageUrl', value ?? undefined);
            }}
          />
          {origin('backgroundImageUrl', backgroundLabel)}
        </div>
        {choice('backgroundSize', t`Background image size`, [
          { value: 'cover', label: t`Cover the area` },
          { value: 'contain', label: t`Fit inside` },
          { value: 'auto', label: t`Its own size` },
        ])}
      </Group>
      <Group title={<Trans>Border and shadow</Trans>}>
        {number('borderWidth', t`Border width (px)`, 0, 50)}
        {choice('borderStyle', t`Border line`, [
          { value: 'none', label: t`None` },
          { value: 'solid', label: t`Solid` },
          { value: 'dashed', label: t`Dashed` },
          { value: 'dotted', label: t`Dotted` },
        ])}
        {color('borderColor', t`Border colour`)}
        {number('borderRadius', t`Rounded corners (px)`, 0, 1000)}
        {choice('shadow', t`Shadow`, [
          { value: 'none', label: t`None` },
          { value: 'small', label: t`Small` },
          { value: 'medium', label: t`Medium` },
          { value: 'large', label: t`Large` },
        ])}
      </Group>
      <Group title={<Trans>Size and place</Trans>}>
        {length('width', t`Width`)}
        {length('maxWidth', t`Widest`)}
        {length('minHeight', t`Least height`)}
        {choice('align', t`Place across its column`, [
          { value: 'start', label: t`Start` },
          { value: 'center', label: t`Centre` },
          { value: 'end', label: t`End` },
          { value: 'stretch', label: t`Stretched` },
        ])}
        {number('opacity', t`Opacity (0 to 1)`, 0, 1, 0.05)}
      </Group>
      <Group title={<Trans>Advanced</Trans>}>
        <TextBox
          label={t`Class names for custom CSS`}
          value={look.customClass ?? ''}
          maxLength={640}
          accepts={(text) => text === '' || CLASS_NAMES.test(text)}
          refusal={<Trans>Use up to ten class names separated by single spaces.</Trans>}
          onChange={(names) => {
            const next: Record<string, unknown> = { ...look, customClass: names };
            if (names === '') Reflect.deleteProperty(next, 'customClass');
            setProps(node.props.id, { look: next });
          }}
        />
      </Group>
    </div>
  );
}

/** Everything about the selected node: what it is, what it says, how it looks. */
export function NodeFields({ node }: { readonly node: CanvasNode }): ReactElement {
  if (node.type === 'saved_section')
    return (
      <p className={`mx-3 my-3 ${noteClassName}`}>
        <Trans>
          A saved section is kept once and shown on every page that uses it. It is changed where it
          is kept, not here.
        </Trans>
      </p>
    );
  return (
    <>
      <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
        <ElementProblems id={node.props.id} />
        <ElementNote type={node.type} />
        <ContentFields node={node} />
      </div>
      <LookFields node={node} />
    </>
  );
}

interface Settings {
  readonly seo: {
    readonly title: string;
    readonly description: string;
    readonly imageUrl: string | null;
    readonly [key: string]: unknown;
  };
  readonly background: {
    readonly color: string | null;
    readonly imageUrl: string | null;
    readonly size: string;
    readonly [key: string]: unknown;
  };
  readonly typography: {
    readonly textColor: string | null;
    readonly linkColor: string | null;
    readonly [key: string]: unknown;
  };
  readonly customCss: string;
  readonly [key: string]: unknown;
}

/** The page's own settings, shown while nothing is selected. */
export function PageFields(): ReactElement {
  const { t } = useLingui();
  const { data } = useCanvas();
  const { setSettings } = useCanvasActions();
  const settings = data.root.props.settings as Settings;
  const css = settings.customCss;
  return (
    <>
      <div className="flex min-w-0 flex-col gap-3 px-3 py-3">
        <p className="text-xs text-muted-foreground">
          <Trans>
            Select something on the page to change it. These are the page's own settings.
          </Trans>
        </p>
        <TextBox
          label={t`Title in the browser tab and in search results`}
          value={settings.seo.title}
          maxLength={200}
          onChange={(title) => {
            setSettings({ ...settings, seo: { ...settings.seo, title } });
          }}
          hint={<Trans>Left empty, the name of the step is used.</Trans>}
        />
        <TextBox
          label={t`Description for search results`}
          value={settings.seo.description}
          maxLength={500}
          multiline
          onChange={(description) => {
            setSettings({ ...settings, seo: { ...settings.seo, description } });
          }}
        />
        <PictureField
          label={t`Picture for social sharing`}
          value={settings.seo.imageUrl}
          pickerTitle={<Trans>Choose a picture for social sharing</Trans>}
          onChange={(imageUrl) => {
            setSettings({ ...settings, seo: { ...settings.seo, imageUrl } });
          }}
          hint={
            <Trans>
              Shown when the page's link is shared, on networks that show a picture. It needs a full
              web address (https://).
            </Trans>
          }
        />
      </div>
      <Group title={<Trans>Colours</Trans>} open>
        <ColorBox
          label={t`Page background`}
          value={settings.background.color ?? undefined}
          onChange={(color) => {
            setSettings({
              ...settings,
              background: { ...settings.background, color: color ?? null },
            });
          }}
        />
        <PictureField
          label={t`Page background picture`}
          value={settings.background.imageUrl}
          pickerTitle={<Trans>Choose a background picture</Trans>}
          onChange={(imageUrl) => {
            setSettings({ ...settings, background: { ...settings.background, imageUrl } });
          }}
        />
        {settings.background.imageUrl === null ? null : (
          <Choice
            label={t`Background picture size`}
            value={settings.background.size}
            options={[
              { value: 'cover', label: t`Cover the page` },
              { value: 'contain', label: t`Fit inside` },
              { value: 'auto', label: t`Its own size` },
            ]}
            onChange={(size) => {
              setSettings({ ...settings, background: { ...settings.background, size } });
            }}
          />
        )}
        <ColorBox
          label={t`Text colour`}
          value={settings.typography.textColor ?? undefined}
          onChange={(textColor) => {
            setSettings({
              ...settings,
              typography: { ...settings.typography, textColor: textColor ?? null },
            });
          }}
        />
        <ColorBox
          label={t`Link colour`}
          value={settings.typography.linkColor ?? undefined}
          onChange={(linkColor) => {
            setSettings({
              ...settings,
              typography: { ...settings.typography, linkColor: linkColor ?? null },
            });
          }}
        />
      </Group>
      <Group title={<Trans>Custom CSS</Trans>}>
        <TextBox
          label={t`CSS for this page`}
          value={css}
          maxLength={100000}
          multiline
          mono
          onChange={(customCss) => {
            setSettings({ ...settings, customCss });
          }}
          accepts={(text) => !text.includes('<')}
          refusal={<Trans>A stylesheet cannot contain "&lt;".</Trans>}
          hint={<Trans>Applied to the published page after its own styles.</Trans>}
        />
      </Group>
    </>
  );
}
