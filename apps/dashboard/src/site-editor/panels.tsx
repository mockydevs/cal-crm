// The editor's own panels, in GoHighLevel's builder's places: at the left what can be
// added (Elements) and what the page is made of (Layers), at the right the selected
// element with every move as a button and its fields. Everything here works from the
// keyboard: the canvas's drag takes a pointer, so add, move, copy, delete and "select what
// holds it" are buttons with names, and each one says what it did in the status line. The
// pointer can also drag a kind of element from the list onto the page.
import { Trans, useLingui } from '@lingui/react/macro';
import type { SitePageElementList } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerLeftUp,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  createContext,
  memo,
  use,
  useCallback,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useCanvas, useCanvasActions, useCanvasDrag, useSelection } from './canvas-api';
import { documentId, SLOT_OF, type CanvasNode } from './document-map';
import { NodeFields, PageFields } from './fields';
import { smallLabelClassName } from './field-parts';
import {
  DRAG_IN_TYPES,
  dragInRefusal,
  excerptOf,
  isElementType,
  isFull,
  moveTargets,
  pathTo,
  zoneCapacity,
  zoneNodes,
  zoneOf,
  type PathPart,
  type Refusal,
} from './tree';

/** Says something where everyone hears it: the editor's one status line. */
export const SayContext = createContext<(words: string) => void>(() => undefined);

/** The name of each kind of node, in the reader's language. */
export function useTypeNames(): Readonly<Record<string, string>> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      section: t`Section`,
      row: t`Row`,
      column: t`Column`,
      container: t`Container`,
      headline: t`Headline`,
      sub_headline: t`Sub-headline`,
      paragraph: t`Paragraph`,
      bullet_list: t`Bullet list`,
      image: t`Image`,
      video: t`Video`,
      button: t`Button`,
      divider: t`Divider`,
      form: t`Form`,
      calendar: t`Calendar`,
      countdown: t`Countdown`,
      custom_code: t`Custom code`,
      popup: t`Popup`,
      saved_section: t`Saved section`,
    }),
    [t],
  );
}

/** Why something was refused, as a sentence. The numbers are the page document's own limits. */
export function useRefusalWords(): (refusal: Refusal) => string {
  const { t } = useLingui();
  return (refusal) => {
    const sections = zoneCapacity('root:sections');
    const popups = zoneCapacity('root:popups');
    const rows = zoneCapacity(':rows');
    const columns = zoneCapacity(':columns');
    const children = zoneCapacity(':children');
    switch (refusal) {
      case 'sections':
        return t`A page holds at most ${sections} sections.`;
      case 'popups':
        return t`A page holds at most ${popups} popups.`;
      case 'rows':
        return t`A section holds at most ${rows} rows.`;
      case 'columns':
        return t`A row holds at most ${columns} columns.`;
      case 'children':
        return t`A column or a container holds at most ${children} elements.`;
      case 'depth':
        return t`Containers go at most three deep, so a container can't go there.`;
      case 'nodes':
        return t`A page holds at most 2,000 sections, rows, columns and elements.`;
      case 'last_column':
        return t`A row keeps at least one column. Delete the row instead.`;
      case 'needs_row':
        return t`Select a row, or something inside one, to add a column to it.`;
      case 'kind':
        return t`That can't go there.`;
    }
  };
}

const iconButtonClassName =
  'inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-50 lg:size-8';
const tileClassName =
  'flex min-h-11 w-full min-w-0 items-center gap-2 rounded-control border border-border bg-card px-2.5 py-1.5 text-left text-sm select-none hover:border-input hover:bg-muted lg:min-h-9';

const LAYOUT = ['section', 'row', 'column'] as const;

/** The width from which the page and the list are side by side, so one can be dragged onto the other. */
const SIDE_BY_SIDE = '(min-width: 1024px)';
function useSideBySide(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(SIDE_BY_SIDE);
      query.addEventListener('change', changed);
      return () => {
        query.removeEventListener('change', changed);
      };
    },
    () => window.matchMedia(SIDE_BY_SIDE).matches,
  );
}

/** What a tile of the list needs to know that is not its kind. */
interface Tiles {
  readonly notes: ReadonlyMap<string, string>;
  /** The kinds that can be picked up and dragged now. */
  readonly dragged: ReadonlySet<string>;
  readonly add: (type: string) => void;
}
const TilesContext = createContext<Tiles>({
  notes: new Map(),
  dragged: new Set(),
  add: () => undefined,
});

