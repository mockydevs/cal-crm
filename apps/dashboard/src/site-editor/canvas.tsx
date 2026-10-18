// The editor's canvas on Puck. This is the only file of the dashboard that imports the
// library: it draws the page in a frame, takes the pointer's drags, keeps the undo history,
// and nothing else. The top bar, the panels, the fields and the outline are ours and reach
// the canvas through canvas-api.ts; the stored page is ours and the library's data lives
// only in the browser while a page is open (document-map.ts).
//
// Read before writing this, in @puckeditor/core 0.23.0 as installed:
// - dist/index.d.ts: `Puck` with children (composition) and `Puck.Preview`; its props
//   `config`, `data`, `onChange`, `permissions`, `overrides`, `iframe`, `dictionary`,
//   `height`; `createUsePuck` and `useGetPuck`.
// - dist/actions-*.d.ts: `Config`, `ComponentConfig`, `Slot`, `SlotComponent` (a slot is
//   handed to `render` as a component taking `className`, `allow`, `minEmptyHeight`), the
//   actions `insert` (with `id`), `replace`, `replaceRoot`, `reorder`, `move`, `duplicate`,
//   `remove`, `setUi`, and `recordHistory`.
// - dist/chunk-55V3NZVF.mjs (the source, bundled): `Preview` draws `iframe#preview-frame`
//   and the drag code finds the frame by that id and reads its scale from its measured
//   width, so the frame may be scaled by a wrapper of ours (GlobalPosition); a slot given
//   `allow` at render time replaces its field's own list (getSlotTransform); a component
//   with `inline: true` is not wrapped and must set `puck.dragRef` on its own element;
//   undo history is written 250 ms after the last change, so a burst of actions is one
//   step (store/slices/history.ts); Ctrl+Z, Ctrl+Shift+Z and Delete are the library's own
//   hotkeys and work with composition; its drag listens to the pointer only
//   (lib/dnd/use-sensors.ts), which is why every move is also a button of ours.
// - puckeditor.com/docs/api-reference/fields/slot and /configuration/component-config
//   (`inline`, `permissions`, `defaultProps`).
// - Dragging a new node in from a list of ours: `Drawer` and `Drawer.Item`
//   (puckeditor.com/docs/api-reference/components/drawer; dist/index.d.ts). An item takes
//   `name` (the component's key), `isDragDisabled`, and as its child a component that
//   draws it. In the source (components/Drawer): the item is drawn twice, one copy staying
//   in the list while the other is dragged; the child is kept by identity, so it must be
//   one function for as long as the list stands; a drop calls `insertComponent`
//   (lib/insert-component.ts), which makes the node from `defaultProps` under an id of
//   the library's own and dispatches `insert`, heard through the `onAction` prop
//   (reducer/index.ts: called inside the reducer, so anything it starts is put off a turn).
import { useLingui } from '@lingui/react/macro';
import {
  ActionBar,
  createUsePuck,
  Drawer,
  Puck,
  useGetPuck,
  type ComponentConfig,
  type Config,
  type Data,
  type Slot,
} from '@puckeditor/core';
import '@puckeditor/core/no-external.css';
import type { PageAction, PageText } from '@repo/contracts';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { FitWidth } from '../site-publish';
import {
  CanvasActionsContext,
  CanvasDragContext,
  CanvasHistoryContext,
  CanvasSelectionContext,
  CanvasSnapshotContext,
  DeviceContext,
  useCanvas,
  type CanvasActions,
  type CanvasDrag,
  type CanvasHistory,
  type CanvasSelection,
  type CanvasSnapshot,
  type Outcome,
} from './canvas-api';
import { DEVICE_WIDTH, type Device, type Look } from './device';
import type { CanvasData, CanvasNode } from './document-map';
import {
  BulletListView,
  ButtonView,
  CalendarView,
  CanvasCalendarsContext,
  CanvasCountdownContext,
  CanvasFormsContext,
  ColumnView,
  ContainerView,
  CountdownView,
  CustomCodeView,
  DividerView,
  FormView,
  HeadingView,
  ImageView,
  PageView,
  ParagraphView,
  PopupView,
  RowView,
  SavedSectionView,
  SectionView,
  VideoView,
  ZoneStoreContext,
  type CanvasCalendars,
  type CanvasForms,
  type SlotView,
  type ZoneStore,
} from './elements';
import { EDITOR_CSS, nodesCss, pageCss } from './node-css';
import { canvasIdOf } from './problems';
import { defaultProps, type DefaultWords } from './node-defaults';
import {
  duplicateRefusal,
  ELEMENT_TYPES,
  indexTree,
  isFull,
  moveTargets,
  newNodeId,
  planAdd,
  POPUPS_ZONE,
  removalRefusal,
  rowNeedsColumn,
  SECTIONS_ZONE,
  zoneNodes,
  zoneOf,
  type TreeIndex,
} from './tree';

