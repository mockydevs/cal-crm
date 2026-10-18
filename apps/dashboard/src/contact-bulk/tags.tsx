// Contacts → Add Tag and Remove Tag on the contacts selected: the tags chosen, or every tag
// each contact has. Each contact gets, or loses, only what it has to.
import { Trans, useLingui } from '@lingui/react/macro';
import { CONTACT_BULK_TAG_LIMIT } from '@repo/contracts';
import { useState, type ReactElement } from 'react';

import { apiIn } from '../api';
import { TagPicker } from '../tag-picker';
import { BulkDialogShell, checkClassName, type BulkDialogProps } from './parts';

export default function TagsDialog(
  props: BulkDialogProps & { readonly remove: boolean },
): ReactElement {
  const { t } = useLingui();
  const { remove, ...shell } = props;
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState(false);
  return (
    <BulkDialogShell
      {...shell}
      title={remove ? t`Remove tags` : t`Add tags`}
      description={
        remove
          ? t`The tags are taken off each contact that has them.`
          : t`Each gets the tags it doesn't have yet.`
      }
      timing
      missing={allTags || tagIds.length > 0 ? undefined : t`Choose at least one tag.`}
      confirm="apply"
      bodyOf={(common) =>
        remove
          ? allTags
            ? { action: 'remove_tags', all: true, ...common }
            : { action: 'remove_tags', tagIds, ...common }
          : { action: 'add_tags', tagIds, ...common }
      }
    >
      {(pending) => (
        <>
          {remove ? (
            <label className={checkClassName}>
              <input
                type="checkbox"
                className="size-5 accent-primary"
                checked={allTags}
                disabled={pending}
                onChange={(event) => {
                  setAllTags(event.target.checked);
                }}
              />
              <Trans>Remove every tag each contact has</Trans>
            </label>
          ) : null}
          {allTags ? null : (
            <TagPicker
              label={remove ? t`Tags to remove` : t`Tags to add`}
              chosen={tagIds}
              limit={CONTACT_BULK_TAG_LIMIT}
              disabled={pending}
              client={apiIn(props.businessId)}
              cacheKey={['b', props.businessId, 'tags', 'bulk']}
              onChange={setTagIds}
            />
          )}
        </>
      )}
    </BulkDialogShell>
  );
}