/**
 * One kind of node in the list, for the pointer: pressed, it adds one as the button beside
 * it does; held and moved, it is dragged onto the page. It is kept from screen readers and
 * out of the keyboard's way, which have the button. The canvas draws it for each source
 * (canvas-api.ts, CanvasDrag), so it is one function and takes the kind as `name`.
 */
function Tile({ name: type }: { readonly name: string }): ReactElement {
  const names = useTypeNames();
  const { notes, dragged, add } = use(TilesContext);
  const note = notes.get(type);
  return (
    // eslint-disable-next-line jsx-a11y-x/click-events-have-key-events, jsx-a11y-x/no-static-element-interactions -- the pointer's shortcut to the named button beside it, which is what the keyboard and a screen reader use
    <div
      className={`${tileClassName} ${dragged.has(type) ? 'cursor-grab' : 'cursor-pointer'}`}
      data-tile={type}
      onClick={() => {
        add(type);
      }}
    >
      {dragged.has(type) ? (
        <GripVertical className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
      ) : null}
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-foreground">{names[type] ?? type}</span>
        {note === undefined ? null : (
          <span className="text-xs leading-normal text-muted-foreground">{note}</span>
        )}
      </span>
    </div>
  );
}

/**
 * What can be added. An element goes after the selected element, or inside the selected
 * column or container; on an empty page the section, row and column it needs are made
 * with it. Where the page is beside the list, a kind can also be dragged from the list to
 * the place it should go, and the page takes it only where the page document allows: the
 * right kind of place, not a full one, containers no deeper than three. The element types
 * and what a published page does not do for each yet come from the server
 * (`listSitePageElements`), so nothing is offered here that it does not know.
 */
export function ElementsPanel({
  elements,
  popupNote,
}: {
  readonly elements: SitePageElementList['items'];
  /** What a published page does not do for a popup yet, when there is something. */
  readonly popupNote: string | null;
}): ReactElement {
  const { t } = useLingui();
  const names = useTypeNames();
  const refusalWords = useRefusalWords();
  const say = use(SayContext);
  const selected = useSelection().type;
  const { add } = useCanvasActions();
  const { index } = useCanvas();
  const drag = useCanvasDrag();
  const sideBySide = useSideBySide();
  const noteId = useId();
  const selectedName = selected === null ? '' : (names[selected] ?? '');
  const addOne = (type: string): void => {
    const added = names[type] ?? type;
    const outcome = add(type);
    if (!outcome.ok) say(refusalWords(outcome.refusal));
    else if (outcome.where === 'after') say(t`${added} added after the selected ${selectedName}.`);
    else if (outcome.where === 'inside')
      say(t`${added} added inside the selected ${selectedName}.`);
    else if (outcome.where === 'near') say(t`${added} added.`);
    else say(t`${added} added to the page.`);
  };
  const types = [...LAYOUT, ...elements.map((element) => element.type), 'popup'];
  const tiles: Tiles = {
    notes: new Map([
      ...elements.flatMap((each) => (each.note === null ? [] : [[each.type, each.note] as const])),
      ...(popupNote === null ? [] : [['popup', popupNote] as const]),
    ]),
    // A kind is dragged where the page is beside the list and the page has room for it.
    dragged: new Set(
      types.filter((type) => drag !== null && sideBySide && dragInRefusal(index, type) === null),
    ),
    add: addOne,
  };
  const dragging = tiles.dragged.size > 0;
  const item = (type: string): ReactElement => {
    const name = names[type] ?? type;
    const note = tiles.notes.get(type);
    const described = note === undefined ? undefined : `${noteId}-${type}`;
    return (
      <li key={type} className="flex min-w-0 items-start gap-1">
        <div aria-hidden="true" className="min-w-0 flex-1">
          {drag !== null && DRAG_IN_TYPES.includes(type) ? (
            <drag.Source type={type} disabled={!tiles.dragged.has(type)} tile={Tile} />
          ) : (
            <Tile name={type} />
          )}
        </div>
        <button
          type="button"
          className={iconButtonClassName}
          aria-label={t`Add ${name}`}
          aria-describedby={described}
          title={t`Add ${name}`}
          onClick={() => {
            addOne(type);
          }}
        >
          <Plus aria-hidden className="size-4" strokeWidth={2} />
        </button>
        {note === undefined ? null : (
          <span id={described} className="sr-only">
            {note}
          </span>
        )}
      </li>
    );
  };
  const list = (
    <div className="flex min-w-0 flex-col gap-4 p-3">
      <p className="text-xs leading-normal text-muted-foreground">
        {selected === null ? (
          <Trans>Nothing is selected: what you add goes at the end of the page.</Trans>
        ) : isElementType(selected) && selected !== 'container' ? (
          <Trans>What you add goes after the selected {selectedName}.</Trans>
        ) : (
          <Trans>What you add goes into the selected {selectedName}.</Trans>
        )}{' '}
        {dragging ? <Trans>Or drag one onto the page, to the place it should go.</Trans> : null}
      </p>
      <section className="flex min-w-0 flex-col gap-2">
        <h2 className={smallLabelClassName}>
          <Trans>Layout</Trans>
        </h2>
        <ul className="flex min-w-0 flex-col gap-1.5">{LAYOUT.map((type) => item(type))}</ul>
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h2 className={smallLabelClassName}>
          <Trans>Elements</Trans>
        </h2>
        <ul className="flex min-w-0 flex-col gap-1.5">
          {elements.map((element) => item(element.type))}
        </ul>
      </section>
      <section className="flex min-w-0 flex-col gap-2">
        <h2 className={smallLabelClassName}>
          <Trans>Popups</Trans>
        </h2>
        <ul className="flex min-w-0 flex-col gap-1.5">{item('popup')}</ul>
      </section>
    </div>
  );
  return (
    <TilesContext value={tiles}>
      {drag === null ? list : <drag.List>{list}</drag.List>}
    </TilesContext>
  );
}