const usePuck = createUsePuck();

interface WithLook {
  look: Look;
}
type TextProps = WithLook & { text: PageText; level: number };
type ParagraphProps = WithLook & { text: PageText };
type ListProps = WithLook & { items: PageText[]; marker: string };
type ImageProps = WithLook & {
  src: string | null;
  alt: string;
  action: PageAction;
  width?: number;
  height?: number;
};
type CalendarProps = WithLook & { calendarId: string | null; label?: string };
type VideoProps = WithLook & { source: string; url: string | null };
type ButtonProps = WithLook & { label: string; subLabel: string; action: PageAction };
type FormProps = WithLook & { formId: string | null };
type CountdownProps = WithLook & {
  endsAt: string | null;
  whenOver: { type: 'hide' } | { type: 'text'; text: string } | { type: 'url'; href: string };
};
type ContainerProps = WithLook & { direction: string; children: Slot };
type ColumnProps = WithLook & { children: Slot };
type RowProps = WithLook & { columns: Slot };
type SectionProps = WithLook & { width: string; rows: Slot };
type PopupProps = WithLook & { name: string; width: string; rows: Slot };

const elementTypes = [...ELEMENT_TYPES];

/**
 * The page as the canvas draws it. It reads the page from our own snapshot, which the
 * frame's content is inside of in React's tree, and writes one stylesheet for all of it.
 */
function Root({
  settings,
  sections,
  popups,
}: {
  readonly settings: unknown;
  readonly sections: SlotView;
  readonly popups: SlotView;
}): ReactElement {
  const { data } = useCanvas();
  const page = useMemo(() => pageCss(settings), [settings]);
  const nodes = useMemo(() => nodesCss(data), [data]);
  return (
    <PageView
      css={`
        ${page}\n${EDITOR_CSS}\n${nodes}
      `}
      sections={sections}
      popups={popups}
      hasPopups={data.root.props.popups.length > 0}
    />
  );
}

/**
 * The canvas's configuration: one entry for each kind of node, with what a new one starts
 * as and how it is drawn. Only slots are fields here: every other prop is edited by our
 * own panel (fields.tsx) and rides through the canvas untouched.
 */
