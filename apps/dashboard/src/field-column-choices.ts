// The contact list's custom fields as columns to choose in Manage fields, each under the
// name of its folder, folders in their order, as GoHighLevel lists them.
import type { FieldDefinition } from '@repo/contracts';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiIn } from './api';
import { isFieldColumn, type FieldColumn } from './list-columns';
import type { FieldChoice } from './manage-fields-types';
import { useBusiness } from './workspace';

/** The fields as choices, by folder and then by place; a field's id is its column. */
export function useFieldColumnChoices(
  fields: readonly FieldDefinition[],
): readonly FieldChoice<FieldColumn>[] {
  const business = useBusiness();
  // The same folders the contact page reads, from the same place in the cache.
  const folders = useQuery({
    queryKey: ['b', business.id, 'field-folders', 'contact'],
    // The contract arrives with the first read, not with the page (field-folders-api.ts).
    queryFn: async () =>
      apiIn(business.id).request((await import('./field-folders-api')).listFieldFolders, {
        query: { objectKey: 'contact' },
      }),
    enabled: fields.length > 0,
    staleTime: 60_000,
  }).data?.items;
  return useMemo(() => {
    const place = new Map(folders?.map((folder, index) => [folder.id, index]));
    const name = new Map(folders?.map((folder) => [folder.id, folder.name]));
    const rank = (field: FieldDefinition) =>
      field.folderId === undefined ? -1 : (place.get(field.folderId) ?? folders?.length ?? 0);
    return fields
      .toSorted(
        (left, right) => rank(left) - rank(right) || (left.position ?? 0) - (right.position ?? 0),
      )
      .flatMap((field): FieldChoice<FieldColumn>[] => {
        const key = field.id;
        if (!isFieldColumn(key)) return [];
        const group = field.folderId === undefined ? undefined : name.get(field.folderId);
        return [{ key, label: field.label, ...(group === undefined ? {} : { group }) }];
      });
  }, [fields, folders]);
}