const childrenOf = (node: CanvasNode): readonly CanvasNode[] => {
  const slot = SLOT_OF[node.type];
  const children = slot === undefined ? undefined : node.props[slot];
  return Array.isArray(children) ? (children as readonly CanvasNode[]) : [];
};

/** One line of the outline, as plain values: a line whose values did not change is not drawn again. */
interface OutlineLine {
  readonly id: string;
  readonly type: string;
  readonly words: string;
  readonly depth: number;
  /** Whether it holds other nodes, and so can be opened and shut. */
  readonly holds: boolean;
  readonly shown: boolean;
  /** Whether it starts the popups, which are listed after the sections. */
  readonly firstPopup: boolean;
}

/** The lines the outline shows: every node whose holders are all open, in the page's order. */
function outlineLines(
  sections: readonly CanvasNode[],
  popups: readonly CanvasNode[],
  open: ReadonlySet<string>,
): OutlineLine[] {
  const lines: OutlineLine[] = [];
  const walk = (nodes: readonly CanvasNode[], depth: number, popup: boolean): void => {
    nodes.forEach((node, at) => {
      const { id } = node.props;
      const holds = SLOT_OF[node.type] !== undefined;
      const shown = holds && open.has(id);
      lines.push({
        id,
        type: node.type,
        words: excerptOf(node),
        depth,
        holds,
        shown,
        firstPopup: popup && depth === 0 && at === 0,
      });
      if (shown) walk(childrenOf(node), depth + 1, false);
    });
  };
  walk(sections, 0, false);
  walk(popups, 0, true);
  return lines;
}

const OutlineItem = memo(function OutlineItem({
  id,
  words,
  depth,
  holds,
  shown,
  firstPopup,
  name,
  selected,
  wrong,
  onToggle,
  onSelect,
}: Omit<OutlineLine, 'type'> & {
  readonly name: string;
  readonly selected: boolean;
  readonly wrong: boolean;
  readonly onToggle: (id: string, open: boolean) => void;
  readonly onSelect: (id: string) => void;
}): ReactElement {
  const { t } = useLingui();
  return (
    <li className="min-w-0">
      {firstPopup ? (
        <h2 className={`px-1 pt-3 pb-1 ${smallLabelClassName}`}>
          <Trans>Popups</Trans>
        </h2>
      ) : null}
      <div className="flex min-w-0 items-center" style={{ paddingLeft: depth * 12 }}>
        {holds ? (
          <button
            type="button"
            className={iconButtonClassName}
            aria-expanded={shown}
            aria-label={
              shown ? t`Hide what is in ${name} ${words}` : t`Show what is in ${name} ${words}`
            }
            onClick={() => {
              onToggle(id, !shown);
            }}
          >
            {shown ? (
              <ChevronDown aria-hidden className="size-4" strokeWidth={1.8} />
            ) : (
              <ChevronRight aria-hidden className="size-4" strokeWidth={1.8} />
            )}
          </button>
        ) : (
          <span aria-hidden className="size-11 shrink-0 lg:size-8" />
        )}
        <button
          type="button"
          data-outline={id}
          aria-current={selected ? 'true' : undefined}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-1.5 rounded-control px-2 text-left text-sm -outline-offset-2 hover:bg-muted aria-[current=true]:bg-accent aria-[current=true]:text-link lg:min-h-8"
          onClick={() => {
            onSelect(id);
          }}
        >
          <span className="shrink-0 font-medium">{name}</span>
          {words === '' ? null : (
            <span className="min-w-0 truncate text-muted-foreground">{words}</span>
          )}
          {wrong ? (
            <span className="shrink-0 text-xs font-medium text-destructive">
              <Trans>Needs a look</Trans>
            </span>
          ) : null}
        </button>
      </div>
    </li>
  );
});