function canvasConfig(
  words: DefaultWords & { readonly names: Readonly<Record<string, string>> },
): Config {
  const defaults = defaultProps(words);
  const { names } = words;
  // What a new node starts as is plain data the contract accepts (node-defaults.ts); the
  // library types it as the props its own `render` is given.
  const starting = (kind: keyof typeof defaults): never => defaults[kind] as never;
  const heading = (kind: 'headline' | 'sub_headline'): ComponentConfig<TextProps> => ({
    label: names[kind] ?? kind,
    inline: true,
    defaultProps: starting(kind),
    render: ({ id, text, level, look, puck }) => (
      <HeadingView
        id={id}
        look={look}
        dragRef={puck.dragRef}
        kind={kind}
        text={text}
        level={level}
      />
    ),
  });
  const paragraph: ComponentConfig<ParagraphProps> = {
    label: names['paragraph'] ?? '',
    inline: true,
    defaultProps: starting('paragraph'),
    render: ({ id, text, look, puck }) => (
      <ParagraphView id={id} look={look} dragRef={puck.dragRef} text={text} />
    ),
  };
  const bulletList: ComponentConfig<ListProps> = {
    label: names['bullet_list'] ?? '',
    inline: true,
    defaultProps: starting('bullet_list'),
    render: ({ id, items, marker, look, puck }) => (
      <BulletListView id={id} look={look} dragRef={puck.dragRef} items={items} marker={marker} />
    ),
  };
  const image: ComponentConfig<ImageProps> = {
    label: names['image'] ?? '',
    inline: true,
    defaultProps: starting('image'),
    render: ({ id, src, alt, action, width, height, look, puck }) => (
      <ImageView
        id={id}
        look={look}
        dragRef={puck.dragRef}
        src={src}
        alt={alt}
        action={action}
        width={width}
        height={height}
      />
    ),
  };
  const video: ComponentConfig<VideoProps> = {
    label: names['video'] ?? '',
    inline: true,
    defaultProps: starting('video'),
    render: ({ id, source, url, look, puck }) => (
      <VideoView id={id} look={look} dragRef={puck.dragRef} source={source} url={url} />
    ),
  };
  const button: ComponentConfig<ButtonProps> = {
    label: names['button'] ?? '',
    inline: true,
    defaultProps: starting('button'),
    render: ({ id, label, subLabel, action, look, puck }) => (
      <ButtonView
        id={id}
        look={look}
        dragRef={puck.dragRef}
        label={label}
        subLabel={subLabel}
        action={action}
      />
    ),
  };
  const calendar: ComponentConfig<CalendarProps> = {
    label: names['calendar'] ?? '',
    inline: true,
    defaultProps: starting('calendar'),
    render: ({ id, calendarId, label, look, puck }) => (
      <CalendarView
        id={id}
        look={look}
        dragRef={puck.dragRef}
        calendarId={calendarId}
        label={label}
      />
    ),
  };
  const plain = (
    kind: 'divider' | 'custom_code',
    View: (props: {
      readonly id: string;
      readonly look: Look | undefined;
      readonly dragRef: ((element: Element | null) => void) | null;
    }) => ReactElement,
  ): ComponentConfig<WithLook> => ({
    label: names[kind] ?? kind,
    inline: true,
    defaultProps: starting(kind),
    render: ({ id, look, puck }) => <View id={id} look={look} dragRef={puck.dragRef} />,
  });
  const form: ComponentConfig<FormProps> = {
    label: names['form'] ?? '',
    inline: true,
    defaultProps: starting('form'),
    render: ({ id, formId, look, puck }) => (
      <FormView id={id} look={look} dragRef={puck.dragRef} formId={formId} />
    ),
  };
  const countdown: ComponentConfig<CountdownProps> = {
    label: names['countdown'] ?? '',
    inline: true,
    defaultProps: starting('countdown'),
    render: ({ id, endsAt, whenOver, look, puck }) => (
      <CountdownView
        id={id}
        look={look}
        dragRef={puck.dragRef}
        endsAt={endsAt}
        whenOver={whenOver}
      />
    ),
  };
  const container: ComponentConfig<ContainerProps> = {
    label: names['container'] ?? '',
    inline: true,
    fields: { children: { type: 'slot', allow: elementTypes } } as never,
    defaultProps: starting('container'),
    render: ({ id, direction, children, look, puck }) => (
      <ContainerView id={id} look={look} dragRef={puck.dragRef} direction={direction}>
        {children}
      </ContainerView>
    ),
  };
  const column: ComponentConfig<ColumnProps> = {
    label: names['column'] ?? '',
    inline: true,
    fields: { children: { type: 'slot', allow: elementTypes } } as never,
    defaultProps: starting('column'),
    // A row keeps at least one column, and a drag could take its last one away: columns
    // are moved with our own buttons, which know the rule (tree.ts).
    permissions: { drag: false },
    render: ({ id, children, look, puck }) => (
      <ColumnView id={id} look={look} dragRef={puck.dragRef}>
        {children}
      </ColumnView>
    ),
  };
  const row: ComponentConfig<RowProps> = {
    label: names['row'] ?? '',
    inline: true,
    fields: { columns: { type: 'slot', allow: ['column'] } } as never,
    defaultProps: starting('row'),
    render: ({ id, columns, look, puck }) => (
      <RowView id={id} look={look} dragRef={puck.dragRef} columns={columns} />
    ),
  };
  const section: ComponentConfig<SectionProps> = {
    label: names['section'] ?? '',
    inline: true,
    fields: { rows: { type: 'slot', allow: ['row'] } } as never,
    defaultProps: starting('section'),
    render: ({ id, width, rows, look, puck }) => (
      <SectionView id={id} look={look} dragRef={puck.dragRef} width={width} rows={rows} />
    ),
  };
  const popup: ComponentConfig<PopupProps> = {
    label: names['popup'] ?? '',
    inline: true,
    fields: { rows: { type: 'slot', allow: ['row'] } } as never,
    defaultProps: starting('popup'),
    render: ({ id, name, width, rows, puck }) => (
      <PopupView id={id} dragRef={puck.dragRef} name={name} width={width} rows={rows} />
    ),
  };
  return {
    root: {
      fields: {
        sections: { type: 'slot', allow: ['section', 'saved_section'] },
        popups: { type: 'slot', allow: ['popup'] },
      },
      render: (props: Record<string, unknown>) => (
        // The library hands a slot to `render` as a component (WithDeepSlots in its types);
        // the root's props are not typed by its fields, so the two slots are named here.
        <Root
          settings={props['settings']}
          sections={props['sections'] as SlotView}
          popups={props['popups'] as SlotView}
        />
      ),
    },
    components: {
      section,
      row,
      column,
      container,
      headline: heading('headline'),
      sub_headline: heading('sub_headline'),
      paragraph,
      bullet_list: bulletList,
      image,
      video,
      button,
      divider: plain('divider', DividerView),
      form,
      calendar,
      countdown,
      // Tenant code is never drawn in the canvas: the frame shares the dashboard's origin.
      // The element is a line that says where the code runs.
      custom_code: plain('custom_code', CustomCodeView),
      popup,
      saved_section: {
        label: names['saved_section'] ?? '',
        inline: true,
        render: ({
          id,
          puck,
        }: {
          id: string;
          puck: { dragRef: ((el: Element | null) => void) | null };
        }) => <SavedSectionView id={id} dragRef={puck.dragRef} />,
      },
    },
  };
}

