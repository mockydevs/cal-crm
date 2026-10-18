// How each node of a page is drawn in the canvas. The markup and the class names are the
// published page's (packages/site-render/src/render.ts: `hl`, `pg`, `bt`, `sc`, `rw`, `cl`, …),
// and the looks come from the renderer's own stylesheet rules (node-css.ts), so the canvas
// shows what a visitor gets. elements.test.tsx renders both and compares them.
//
// What differs, on purpose: a link has no address here (nothing in the canvas navigates); a
// merge field is shown as it is written; and what a published page shows through a script,
// a frame or not at all (a form, a video, a calendar, custom code, an image with no
// picture) is a labelled box, one element where the page has one. Tenant code is never
// drawn: the frame shares the dashboard's origin. Between a section and its rows, a row and
// its columns, a column and its elements stands the canvas's drop zone (`ez`), which
// node-css.ts gives the layout of what holds it.
//
// Nothing here imports the canvas library: a node's children arrive as a component (its
// slot), and the element to drag by as a ref.
import { Trans, useLingui } from '@lingui/react/macro';
import type { PageAction, PageText } from '@repo/contracts';
import { countdownText, mediaAddress, videoEmbedUrl } from '@repo/site-render';
import {
  createContext,
  Fragment,
  use,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Look } from './device';
import { calendarLabelOf, calendarStateOf, type CalendarChoice } from './element-rules';
import { nodeClass, runClass } from './node-css';
import { ELEMENT_TYPES, LEAF_TYPES } from './tree';

/** A node's children, as the canvas hands them to the node that holds them. */
export type SlotView = (props: {
  readonly className?: string;
  readonly minEmptyHeight?: number;
  readonly allow?: string[];
}) => ReactNode;

/** The element the canvas drags a node by: the node's own outermost element. */
export type DragRef = ((element: Element | null) => void) | null | undefined;

interface Base {
  readonly id: string;
  readonly look: Look | undefined;
  readonly dragRef?: DragRef;
}

/** The business's forms, by id: what a form element names the form it shows by. */
export type CanvasForms = ReadonlyMap<
  string,
  { readonly name: string; readonly published: boolean }
>;
export const CanvasFormsContext = createContext<CanvasForms>(new Map());

/** The business's calendars, by id: what a calendar element knows the one it links to by. */
export type CanvasCalendars = ReadonlyMap<string, CalendarChoice>;
export const CanvasCalendarsContext = createContext<CanvasCalendars>(new Map());

/**
 * Which zones already hold as many nodes as they may. A store, not a value: a node asks
 * about its own zone and is drawn again only when that answer changes, however often the
 * page does.
 */
export interface ZoneStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly isFull: (zone: string) => boolean;
}
export const ZoneStoreContext = createContext<ZoneStore>({
  subscribe: () => () => undefined,
  isFull: () => false,
});

function useZoneFull(zone: string): boolean {
  const store = use(ZoneStoreContext);
  const full = (): boolean => store.isFull(zone);
  return useSyncExternalStore(store.subscribe, full, full);
}

/** How deep in containers the canvas is drawing: an element straight in a column is at 1. */
const DepthContext = createContext(1);

const NOTHING: string[] = [];
const ELEMENTS = [...ELEMENT_TYPES];
const LEAVES = [...LEAF_TYPES];

const classes = (...names: readonly (string | undefined)[]): string =>
  names.filter((name) => name !== undefined && name !== '').join(' ');

const own = (look: Look | undefined): string | undefined => look?.customClass;
const names = (kind: string, id: string, look: Look | undefined, ...more: string[]): string =>
  classes(kind, ...more, nodeClass(id), own(look));

const leadsSomewhere = (action: PageAction | undefined): boolean =>
  action !== undefined && action.type !== 'none';