/** How many nodes a page may have before the outline opens on its sections only. */
const OPEN_ALL_UNDER = 60;

/**
 * The page as a list: every node by its kind and its first words, to select from. It is
 * the keyboard's way to any element of the page. A long page opens with its sections
 * shut; whatever holds the selected node is opened.
 */
export function OutlinePanel({
  marked,
}: {
  /** The elements something is wrong with, by the id the saved page knows them by. */
  readonly marked: ReadonlySet<string>;
}): ReactElement {
  const { t } = useLingui();
  const names = useTypeNames();
  const { data, index, selectedId } = useCanvas();
  const { select } = useCanvasActions();
  // What the person opened or shut by hand; everything else follows the rule below.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const open = new Set<string>();
  const small = index.size <= OPEN_ALL_UNDER;
  for (const [id, placed] of index)
    if ((toggled.get(id) ?? small) && SLOT_OF[placed.node.type] !== undefined) open.add(id);
  // Whatever holds the selected node is open, so the selection can be seen.
  let at = selectedId === null ? undefined : index.get(selectedId);
  while (at?.parent !== null && at?.parent !== undefined) {
    const parentId = at.parent.props.id;
    if (toggled.get(parentId) !== false) open.add(parentId);
    at = index.get(parentId);
  }
  const toggle = useCallback((id: string, shown: boolean): void => {
    setToggled((now) => new Map(now).set(id, shown));
  }, []);
  const { sections, popups } = data.root.props;
  const lines = outlineLines(sections, popups, open);
  return (
    <nav aria-label={t`Layers`} className="flex min-w-0 flex-col gap-3 p-2">
      {lines.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">
          <Trans>The page is empty. Add a headline from Elements to start.</Trans>
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {lines.map((line) => (
            <OutlineItem
              key={line.id}
              id={line.id}
              words={line.words}
              depth={line.depth}
              holds={line.holds}
              shown={line.shown}
              firstPopup={line.firstPopup}
              name={names[line.type] ?? line.type}
              selected={line.id === selectedId}
              wrong={marked.has(documentId(line.id))}
              onToggle={toggle}
              onSelect={select}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}

/** A node's way from the page down to it, in words: "Hero › Row 1 › Column 2". */
function usePathWords(): (parts: readonly PathPart[]) => string {
  const names = useTypeNames();
  return (parts) =>
    parts
      .map((part) => part.name ?? `${names[part.type] ?? part.type} ${String(part.place)}`)
      .join(' › ');
}

/** One thing to do to the selected node: a square button that holds an icon and has a name. */
function Tool({
  label,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className={iconButtonClassName}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The selected node: what it is and where, every move as a button, and its fields. With
 * nothing selected, the page's own settings.
 */
export function SelectionPanel({
  headingRef,
}: {
  /** The panel's heading, which takes the keyboard after something is deleted. */
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
}): ReactElement {
  const { t } = useLingui();
  const names = useTypeNames();
  const refusalWords = useRefusalWords();
  const pathWords = usePathWords();
  const say = use(SayContext);
  const { data, index, selectedId } = useCanvas();
  const actions = useCanvasActions();
  const placed = selectedId === null ? undefined : index.get(selectedId);
  if (placed === undefined)
    return (
      <>
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="px-3 pt-3 text-base font-medium focus:outline-none"
        >
          <Trans>Page</Trans>
        </h2>
        <PageFields />
      </>
    );
  const { node } = placed;
  const id = node.props.id;
  const name = names[node.type] ?? node.type;
  const siblings = zoneNodes(data, index, placed.zone).length;
  const place = placed.index + 1;
  const targets = moveTargets(data, index, id);
  const ownZone = zoneOf(node);
  const full = ownZone !== undefined && isFull(data, index, ownZone);
  const capacity = ownZone === undefined ? 0 : zoneCapacity(ownZone);
  const move = (by: -1 | 1): void => {
    if (actions.moveBy(id, by)) {
      const to = place + by;
      say(t`${name} moved to place ${to} of ${siblings}.`);
    }
  };
  const across = node.type === 'column';
  return (
    <>
      <div className="flex min-w-0 flex-col gap-2 px-3 pt-3" data-testid="node-actions">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-base font-medium wrap-anywhere focus:outline-none"
          >
            {name}
          </h2>
          <p className="text-xs wrap-anywhere text-muted-foreground">
            {pathWords(pathTo(index, id))}
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {placed.parent === null ? null : (
            <Tool
              label={t`Select what holds this ${name}`}
              onClick={() => {
                const parent = placed.parent;
                if (parent === null) return;
                actions.select(parent.props.id);
                const parentName = names[parent.type] ?? parent.type;
                say(t`${parentName} selected.`);
              }}
            >
              <CornerLeftUp aria-hidden className="size-4" strokeWidth={1.8} />
            </Tool>
          )}
          <Tool
            label={across ? t`Move ${name} left` : t`Move ${name} up`}
            disabled={placed.index === 0}
            onClick={() => {
              move(-1);
            }}
          >
            <ArrowUp
              aria-hidden
              className={across ? 'size-4 -rotate-90' : 'size-4'}
              strokeWidth={1.8}
            />
          </Tool>
          <Tool
            label={across ? t`Move ${name} right` : t`Move ${name} down`}
            disabled={placed.index >= siblings - 1}
            onClick={() => {
              move(1);
            }}
          >
            <ArrowDown
              aria-hidden
              className={across ? 'size-4 -rotate-90' : 'size-4'}
              strokeWidth={1.8}
            />
          </Tool>
          {node.type === 'saved_section' ? null : (
            <Tool
              label={t`Duplicate ${name}`}
              onClick={() => {
                const outcome = actions.duplicate(id);
                say(outcome.ok ? t`${name} duplicated.` : refusalWords(outcome.refusal));
              }}
            >
              <Copy aria-hidden className="size-4" strokeWidth={1.8} />
            </Tool>
          )}
          <Tool
            label={t`Delete ${name}`}
            onClick={() => {
              const refusal = actions.remove(id);
              if (refusal !== null) {
                say(refusalWords(refusal));
                return;
              }
              say(t`${name} deleted. Undo brings it back.`);
              // The panel now shows the page: its heading takes the keyboard once it is drawn.
              window.setTimeout(() => {
                headingRef.current?.focus();
              }, 0);
            }}
          >
            <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
          </Tool>
        </div>
        {targets.length === 0 ? null : (
          <label className={`flex min-w-0 flex-col gap-1 ${smallLabelClassName}`}>
            <Trans>Move to</Trans>
            <Select
              aria-label={t`Move ${name} to`}
              value=""
              onValueChange={(zone) => {
                if (zone === '') return;
                const target = targets.find((each) => each.zone === zone);
                const refusal = actions.moveTo(id, zone);
                if (refusal !== null) say(refusalWords(refusal));
                else if (target !== undefined) {
                  const where = pathWords(pathTo(index, target.ownerId));
                  say(t`${name} moved to ${where}.`);
                }
              }}
            >
              <option value="">{t`Where it is`}</option>
              {targets.map((target) => (
                <option key={target.zone} value={target.zone} disabled={target.refusal !== null}>
                  {pathWords(pathTo(index, target.ownerId))}
                </option>
              ))}
            </Select>
          </label>
        )}
        {full ? (
          <p className="rounded-control bg-secondary px-3 py-2 text-xs leading-normal text-body">
            <Trans>
              This {name} is full: it holds {capacity}, the most it can. Nothing more can be added
              or dragged into it.
            </Trans>
          </p>
        ) : null}
      </div>
      <NodeFields key={id} node={node} />
    </>
  );
}