/** The id of the node the library has selected, or null. */
const idOf = (
  item: { readonly props: Readonly<Record<string, unknown>> } | null,
): string | null => {
  const id = item?.props['id'];
  return typeof id === 'string' ? id : null;
};

/** Which zones are full, kept outside React so a node hears only about its own. */
function createZoneStore(): ZoneStore & { readonly set: (full: ReadonlySet<string>) => void } {
  let full: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isFull: (zone) => full.has(zone),
    set: (next) => {
      if (next.size === full.size && [...next].every((zone) => full.has(zone))) return;
      full = next;
      for (const listener of listeners) listener();
    },
  };
}

function fullZones(data: CanvasData, index: TreeIndex): ReadonlySet<string> {
  const full = new Set<string>();
  for (const zone of [SECTIONS_ZONE, POPUPS_ZONE]) if (isFull(data, index, zone)) full.add(zone);
  for (const placed of index.values()) {
    const zone = zoneOf(placed.node);
    if (zone !== undefined && isFull(data, index, zone)) full.add(zone);
  }
  return full;
}

/**
 * Between the library and our panels: the page as it stands, as a snapshot of ours, and
 * every change the panels may ask for, as the library's own actions. A change sent
 * through the library's API is kept out of undo unless it says otherwise, so each says so.
 */
