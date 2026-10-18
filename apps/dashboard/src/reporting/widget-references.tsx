// The values a condition on something of the business can take (widget-editor.tsx): team
// members, tags, pipelines, stages and calendars, each read from its own list. Fetched when
// a condition first names one, so the builder's panel does not bring every list's contract
// with it. A lost reason has no list to read yet, so the builder offers it no values.
import { Trans, useLingui } from '@lingui/react/macro';
import { getPipelines, listCalendars, listTags, listTaskAssignees } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { apiIn } from '../api';
import { reportingKeys, retryFaults } from './keys';

export type Reference = 'member' | 'tag' | 'pipeline' | 'stage' | 'calendar';

interface Option {
  readonly value: string;
  readonly label: string;
}

function useOptions(
  businessId: string,
  reference: Reference,
): { readonly options: readonly Option[] | undefined; readonly failed: boolean } {
  const { t } = useLingui();
  const api = apiIn(businessId);
  const people = useQuery({
    queryKey: ['b', businessId, 'task-assignees', 'first'],
    queryFn: () => api.request(listTaskAssignees, { query: {} }),
    enabled: reference === 'member',
    staleTime: 60_000,
    retry: retryFaults,
  });
  const tags = useQuery({
    queryKey: ['b', businessId, 'reporting', 'tags'],
    queryFn: () => api.request(listTags, {}),
    enabled: reference === 'tag',
    staleTime: 60_000,
    retry: retryFaults,
  });
  const pipelines = useQuery({
    queryKey: ['pipelines', businessId],
    queryFn: () => api.request(getPipelines, {}),
    enabled: reference === 'pipeline' || reference === 'stage',
    staleTime: 60_000,
    retry: retryFaults,
  });
  const calendars = useQuery({
    queryKey: reportingKeys.calendars(businessId),
    queryFn: () => api.request(listCalendars, { query: { limit: 50 } }),
    enabled: reference === 'calendar',
    staleTime: 60_000,
    retry: retryFaults,
  });
  switch (reference) {
    case 'member':
      return {
        failed: people.isError,
        options:
          people.data === undefined
            ? undefined
            : [
                { value: 'me', label: t`Me` },
                ...people.data.items.map((person) => ({
                  value: person.id,
                  label: person.name ?? t`Unnamed team member`,
                })),
              ],
      };
    case 'tag':
      return {
        failed: tags.isError,
        options: tags.data?.items.map((tag) => ({ value: tag.id, label: tag.name })),
      };
    case 'pipeline':
      return {
        failed: pipelines.isError,
        options: pipelines.data?.items.map((pipeline) => ({
          value: pipeline.id,
          label: pipeline.name,
        })),
      };
    case 'stage':
      return {
        failed: pipelines.isError,
        options: pipelines.data?.items.flatMap((pipeline) =>
          pipeline.stages.map((stage) => ({
            value: stage.id,
            label: `${pipeline.name} · ${stage.name}`,
          })),
        ),
      };
    case 'calendar':
      return {
        failed: calendars.isError,
        options: calendars.data?.items.map((calendar) => ({
          value: calendar.id,
          label: calendar.name,
        })),
      };
  }
}

export default function ReferenceValues({
  businessId,
  reference,
  label,
  values,
  onChange,
}: {
  readonly businessId: string;
  readonly reference: Reference;
  /** What the control is called: "Values of condition 1 of group 1". */
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}): ReactElement {
  const { options, failed } = useOptions(businessId, reference);
  if (failed)
    return (
      <p role="alert" className="text-xs text-destructive">
        <Trans>The choices couldn't be loaded. Close this panel and open it again.</Trans>
      </p>
    );
  if (options === undefined)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        <Trans>Loading the choices…</Trans>
      </p>
    );
  // A value the list no longer has (a deleted tag) still shows, by its id.
  const listed = [
    ...options,
    ...values
      .filter((value) => !options.some((option) => option.value === value))
      .map((value) => ({ value, label: value })),
  ];
  if (listed.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        <Trans>There is nothing to choose from yet.</Trans>
      </p>
    );
  return (
    <Select multiple aria-label={label} value={values} onValueChange={onChange}>
      {listed.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </Select>
  );
}
