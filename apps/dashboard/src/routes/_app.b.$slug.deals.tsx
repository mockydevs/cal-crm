import { createFileRoute } from '@tanstack/react-router';
import { publicId, type DealViewState } from '@repo/contracts';
import { dealSections, type DealSection } from '../deal-search';
import { DealsPage } from '../deals';
import { fieldListSearch } from '../field-list-search';
import { dealColumnsOf, type DealColumnKey } from '../list-columns';

/**
 * ?deal= opens that opportunity in its dialog over the list, or a new one for "new": the
 * command bar goes to one this way, and a reload or Back keeps or closes it. ?section= says
 * which part of the dialog shows.
 */
export interface DealsSearch extends DealViewState {
  readonly deal?: string;
  readonly section?: Exclude<DealSection, 'details'>;
  readonly view?: string;
  readonly columns?: DealColumnKey[];
}

export const Route = createFileRoute('/_app/b/$slug/deals')({
  validateSearch: (search: Record<string, unknown>): DealsSearch => {
    const pipeline = publicId('pipeline').safeParse(search['pipelineId']);
    const view = publicId('saved_view').safeParse(search['view']);
    const columns = dealColumnsOf(search['columns']);
    const status = search['status'];
    const layout = search['layout'];
    const q = typeof search['q'] === 'string' ? search['q'].trim() : '';
    const fieldSearch = fieldListSearch(search);
    // One order applies: a built-in one (the contract's `dealSorts`), unless a field does.
    const sort =
      fieldSearch.sortField === undefined
        ? (['created', 'updated', 'name', 'value'] as const).find((each) => each === search['sort'])
        : undefined;
    const direction = (['asc', 'desc'] as const).find((each) => each === search['direction']);
    const section = dealSections.find((each) => each === search['section']);
    return {
      ...fieldSearch,
      ...(sort === undefined ? {} : { sort }),
      ...(sort === undefined || direction === undefined ? {} : { direction }),
      ...(typeof search['deal'] === 'string' ? { deal: search['deal'] } : {}),
      ...(typeof search['deal'] === 'string' && section !== undefined && section !== 'details'
        ? { section }
        : {}),
      ...(pipeline.success ? { pipelineId: pipeline.data } : {}),
      ...(view.success ? { view: view.data } : {}),
      ...(columns === undefined ? {} : { columns }),
      ...(status === 'open' || status === 'won' || status === 'lost' || status === 'all'
        ? { status }
        : {}),
      ...(layout === 'board' || layout === 'table' ? { layout } : {}),
      ...(q === '' ? {} : { q }),
    };
  },
  component: DealsPage,
});