function Bridge({
  zones,
  droppedRef,
  onDroppedIn,
  children,
}: {
  readonly zones: ReturnType<typeof createZoneStore>;
  /** Where the canvas hears of a node the library inserted: set here, called by `onAction`. */
  readonly droppedRef: { current: (inserted: Inserted) => void };
  /** Hears the kind of a node that was dragged in from the list and dropped on the page. */
  readonly onDroppedIn: (type: string) => void;
  readonly children: ReactNode;
}): ReactElement {
  const data = usePuck((puck) => puck.appState.data) as unknown as CanvasData;
  const selectedId = usePuck((puck) => idOf(puck.selectedItem));
  const canUndo = usePuck((puck) => puck.history.hasPast);
  const canRedo = usePuck((puck) => puck.history.hasFuture);
  const getPuck = useGetPuck();
  const index = useMemo(() => indexTree(data), [data]);
  const snapshot = useMemo<CanvasSnapshot>(
    () => ({ data, index, selectedId, canUndo, canRedo }),
    [data, index, selectedId, canUndo, canRedo],
  );
  const selectedType = selectedId === null ? null : (index.get(selectedId)?.node.type ?? null);
  const selection = useMemo<CanvasSelection>(
    () => ({ id: selectedId, type: selectedType }),
    [selectedId, selectedType],
  );
  const history = useMemo<CanvasHistory>(() => ({ canUndo, canRedo }), [canUndo, canRedo]);
  useLayoutEffect(() => {
    zones.set(fullZones(data, index));
  }, [zones, data, index]);
  /** True while a button of ours adds nodes: those inserts are not drops. */
  const addingRef = useRef(false);
  useEffect(() => {
    droppedRef.current = (inserted) => {
      if (addingRef.current) return;
      // The library is still inside its own change: what follows waits for it to end.
      queueMicrotask(() => {
        const { dispatch, appState } = getPuck();
        const fresh = appState.data as unknown as CanvasData;
        // A row is a row only with a column in it (the page document's rule): one dropped
        // on the page gets its first column, as a row added with the button does.
        if (rowNeedsColumn(indexTree(fresh), inserted.id)) {
          // The column is ours to add, and is not itself a drop.
          addingRef.current = true;
          try {
            dispatch({
              type: 'insert',
              recordHistory: true,
              componentType: 'column',
              destinationZone: `${inserted.id}:columns`,
              destinationIndex: 0,
              id: newNodeId(),
            });
          } finally {
            addingRef.current = false;
          }
        }
        onDroppedIn(inserted.type);
      });
    };
  }, [droppedRef, getPuck, onDroppedIn]);

  const actions = useMemo<CanvasActions>(() => {
    /** The page this very moment: an action may follow another before anything is drawn. */
    const now = (): { data: CanvasData; index: TreeIndex; selectedId: string | null } => {
      const puck = getPuck();
      const fresh = puck.appState.data as unknown as CanvasData;
      return {
        data: fresh,
        index: indexTree(fresh),
        selectedId: idOf(puck.selectedItem),
      };
    };
    const select = (id: string | null): void => {
      const { dispatch } = getPuck();
      const placed = id === null ? undefined : now().index.get(id);
      dispatch({
        type: 'setUi',
        ui: {
          itemSelector: placed === undefined ? null : { zone: placed.zone, index: placed.index },
        },
      });
    };
    return {
      select,
      selectSaved: (nodeId) => {
        const id = canvasIdOf(now().data, nodeId);
        if (id !== null) select(id);
        return id !== null;
      },
      add: (type) => {
        const at = now();
        const plan = planAdd(at.data, at.index, type, at.selectedId, newNodeId);
        if (!plan.ok) return plan;
        const { dispatch } = getPuck();
        addingRef.current = true;
        try {
          for (const step of plan.steps)
            dispatch({
              type: 'insert',
              recordHistory: true,
              componentType: step.type,
              destinationZone: step.zone,
              destinationIndex: step.index,
              id: step.id,
            });
        } finally {
          addingRef.current = false;
        }
        select(plan.select);
        return { ok: true, id: plan.select, where: plan.where };
      },
      read: (id) => now().index.get(id)?.node,
      setProps: (id, props) => {
        const placed = now().index.get(id);
        if (placed === undefined) return;
        const next: Record<string, unknown> = { ...placed.node.props, ...props, id };
        // A prop given as undefined is taken off: the page holds no key without a value.
        for (const [key, value] of Object.entries(props))
          if (value === undefined) Reflect.deleteProperty(next, key);
        getPuck().dispatch({
          type: 'replace',
          recordHistory: true,
          destinationZone: placed.zone,
          destinationIndex: placed.index,
          data: { ...placed.node, props: next as CanvasNode['props'] },
        });
      },
      setSettings: (settings) => {
        getPuck().dispatch({
          type: 'replaceRoot',
          recordHistory: true,
          root: { props: { settings } as never },
        });
      },
      moveBy: (id, by) => {
        const at = now();
        const placed = at.index.get(id);
        if (placed === undefined) return false;
        const to = placed.index + by;
        if (to < 0 || to >= zoneNodes(at.data, at.index, placed.zone).length) return false;
        getPuck().dispatch({
          type: 'reorder',
          recordHistory: true,
          sourceIndex: placed.index,
          destinationIndex: to,
          destinationZone: placed.zone,
        });
        select(id);
        return true;
      },
      moveTo: (id, zone) => {
        const at = now();
        const placed = at.index.get(id);
        const target = moveTargets(at.data, at.index, id).find((each) => each.zone === zone);
        if (placed === undefined || target === undefined) return 'kind';
        if (target.refusal !== null) return target.refusal;
        getPuck().dispatch({
          type: 'move',
          recordHistory: true,
          sourceIndex: placed.index,
          sourceZone: placed.zone,
          destinationIndex: zoneNodes(at.data, at.index, zone).length,
          destinationZone: zone,
        });
        select(id);
        return null;
      },
      duplicate: (id): Outcome => {
        const at = now();
        const placed = at.index.get(id);
        const refusal = duplicateRefusal(at.data, at.index, id);
        if (placed === undefined || refusal !== null)
          return { ok: false, refusal: refusal ?? 'kind' };
        // The library selects the copy, which it puts just after the original.
        getPuck().dispatch({
          type: 'duplicate',
          recordHistory: true,
          sourceIndex: placed.index,
          sourceZone: placed.zone,
        });
        return { ok: true, id: now().selectedId ?? id };
      },
      remove: (id) => {
        const at = now();
        const placed = at.index.get(id);
        if (placed === undefined) return 'kind';
        const refusal = removalRefusal(at.data, at.index, id);
        if (refusal !== null) return refusal;
        const { dispatch } = getPuck();
        dispatch({ type: 'setUi', ui: { itemSelector: null } });
        dispatch({ type: 'remove', recordHistory: true, zone: placed.zone, index: placed.index });
        return null;
      },
      undo: () => {
        getPuck().history.back();
      },
      redo: () => {
        getPuck().history.forward();
      },
    };
  }, [getPuck]);

  return (
    <CanvasActionsContext value={actions}>
      <CanvasHistoryContext value={history}>
        <CanvasSelectionContext value={selection}>
          <CanvasDragContext value={DRAG}>
            <CanvasSnapshotContext value={snapshot}>{children}</CanvasSnapshotContext>
          </CanvasDragContext>
        </CanvasSelectionContext>
      </CanvasHistoryContext>
    </CanvasActionsContext>
  );
}

