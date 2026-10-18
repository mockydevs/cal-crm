import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { ArrowDown, ArrowUp, ChevronDown, Lock } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { moveColumn, nameFirst, sameColumns } from './list-rules';
import { sidePanelBodyClassName, sidePanelFooterClassName } from './list-toolbar';
import type { FieldChoice, FieldLimit } from './manage-fields-types';

const rowClassName = 'flex min-h-11 items-center gap-2 rounded-control px-2 lg:min-h-9';
const checkboxClassName = 'size-4 shrink-0 accent-primary';

/** The choices in their groups: the ungrouped first, then each group as it first comes. */
function groupsOf<Key extends string>(
  choices: readonly FieldChoice<Key>[],
): { readonly name: string | undefined; readonly choices: FieldChoice<Key>[] }[] {
  const groups = new Map<string | undefined, FieldChoice<Key>[]>([[undefined, []]]);
  for (const choice of choices)
    groups.set(choice.group, [...(groups.get(choice.group) ?? []), choice]);
  return [...groups]
    .filter(([, members]) => members.length > 0)
    .map(([name, members]) => ({ name, choices: members }));
}

/** The form by itself, for a panel that shows it as one of its steps. */
export default function ManageFieldsForm<Key extends string>({
  choices,
  value,
  limit,
  onApply,
  onCancel,
}: {
  readonly choices: readonly FieldChoice<Key>[];
  readonly value: readonly Key[];
  readonly limit?: FieldLimit<Key>;
  readonly onApply: (columns: Key[]) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { t } = useLingui();
  // What the table showed when the panel opened. A field stays under the heading it was
  // under until the panel closes, so a checkbox doesn't move away from the keyboard.
  const [shown] = useState(() =>
    nameFirst(value).filter((key): key is Key => choices.some((choice) => choice.key === key)),
  );
  const [order, setOrder] = useState(shown);
  const [removed, setRemoved] = useState<readonly Key[]>([]);
  const [added, setAdded] = useState<readonly Key[]>([]);
  const [text, setText] = useState('');
  const wanted = text.trim().toLocaleLowerCase();
  const matches = (choice: FieldChoice<Key>) => choice.label.toLocaleLowerCase().includes(wanted);
  const inTable = order.flatMap((key) => choices.filter((choice) => choice.key === key));
  const toAdd = choices.filter((choice) => !shown.includes(choice.key));
  const columns = [...order.filter((key) => !removed.includes(key)), ...added];
  const changed = !sameColumns(columns, shown);
  // Once as many limited columns show as may, the others wait until one is taken away.
  const full =
    limit !== undefined && columns.filter((key) => limit.applies(key)).length >= limit.max;
  const limitMax = limit?.max ?? 0;
  const toggle = (list: readonly Key[], key: Key): Key[] =>
    list.includes(key) ? list.filter((each) => each !== key) : [...list, key];
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed) onApply(columns);
      }}
    >
      <div className={sidePanelBodyClassName}>
        <Input
          type="search"
          autoComplete="off"
          aria-label={t`Search fields`}
          placeholder={t`Search fields`}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <section aria-label={t`Fields in table`} className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            <Trans>Fields in table</Trans>
          </h3>
          <ul className="flex flex-col">
            {inTable.filter(matches).map(({ key, label }) => {
              const index = order.indexOf(key);
              const locked = key === 'name';
              const checked = !removed.includes(key);
              return (
                <li key={key} className={rowClassName}>
                  <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-sm lg:min-h-9">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked || (!checked && full && limit.applies(key))}
                      onChange={() => {
                        setRemoved((current) => toggle(current, key));
                      }}
                      className={checkboxClassName}
                    />
                    <span className="min-w-0 wrap-break-word">{label}</span>
                  </label>
                  {locked ? (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Lock aria-hidden className="size-3.5" strokeWidth={1.8} />
                      <Trans>Always first</Trans>
                    </span>
                  ) : (
                    <>
                      <Button
                        variant="quiet"
                        size="small"
                        className="px-2.5"
                        aria-label={t`Move ${label} up`}
                        disabled={index <= 1}
                        onClick={() => {
                          setOrder((current) => moveColumn(current, key, -1));
                        }}
                      >
                        <ArrowUp aria-hidden className="size-4" strokeWidth={1.8} />
                      </Button>
                      <Button
                        variant="quiet"
                        size="small"
                        className="px-2.5"
                        aria-label={t`Move ${label} down`}
                        disabled={index === order.length - 1}
                        onClick={() => {
                          setOrder((current) => moveColumn(current, key, 1));
                        }}
                      >
                        <ArrowDown aria-hidden className="size-4" strokeWidth={1.8} />
                      </Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        {toAdd.length === 0 ? null : (
          <section aria-label={t`Add fields`} className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">
              <Trans>Add fields</Trans>
            </h3>
            {full ? (
              <p className="text-sm text-muted-foreground">
                <Trans>
                  The table shows at most {limitMax} custom fields. Take one away to add another.
                </Trans>
              </p>
            ) : null}
            {groupsOf(toAdd.filter(matches)).map((group) => {
              const list = (
                <ul className="flex flex-col">
                  {group.choices.map(({ key, label }) => {
                    const checked = added.includes(key);
                    return (
                      <li key={key} className={rowClassName}>
                        <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-sm lg:min-h-9">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={!checked && full && limit.applies(key)}
                            onChange={() => {
                              setAdded((current) => toggle(current, key));
                            }}
                            className={checkboxClassName}
                          />
                          <span className="min-w-0 wrap-break-word">{label}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              );
              // A folder of fields opens and closes, as GoHighLevel's do; a search shows
              // every match.
              return group.name === undefined ? (
                <div key="">{list}</div>
              ) : (
                <details key={group.name} open className="group/folder">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-control px-2 text-sm font-medium text-body -outline-offset-2 hover:bg-muted lg:min-h-9">
                    <span className="min-w-0 wrap-break-word">{group.name}</span>
                    <ChevronDown
                      aria-hidden
                      className="size-4 shrink-0 transition-transform group-open/folder:rotate-180"
                      strokeWidth={1.8}
                    />
                  </summary>
                  {list}
                </details>
              );
            })}
          </section>
        )}
        {wanted !== '' && !choices.some(matches) ? (
          <p className="text-sm text-muted-foreground">
            <Trans>No field matches this search.</Trans>
          </p>
        ) : null}
      </div>
      <div className={sidePanelFooterClassName}>
        <Button variant="secondary" onClick={onCancel}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!changed}>
          <Trans>Apply</Trans>
        </Button>
      </div>
    </form>
  );
}
