// What is wrong with a page, and where: the contract's own refusals of what is on screen
// (the page cannot be saved until they are put right), and the server's findings about
// the saved page (some stop it being published, some are warnings). Each is tied to the
// element it is about, so the editor can take the person there.
import { pageDocument, type VisualPageDocument } from '@repo/contracts';
import type { PageProblem } from '../site-publish-rules';
import { documentId, toDocument, walkCanvas, type CanvasData } from './document-map';

/** One thing to put right, with the element it is about when there is one. */
export type EditorProblem = PageProblem;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The node a path into a document ends in or passes last: the element a problem is about. */
export function nodeIdAt(document: unknown, path: readonly PropertyKey[]): string | null {
  let at: unknown = document;
  let found: string | null = null;
  for (const key of path) {
    if (Array.isArray(at)) at = typeof key === 'number' ? (at as unknown[])[key] : undefined;
    else if (isRecord(at)) at = typeof key === 'symbol' ? undefined : at[String(key)];
    else break;
    if (isRecord(at) && typeof at['id'] === 'string' && typeof at['type'] === 'string')
      found = at['id'];
  }
  return found;
}

export interface Checked {
  /** The page as a document the contract accepts, or null while it does not. */
  readonly document: VisualPageDocument | null;
  /** Why it does not: each with the element to put right. */
  readonly problems: readonly EditorProblem[];
}

/**
 * What the canvas holds, as a document the contract accepts, or why it is not one yet.
 * Nothing unparsed leaves the editor: this is the only way to a save.
 */
export function checkCanvas(data: CanvasData): Checked {
  const raw = toDocument(data);
  const parsed = pageDocument.safeParse(raw);
  if (parsed.success)
    return parsed.data.mode === 'visual'
      ? { document: parsed.data, problems: [] }
      : { document: null, problems: [] };
  const seen = new Set<string>();
  const problems: EditorProblem[] = [];
  for (const issue of parsed.error.issues) {
    const nodeId = nodeIdAt(raw, issue.path);
    const key = `${nodeId ?? ''}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({ message: issue.message, nodeId, blocking: true });
  }
  return { document: null, problems };
}

/**
 * The canvas's own id of the node a problem names. A saved page knows a node by the id the
 * document keeps (document-map.ts, documentId), which for a node the canvas named itself
 * is a shortened one; the canvas still knows it by the long one.
 */
export function canvasIdOf(data: CanvasData, nodeId: string): string | null {
  let found: string | null = null;
  const look = (node: { readonly props: { readonly id: string } }): void => {
    if (found === null && documentId(node.props.id) === nodeId) found = node.props.id;
  };
  walkCanvas(data.root.props.sections, 'root:sections', look);
  walkCanvas(data.root.props.popups, 'root:popups', look);
  return found;
}