/** A node the library inserted: its kind, and the id it was given. */
interface Inserted {
  readonly type: string;
  readonly id: string;
}

/**
 * What the library's drag-and-drop writes on every node of the page: a button's role, a
 * place in the tab order, and "press the space bar to pick up". None of it is true here:
 * Puck drags with the pointer only (lib/dnd/use-sensors.ts), and a node does nothing when
 * it is focused and a key is pressed. Left in, a screen reader hears a page made of
 * buttons inside buttons, and the page's own headings and lists are hidden behind them.
 * So they are taken off again whenever they are written; every move is a button of ours,
 * outside the frame (panels.tsx).
 */
const DRAG_ATTRIBUTES = [
  'role',
  'tabindex',
  'aria-roledescription',
  'aria-describedby',
  'aria-pressed',
  'aria-grabbed',
  'aria-disabled',
];
// The frame's nodes belong to the frame's own window, so `instanceof Element` of this
// window does not know them: a node says itself what it is.
const isElement = (node: Node): node is Element => node.nodeType === 1;
function withoutDragRoles(root: Element, marker = 'data-puck-component'): () => void {
  const clean = (element: Element): void => {
    if (!element.hasAttribute(marker)) return;
    for (const name of DRAG_ATTRIBUTES) {
      // A node's own role (a list without markers, a popup's group) is the page's and stays.
      if (name === 'role' && element.getAttribute('role') !== 'button') continue;
      if (element.hasAttribute(name)) element.removeAttribute(name);
    }
  };
  const sweep = (within: ParentNode): void => {
    for (const element of within.querySelectorAll(`[${marker}]`)) clean(element);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && isElement(record.target)) clean(record.target);
      for (const added of record.addedNodes)
        if (isElement(added)) {
          clean(added);
          sweep(added);
        }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [...DRAG_ATTRIBUTES, marker],
  });
  sweep(root);
  return () => {
    observer.disconnect();
  };
}

