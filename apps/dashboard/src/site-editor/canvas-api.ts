// What the editor's own panels know about the canvas and may ask of it. The canvas
// (canvas.tsx) provides both; nothing else in the editor touches the canvas library, so
// the panels, the outline and the top bar would work unchanged over another canvas.
import { createContext, use, type ReactElement, type ReactNode } from 'react';
import type { Device } from './device';
import type { CanvasData, CanvasNode } from './document-map';
import type { Refusal, TreeIndex, Where } from './tree';

/** The page as it stands this moment. */
export interface CanvasSnapshot {
  readonly data: CanvasData;
  readonly index: TreeIndex;
  readonly selectedId: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export type Outcome =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly refusal: Refusal };

/** Every change to the page goes through one of these, each one step of undo. */
export interface CanvasActions {
  readonly select: (id: string | null) => void;
  /**
   * Selects the node a saved page knows by this id (document-map.ts, documentId). False
   * when the page being edited no longer has it.
   */
  readonly selectSaved: (nodeId: string) => boolean;
  /** Adds a node of a kind after or inside what is selected (tree.ts, planAdd). */
  readonly add: (type: string) => Outcome & { readonly where?: Where };
  /** A node as the page holds it this very moment, whatever was last drawn. */
  readonly read: (id: string) => CanvasNode | undefined;
  /**
   * Changes some of a node's props; its children stay as they are. A prop given as
   * undefined is taken off the node.
   */
  readonly setProps: (id: string, props: Readonly<Record<string, unknown>>) => void;
  readonly setSettings: (settings: unknown) => void;
  /** Moves a node one place up or down among its siblings. False at either end. */
  readonly moveBy: (id: string, by: -1 | 1) => boolean;
  /** Moves a node to the end of another zone. */
  readonly moveTo: (id: string, zone: string) => Refusal | null;
  readonly duplicate: (id: string) => Outcome;
  readonly remove: (id: string) => Refusal | null;
  readonly undo: () => void;
  readonly redo: () => void;
}

const EMPTY: CanvasSnapshot = {
  data: { root: { props: { settings: null, sections: [], popups: [] } }, content: [] },
  index: new Map(),
  selectedId: null,
  canUndo: false,
  canRedo: false,
};
const refuse = (): never => {
  throw new Error('The canvas is not ready.');
};

export const CanvasSnapshotContext = createContext<CanvasSnapshot>(EMPTY);
export const CanvasActionsContext = createContext<CanvasActions>({
  select: refuse,
  selectSaved: refuse,
  add: refuse,
  read: refuse,
  setProps: refuse,
  setSettings: refuse,
  moveBy: refuse,
  moveTo: refuse,
  duplicate: refuse,
  remove: refuse,
  undo: refuse,
  redo: refuse,
});

/**
 * What is selected, by its id and its kind. Apart from the snapshot, so that what only
 * needs to know this is not drawn again for every letter typed into a field.
 */
export interface CanvasSelection {
  readonly id: string | null;
  readonly type: string | null;
}
export const CanvasSelectionContext = createContext<CanvasSelection>({ id: null, type: null });
export const useSelection = (): CanvasSelection => use(CanvasSelectionContext);

/** Whether there is something to undo and to redo: all the top bar needs of the canvas. */
export interface CanvasHistory {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}
export const CanvasHistoryContext = createContext<CanvasHistory>({
  canUndo: false,
  canRedo: false,
});
export const useCanvasHistory = (): CanvasHistory => use(CanvasHistoryContext);

export const useCanvas = (): CanvasSnapshot => use(CanvasSnapshotContext);
export const useCanvasActions = (): CanvasActions => use(CanvasActionsContext);

/**
 * Dragging a new node onto the page from a list of ours. The canvas gives the two parts:
 * `List` goes around every source, and `Source` is what is dragged for one kind of
 * node. Where it may be dropped is decided by the canvas's zones while it is dragged (what
 * kind, how many, how deep: elements.tsx); `disabled` keeps a source from being picked up
 * at all. A drag takes a pointer: every source has a button beside it that adds the same.
 */
export interface CanvasDrag {
  readonly List: (props: { readonly children: ReactNode }) => ReactElement;
  readonly Source: (props: {
    readonly type: string;
    readonly disabled: boolean;
    /**
     * Draws the source, given the kind as `name`. One function for as long as the list
     * stands: the canvas keeps what it draws by the function's identity.
     */
    readonly tile: (props: { readonly name: string }) => ReactElement;
  }) => ReactElement;
}
export const CanvasDragContext = createContext<CanvasDrag | null>(null);
/** The canvas's drag parts, or null where the page is not on a canvas that drags. */
export const useCanvasDrag = (): CanvasDrag | null => use(CanvasDragContext);

/** The device the page is being edited for: ours, not the canvas library's. */
export const DeviceContext = createContext<Device>('desktop');
export const useDevice = (): Device => use(DeviceContext);
