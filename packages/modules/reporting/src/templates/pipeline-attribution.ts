// The Template Library's first template: what is open, won and lost and what it is worth,
// the pipeline as a funnel, where leads came from and what each source closed, and
// appointments by status.
import {
  REPORT_DEFINITION_VERSION,
  type ReportDefinition,
  type ReportFilter,
  type ReportWidget,
} from '@repo/contracts';

const only = (field: string, value: string): ReportFilter => ({
  match: 'all',
  groups: [{ match: 'all', conditions: [{ field, operator: 'any_of', values: [value] }] }],
});

/**
 * The definition a report made from the template starts with. The funnel is of one
 * pipeline: the business's first, when it has one; without, every stage of every pipeline.
 */
export function pipelineAttributionDefinition(pipelineId?: string): ReportDefinition {
  const worth = (id: string, title: string, status: 'open' | 'won' | 'lost'): ReportWidget => ({
    id,
    kind: 'stat',
    title,
    query: {
      source: 'opportunities',
      measures: ['count', 'value'],
      groupBy: [],
      filters: only('status', status),
      // Won and lost by the day they were closed; open by the day they were made.
      time: { property: status === 'open' ? 'created' : 'closed' },
    },
    w: 4,
    h: 2,
  });
  return {
    version: REPORT_DEFINITION_VERSION,
    range: { preset: 'last_30_days' },
    compare: 'previous_period',
    theme: { accent: null, logo: 'business' },
    cover: { title: 'Pipeline & Attribution Report', subtitle: '' },
    pages: [
      {
        name: 'Pipeline',
        widgets: [
          worth('open', 'Open opportunities', 'open'),
          worth('won', 'Won opportunities', 'won'),
          worth('lost', 'Lost opportunities', 'lost'),
          {
            id: 'funnel',
            kind: 'funnel',
            title: 'Funnel',
            query: {
              source: 'opportunities',
              measures: ['count', 'value'],
              groupBy: ['stage'],
              order: { by: 'group', direction: 'asc' },
              ...(pipelineId === undefined ? {} : { filters: only('pipeline', pipelineId) }),
            },
            w: 12,
            h: 4,
          },
        ],
      },
      {
        name: 'Attribution',
        widgets: [
          {
            id: 'leads_by_source',
            kind: 'donut',
            title: 'Leads by session source',
            query: { source: 'contacts', measures: ['count'], groupBy: ['sessionSource'] },
            w: 6,
            h: 4,
          },
          {
            id: 'won_by_source',
            kind: 'hbar',
            title: 'Won value by session source',
            query: {
              source: 'opportunities',
              measures: ['value', 'count'],
              groupBy: ['sessionSource'],
              filters: only('status', 'won'),
              time: { property: 'closed' },
            },
            w: 6,
            h: 4,
          },
          {
            id: 'leads_over_time',
            kind: 'line',
            title: 'Leads over time',
            query: {
              source: 'contacts',
              measures: ['count'],
              groupBy: [],
              time: { grain: 'day' },
            },
            w: 12,
            h: 4,
          },
          {
            id: 'appointments_by_status',
            kind: 'bar',
            title: 'Appointments by status',
            query: {
              source: 'appointments',
              measures: ['count'],
              groupBy: ['status'],
              order: { by: 'group', direction: 'asc' },
            },
            w: 12,
            h: 4,
          },
        ],
      },
    ],
  };
}