/**
 * The list a new node is dragged from. The library's own element goes around it, so its
 * drag-and-drop knows the list is no place to drop. What it draws for each source carries
 * the same untrue button's role as a node of the page does, taken off here in the same way:
 * the tile is for the pointer, and the button beside it is the keyboard's.
 */
function DragList({ children }: { readonly children: ReactNode }): ReactElement {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    return list === null ? undefined : withoutDragRoles(list, 'data-puck-drawer-item');
  }, []);
  return (
    <div ref={listRef} className="min-w-0">
      <Drawer>{children}</Drawer>
    </div>
  );
}

/** One kind of node to drag onto the page. `tile` draws it, and is one function for good. */
function DragSource({
  type,
  disabled,
  tile,
}: {
  readonly type: string;
  readonly disabled: boolean;
  readonly tile: (props: { readonly name: string }) => ReactElement;
}): ReactElement {
  return (
    <Drawer.Item name={type} isDragDisabled={disabled}>
      {tile}
    </Drawer.Item>
  );
}

const DRAG: CanvasDrag = { List: DragList, Source: DragSource };

/** What the canvas's frame needs of its own document: a title and a language, for whoever has it read out. */
function FrameShell({
  children,
  document: frame,
  title,
  lang,
}: {
  readonly children: ReactNode;
  readonly document?: Document | undefined;
  readonly title: string;
  readonly lang: string;
}): ReactElement {
  useEffect(() => {
    if (frame === undefined) return;
    frame.documentElement.setAttribute('lang', lang);
    frame.defaultView?.frameElement?.setAttribute('title', title);
  }, [frame, title, lang]);
  useEffect(() => (frame === undefined ? undefined : withoutDragRoles(frame.body)), [frame]);
  return <>{children}</>;
}

// One object each for as long as the dashboard runs: the library takes a new object for a
// new setting, and works out every node's permissions again.
const FRAME = { enabled: true, syncHostStyles: false } as const;
const PERMISSIONS = { duplicate: false, delete: false } as const;

/**
 * The canvas over one page. It is given the page once: afterwards the canvas owns what is
 * being edited, and its history with it; to show another page, mount another canvas.
 * `children` is the editor's own layout, which places `CanvasFrame` where the page goes.
 */