function Run({
  id,
  item,
  at,
  run,
}: {
  readonly id: string;
  readonly item: number;
  readonly at: number;
  readonly run: PageText[number];
}): ReactNode {
  if (run.text === '') return null;
  // A line break in the text is a line break on the page.
  let content: ReactNode = run.text.split('\n').map((line, index) => (
    // eslint-disable-next-line @eslint-react/no-array-index-key -- lines have no id; their order is their identity
    <Fragment key={index}>
      {index > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
  if (run.bold === true) content = <strong>{content}</strong>;
  if (run.italic === true) content = <em>{content}</em>;
  if (run.underline === true) content = <u>{content}</u>;
  if (run.strike === true) content = <s>{content}</s>;
  const look = run.color === undefined ? undefined : runClass(id, item, at);
  // eslint-disable-next-line jsx-a11y-x/anchor-is-valid -- the page's own markup, with nowhere to go while it is edited
  if (leadsSomewhere(run.link)) return <a className={look}>{content}</a>;
  return look === undefined ? content : <span className={look}>{content}</span>;
}

function Runs({
  id,
  item = 0,
  text,
}: {
  readonly id: string;
  readonly item?: number;
  readonly text: PageText | undefined;
}): ReactElement {
  return (
    <>
      {(text ?? []).map((run, at) => (
        // eslint-disable-next-line @eslint-react/no-array-index-key -- runs have no id; their order is their identity
        <Run key={at} id={id} item={item} at={at} run={run} />
      ))}
    </>
  );
}

/** The labelled box of something the canvas does not draw as the page will show it. */
function Box({
  id,
  look,
  dragRef,
  kind,
  children,
}: Base & { readonly kind?: string; readonly children: ReactNode }): ReactElement {
  return (
    <div ref={dragRef} className={classes(kind, 'ep', nodeClass(id), own(look))}>
      {children}
    </div>
  );
}

export function HeadingView({
  id,
  look,
  dragRef,
  kind,
  text,
  level,
}: Base & {
  readonly kind: 'headline' | 'sub_headline';
  readonly text: PageText | undefined;
  readonly level: number | undefined;
}): ReactElement {
  const chosen = typeof level === 'number' && Number.isInteger(level) ? level : 2;
  const Tag = `h${String(Math.min(6, Math.max(1, chosen)))}` as 'h1';
  return (
    <Tag ref={dragRef} className={names(kind === 'headline' ? 'hl' : 'sh', id, look)}>
      <Runs id={id} text={text} />
    </Tag>
  );
}

export function ParagraphView({
  id,
  look,
  dragRef,
  text,
}: Base & { readonly text: PageText | undefined }): ReactElement {
  return (
    <p ref={dragRef} className={names('pg', id, look)}>
      <Runs id={id} text={text} />
    </p>
  );
}

export function BulletListView({
  id,
  look,
  dragRef,
  items,
  marker,
}: Base & {
  readonly items: readonly PageText[] | undefined;
  readonly marker: string | undefined;
}): ReactElement {
  const Tag = marker === 'number' ? 'ol' : 'ul';
  const kind = marker === 'check' ? 'ls-check' : marker === 'none' ? 'ls-none' : '';
  return (
    <Tag
      ref={dragRef}
      className={names('ls', id, look, kind)}
      // A list without markers is still a list to whoever has it read out.
      role={kind === '' ? undefined : 'list'}
    >
      {(items ?? []).map((item, at) => (
        // eslint-disable-next-line @eslint-react/no-array-index-key -- items have no id; their order is their identity
        <li key={at}>
          <Runs id={id} item={at} text={item} />
        </li>
      ))}
    </Tag>
  );
}

export function ImageView({
  id,
  look,
  dragRef,
  src,
  alt,
  action,
  width,
  height,
}: Base & {
  readonly src: string | null | undefined;
  readonly alt: string | undefined;
  readonly action: PageAction | undefined;
  /** The picture's own size in pixels, when the page keeps it: written only with both. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}): ReactElement {
  const address = mediaAddress(src, '');
  if (address === undefined)
    return (
      <Box id={id} look={look} dragRef={dragRef}>
        <Trans>Image: no picture chosen yet</Trans>
      </Box>
    );
  // As the published page writes them: both sides or neither. They hold the picture's
  // place while it loads; how large it is drawn is the stylesheet's to say.
  const sized = typeof width === 'number' && typeof height === 'number';
  const image = (linked: boolean): ReactElement => (
    <img
      ref={linked ? undefined : dragRef}
      className={names('im', id, look)}
      src={address}
      alt={alt ?? ''}
      {...(sized ? { width, height } : {})}
      decoding="async"
    />
  );
  // eslint-disable-next-line jsx-a11y-x/anchor-is-valid -- the page's own markup, with nowhere to go while it is edited
  return leadsSomewhere(action) ? <a ref={dragRef}>{image(true)}</a> : image(false);
}

export function VideoView({
  id,
  look,
  dragRef,
  source,
  url,
}: Base & {
  readonly source: string | undefined;
  readonly url: string | null | undefined;
}): ReactElement {
  const address = url ?? '';
  const playable =
    source === 'file'
      ? mediaAddress(url, '') !== undefined
      : videoEmbedUrl({ source, url }) !== undefined;
  // One element, as on the published page: a frame for YouTube and Vimeo (`vd`), the
  // browser's own player for a file (`vf`). Here it is a box of the frame's shape.
  return (
    <div ref={dragRef} className={names(source === 'file' ? 'vf' : 'vd', id, look, 'ep', 'ev')}>
      {address === '' ? (
        <Trans>Video: no address yet</Trans>
      ) : !playable ? (
        <Trans>Video: this address can't be played</Trans>
      ) : source === 'youtube' ? (
        <Trans>YouTube video: {address}</Trans>
      ) : source === 'vimeo' ? (
        <Trans>Vimeo video: {address}</Trans>
      ) : (
        <Trans>Video file: {address}</Trans>
      )}
    </div>
  );
}

export function ButtonView({
  id,
  look,
  dragRef,
  label,
  subLabel,
  action,
}: Base & {
  readonly label: string | undefined;
  readonly subLabel: string | undefined;
  readonly action: PageAction | undefined;
}): ReactElement {
  const Tag = leadsSomewhere(action) ? 'a' : 'span';
  return (
    <Tag ref={dragRef} className={names('bt', id, look)}>
      {label}
      {subLabel === undefined || subLabel === '' ? null : <span className="bs">{subLabel}</span>}
    </Tag>
  );
}

export function DividerView({ id, look, dragRef }: Base): ReactElement {
  return <hr ref={dragRef} className={names('dv', id, look)} />;
}

export function FormView({
  id,
  look,
  dragRef,
  formId,
}: Base & { readonly formId: string | null | undefined }): ReactElement {
  const forms = use(CanvasFormsContext);
  const form = formId === null || formId === undefined ? undefined : forms.get(formId);
  const name = form?.name;
  return (
    <div ref={dragRef} className={names('fm', id, look)}>
      <span className="ep">
        {formId === null || formId === undefined ? (
          <Trans>Form: none chosen yet</Trans>
        ) : name === undefined ? (
          <Trans>Form: the one chosen is no longer here</Trans>
        ) : form?.published === true ? (
          <Trans>Form: {name}</Trans>
        ) : (
          <Trans>Form: {name} (not published)</Trans>
        )}
      </span>
    </div>
  );
}

/**
 * A calendar on a page is a button-styled link to the calendar's own booking page: drawn
 * here as that link, with nowhere to go while it is edited. A calendar that could not be
 * published (none chosen, deleted, not active) is a box that says which.
 */
export function CalendarView({
  id,
  look,
  dragRef,
  calendarId,
  label,
}: Base & {
  readonly calendarId: string | null | undefined;
  readonly label: string | undefined;
}): ReactElement {
  const state = calendarStateOf(calendarId, use(CanvasCalendarsContext));
  if (state.at === 'ready')
    return (
      // eslint-disable-next-line jsx-a11y-x/anchor-is-valid -- the page's own markup, with nowhere to go while it is edited
      <a ref={dragRef} className={names('bt', id, look)}>
        {calendarLabelOf(label)}
      </a>
    );
  const name = state.at === 'inactive' ? state.name : '';
  return (
    <Box id={id} look={look} dragRef={dragRef}>
      {state.at === 'none' ? (
        <Trans>Calendar: none chosen yet</Trans>
      ) : state.at === 'gone' ? (
        <Trans>Calendar: the one chosen is no longer here</Trans>
      ) : (
        <Trans>Calendar: {name} (not active)</Trans>
      )}
    </Box>
  );
}

const DAY = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

/**
 * Whether a countdown ticks on this install's pages: its server has the small script to
 * send (`getSitePublicStatus`). Null while that is not known.
 */
export const CanvasCountdownContext = createContext<boolean | null>(null);

/**
 * A countdown, with the published page's own markup and words: the time left, then the
 * moment it ends. Here the time left is a sample, worked out once when the page is drawn
 * and not counted down, and a tag beside it says so (`ep-tag`: the one thing here that is
 * not on the page). Once it is over the page shows what it was set to: a line of text, a
 * link to go on, or nothing.
 */
export function CountdownView({
  id,
  look,
  dragRef,
  endsAt,
  whenOver,
}: Base & {
  readonly endsAt: string | null | undefined;
  readonly whenOver:
    | { readonly type: 'hide' }
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'url'; readonly href: string }
    | undefined;
}): ReactElement {
  const ticks = use(CanvasCountdownContext);
  // Read once: whether the countdown is over is decided when the page is drawn.
  const [now] = useState(() => Date.now());
  const end = endsAt === null || endsAt === undefined ? Number.NaN : Date.parse(endsAt);
  if (!Number.isFinite(end))
    return (
      <Box id={id} look={look} dragRef={dragRef}>
        <Trans>Countdown: no end time yet</Trans>
      </Box>
    );
  const kind = names('cd', id, look);
  if (now < end) {
    const date = new Date(end);
    // The published page writes the moment in English and in UTC, as here.
    // eslint-disable-next-line lingui/no-unlocalized-strings -- the published page's own words, in its one language
    const written = `${DAY.format(date)}, ${CLOCK.format(date)} UTC`;
    return (
      <p ref={dragRef} className={kind}>
        <span role="timer">{countdownText(end - now, false)}</span>
        {/* eslint-disable-next-line lingui/no-unlocalized-strings -- the published page's own words, in its one language */}
        {' left, ends '}
        <time dateTime={date.toISOString()}>{written}</time>{' '}
        <span className="ep-tag">
          {ticks === false ? (
            <Trans>Sample: on the page it is brought up to date when the page is loaded</Trans>
          ) : (
            <Trans>Sample: on the page it counts down</Trans>
          )}
        </span>
      </p>
    );
  }
  if (whenOver?.type === 'text' && whenOver.text !== '')
    return (
      <p ref={dragRef} className={kind}>
        {whenOver.text}
      </p>
    );
  if (whenOver?.type === 'url')
    return (
      <p ref={dragRef} className={kind}>
        {/* eslint-disable-next-line jsx-a11y-x/anchor-is-valid -- the page's own markup, with nowhere to go while it is edited */}
        <a>
          <Trans>Continue</Trans>
        </a>
      </p>
    );
  return (
    <Box id={id} look={look} dragRef={dragRef}>
      <Trans>Countdown: it is over, so the page shows nothing here</Trans>
    </Box>
  );
}

export function CustomCodeView({ id, look, dragRef }: Base): ReactElement {
  return (
    <p ref={dragRef} className={classes('cc', nodeClass(id), own(look))}>
      <Trans>Custom code runs on your connected domain.</Trans>
    </p>
  );
}

export function ContainerView({
  id,
  look,
  dragRef,
  direction,
  children: Children,
}: Base & { readonly direction: string | undefined; readonly children: SlotView }): ReactElement {
  const depth = use(DepthContext);
  const full = useZoneFull(`${id}:children`);
  const lying = direction === 'horizontal' ? 'k-h' : 'k-v';
  // The schema refuses a container at the fourth level, so the deepest container that may
  // exist takes every element but another container; a full one takes nothing more.
  const allow = full ? NOTHING : depth >= 3 ? LEAVES : ELEMENTS;
  return (
    <div ref={dragRef} className={names('kt', id, look, lying)}>
      <DepthContext value={depth + 1}>
        <Children className={classes('ez', 'ez-kt', lying)} minEmptyHeight={48} allow={allow} />
      </DepthContext>
    </div>
  );
}

export function ColumnView({
  id,
  look,
  dragRef,
  children: Children,
}: Base & { readonly children: SlotView }): ReactElement {
  const full = useZoneFull(`${id}:children`);
  return (
    <div ref={dragRef} className={names('cl', id, look)}>
      <DepthContext value={1}>
        <Children className="ez ez-col" minEmptyHeight={64} allow={full ? NOTHING : ELEMENTS} />
      </DepthContext>
    </div>
  );
}

const COLUMN = ['column'];
const ROW = ['row'];

export function RowView({
  id,
  look,
  dragRef,
  columns: Columns,
}: Base & { readonly columns: SlotView }): ReactElement {
  const full = useZoneFull(`${id}:columns`);
  return (
    <div ref={dragRef} className={names('rw', id, look)}>
      <Columns className="ez ez-row" minEmptyHeight={64} allow={full ? NOTHING : COLUMN} />
    </div>
  );
}

/** The widths a section may be held to: `full` is what a section is with no class at all. */
const WIDTHS = ['wide', 'medium', 'small'];

export function SectionView({
  id,
  look,
  dragRef,
  width,
  rows: Rows,
}: Base & { readonly width: string | undefined; readonly rows: SlotView }): ReactElement {
  const full = useZoneFull(`${id}:rows`);
  const held = width !== undefined && WIDTHS.includes(width) ? `sc-${width}` : '';
  return (
    <section ref={dragRef} className={names('sc', id, look, held)}>
      <Rows className="ez" minEmptyHeight={96} allow={full ? NOTHING : ROW} />
    </section>
  );
}

const POPUP_WIDTHS = ['small', 'medium', 'large'];

export function PopupView({
  id,
  dragRef,
  name,
  width,
  rows: Rows,
}: Omit<Base, 'look'> & {
  readonly name: string | undefined;
  readonly width: string | undefined;
  readonly rows: SlotView;
}): ReactElement {
  const full = useZoneFull(`${id}:rows`);
  const chosen = width !== undefined && POPUP_WIDTHS.includes(width) ? width : 'medium';
  const title = name ?? '';
  return (
    <div ref={dragRef} className="ep-popup" role="group" aria-label={title}>
      <p className="ep-note">
        <Trans>Popup: {title}</Trans>
      </p>
      <Rows
        className={classes('pb', `pw-${chosen}`, nodeClass(id), 'ez')}
        minEmptyHeight={64}
        allow={full ? NOTHING : ROW}
      />
    </div>
  );
}

export function SavedSectionView({ id, dragRef }: Pick<Base, 'id' | 'dragRef'>): ReactElement {
  return (
    <Box id={id} look={undefined} dragRef={dragRef}>
      <Trans>A saved section, shown here by reference.</Trans>
    </Box>
  );
}

const SECTION_KINDS = ['section', 'saved_section'];
const POPUP = ['popup'];

/** The page itself: its stylesheet, its sections, and its popups apart from them. */
export function PageView({
  css,
  sections: Sections,
  popups: Popups,
  hasPopups,
}: {
  /** The whole stylesheet of the canvas: the page's rules, then each node's. */
  readonly css: string;
  readonly sections: SlotView;
  readonly popups: SlotView;
  readonly hasPopups: boolean;
}): ReactElement {
  const { t } = useLingui();
  const sectionsFull = useZoneFull('root:sections');
  const popupsFull = useZoneFull('root:popups');
  return (
    <>
      <style>{css}</style>
      {/* Named, so it is told apart from the editor's own main landmark around the frame. */}
      <main aria-label={t`The page being edited`}>
        <Sections
          className="ez"
          minEmptyHeight={160}
          allow={sectionsFull ? NOTHING : SECTION_KINDS}
        />
      </main>
      {hasPopups ? (
        <section className="ep-popups" aria-label={t`Popups`}>
          <p className="ep-note">
            <Trans>
              Popups. They are not part of the page's flow: each opens over the page from a link or
              a button.
            </Trans>
          </p>
          <Popups className="ez" minEmptyHeight={48} allow={popupsFull ? NOTHING : POPUP} />
        </section>
      ) : null}
    </>
  );
}
