// What the address says is open over the Pipelines page (as GoHighLevel's `?mode=create`):
// the dialog that creates a pipeline, or the one that edits a pipeline, so a reload opens
// it again and Back closes it. Both addresses of the page read it the same.
import { publicId } from '@repo/contracts';

export interface PipelinesSearch {
  readonly mode?: 'create';
  readonly pipeline?: string;
}

export function pipelinesSearch(search: Record<string, unknown>): PipelinesSearch {
  if (search['mode'] === 'create') return { mode: 'create' };
  const pipeline = publicId('pipeline').safeParse(search['pipeline']);
  return pipeline.success ? { pipeline: pipeline.data } : {};
}

/** How the page changes its address: to open a dialog, or to close it. */
export type PipelinesNavigate = (
  search: PipelinesSearch,
  options?: { readonly replace?: boolean; readonly ignoreBlocker?: boolean },
) => void;