export function SiteCanvas({
  initial,
  forms,
  calendars,
  countdownTicks,
  device,
  onChange,
  onDroppedIn,
  children,
}: {
  readonly initial: CanvasData;
  readonly forms: CanvasForms;
  readonly calendars: CanvasCalendars;
  /** Whether a countdown ticks on this install's pages; null while that is not known. */
  readonly countdownTicks: boolean | null;
  readonly device: Device;
  readonly onChange: (data: CanvasData) => void;
  /** Hears the kind of a node that was dragged in from the list and dropped on the page. */
  readonly onDroppedIn: (type: string) => void;
  readonly children: ReactNode;
}): ReactElement {
  const { t, i18n } = useLingui();
  const [data] = useState(() => initial as unknown as Data);
  const [zones] = useState(createZoneStore);
  const config = useMemo(
    () =>
      canvasConfig({
        headline: t`Your headline`,
        subHeadline: t`A line that says a little more`,
        paragraph: t`Write something here.`,
        listItem: t`First point`,
        button: t`Click here`,
        popup: t`New popup`,
        names: {
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
        },
      }),
    [t],
  );
  const title = t`The page being edited`;
  const lang = i18n.locale;
  // One object for as long as the page is open: the library redraws when it changes.
  const overrides = useMemo(
    () => ({
      iframe: ({ children: page, document }: { children: ReactNode; document?: Document }) => (
        <FrameShell document={document} title={title} lang={lang}>
          {page}
        </FrameShell>
      ),
      // Over the selected node the library draws a bar with its name and its own buttons.
      // Only the name is kept, as a picture of what the panel beside the page says in
      // words: the buttons are ours, in that panel, where the keyboard reaches them.
      actionBar: ({ label }: { label?: string }) => (
        <div aria-hidden="true">
          <ActionBar>
            <ActionBar.Group>
              <ActionBar.Label label={label ?? ''} />
            </ActionBar.Group>
          </ActionBar>
        </div>
      ),
    }),
    [title, lang],
  );
  const dictionary = useMemo(
    () => ({
      'action-selectparent': t`Select what holds it`,
      'action-delete': t`Delete`,
      'action-duplicate': t`Duplicate`,
      'label-component': t`Element`,
    }),
    [t],
  );
  const latestRef = useRef(onChange);
  useEffect(() => {
    latestRef.current = onChange;
  }, [onChange]);
  const changed = useMemo(
    () => (next: Data) => {
      latestRef.current(next as unknown as CanvasData);
    },
    [],
  );
  const droppedRef = useRef<(inserted: Inserted) => void>(() => undefined);
  const heard = useMemo(
    () =>
      (action: {
        readonly type: string;
        readonly componentType?: string;
        readonly id?: string;
      }) => {
        if (
          action.type === 'insert' &&
          action.componentType !== undefined &&
          action.id !== undefined
        )
          droppedRef.current({ type: action.componentType, id: action.id });
      },
    [],
  );
  return (
    <CanvasFormsContext value={forms}>
      <CanvasCalendarsContext value={calendars}>
        <CanvasCountdownContext value={countdownTicks}>
          <ZoneStoreContext value={zones}>
            <DeviceContext value={device}>
              <Puck
                config={config}
                data={data}
                height="100%"
                // The frame gets none of the dashboard's stylesheets: a page is drawn with
                // its own rules only, and the dashboard's tokens cannot leak into it.
                iframe={FRAME}
                // Copying and deleting are our own buttons, which know the page document's
                // rules (how many a place may hold, that a row keeps a column). With these
                // off the library's Delete and Backspace keys do nothing either: they
                // would delete the selected element while the keyboard is on any button of
                // the editor.
                permissions={PERMISSIONS}
                overrides={overrides}
                dictionary={dictionary}
                onChange={changed}
                onAction={heard}
              >
                <Bridge zones={zones} droppedRef={droppedRef} onDroppedIn={onDroppedIn}>
                  {children}
                </Bridge>
              </Puck>
            </DeviceContext>
          </ZoneStoreContext>
        </CanvasCountdownContext>
      </CanvasCalendarsContext>
    </CanvasFormsContext>
  );
}

/**
 * Where the page is drawn: the frame at the chosen device's width, made smaller when the
 * window has less room, so a desktop page is still laid out as on a desktop. The frame's
 * own width is what decides which of a node's styles apply, as on the published page.
 */
export function CanvasFrame({ device }: { readonly device: Device }): ReactElement {
  return (
    <FitWidth width={DEVICE_WIDTH[device]} className="bg-muted" testId="canvas-stage">
      <Puck.Preview id="site-canvas" />
    </FitWidth>
  );
}
