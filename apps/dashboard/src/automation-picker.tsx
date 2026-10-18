// The list an action or a trigger is chosen from: a categories choice, a search box, and
// the choices in sections that fold, under GoHighLevel's category names
// (automation-catalogue.ts). Only what this install can run is a choice; a step it cannot
// run yet is listed apart, with what it needs. The step panel shows it, and the canvas does
// too, where a row can also be dragged.
import { Trans, useLingui } from '@lingui/react/macro';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { useId, useState, type DragEvent, type ReactElement } from 'react';
import { actionCategories, categorised, matching, triggerCategories } from './automation-catalogue';
import { Tile } from './automation-tile';

export { needsWords } from './automation-setup-words';

export interface PickerItem {
  readonly type: string;
  /** What it is called, such as "Send text". */
  readonly name: string;
  /** One line that says what it does. */
  readonly description: string;
}

export interface PickerProps {
  readonly owner: 'step' | 'trigger';
  readonly items: readonly PickerItem[];
  /** What can't be chosen here yet, each with what it needs. */
  readonly unavailable?: readonly { readonly item: PickerItem; readonly needs: string }[];
  readonly onChoose: (type: string) => void;
  /** On the canvas, a row can also be dragged onto the drawing. */
  readonly onDragStart?: (type: string, event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd?: () => void;
}

const ALL = 'all';

export function Picker({
  owner,
  items,
  unavailable = [],
  onChoose,
  onDragStart,
  onDragEnd,
}: PickerProps): ReactElement {
  const { t, i18n } = useLingui();
  const searchId = useId();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState(ALL);
  const [folded, setFolded] = useState<readonly string[]>([]);
  const categories = owner === 'step' ? actionCategories : triggerCategories;
  const all = categorised(items, categories);
  const sections = categorised(
    matching(items, search, (item) => item.name),
    categories,
  ).filter((section) => category === ALL || section.key === category);
  const searchLabel = owner === 'step' ? t`Search actions` : t`Search triggers`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          aria-label={t`Categories`}
          className="w-auto max-w-full min-w-40"
          value={category}
          onValueChange={setCategory}
        >
          <option value={ALL}>{t`All categories`}</option>
          {all.map((section) => (
            <option key={section.key} value={section.key}>
              {i18n._(section.label)}
            </option>
          ))}
        </Select>
        <div className="relative min-w-0 flex-1 basis-40">
          <label className="sr-only" htmlFor={searchId}>
            {searchLabel}
          </label>
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.8}
          />
          <Input
            id={searchId}
            type="search"
            autoComplete="off"
            data-field-control
            placeholder={searchLabel}
            value={search}
            className="pl-9"
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
      </div>
      {sections.map((section) => {
        const name = i18n._(section.label);
        const open = !folded.includes(section.key);
        return (
          <section key={section.key} aria-label={name} className="flex min-w-0 flex-col gap-1.5">
            <h3 className="text-sm font-medium text-foreground">
              <button
                type="button"
                aria-expanded={open}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-control px-1 text-left -outline-offset-2 hover:bg-muted lg:min-h-9"
                onClick={() => {
                  setFolded((current) =>
                    open ? [...current, section.key] : current.filter((key) => key !== section.key),
                  );
                }}
              >
                {name}
                {open ? (
                  <ChevronDown aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
                ) : (
                  <ChevronRight aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
                )}
              </button>
            </h3>
            {open ? (
              <ul className="flex min-w-0 flex-col gap-1.5">
                {section.items.map((item) => (
                  <li key={item.type}>
                    <button
                      type="button"
                      draggable={onDragStart !== undefined}
                      className={`flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card px-3 py-2 text-left -outline-offset-2 hover:bg-muted ${
                        onDragStart === undefined ? '' : 'cursor-grab'
                      }`}
                      onClick={() => {
                        onChoose(item.type);
                      }}
                      onDragStart={
                        onDragStart === undefined
                          ? undefined
                          : (event) => {
                              onDragStart(item.type, event);
                            }
                      }
                      onDragEnd={onDragEnd}
                    >
                      <Tile owner={owner} type={item.type} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-foreground">{item.name}</span>
                        <span className="text-xs text-muted-foreground">{item.description}</span>
                      </span>
                      <ChevronRight
                        aria-hidden
                        className="size-4 shrink-0 text-muted-foreground"
                        strokeWidth={1.8}
                      />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
      {sections.length === 0 ? (
        <p className="text-md">
          {owner === 'step' ? (
            <Trans>No action matches that.</Trans>
          ) : (
            <Trans>No trigger matches that.</Trans>
          )}
        </p>
      ) : null}
      {unavailable.length === 0 ? null : (
        <section aria-label={t`Not available yet`} className="flex min-w-0 flex-col gap-1.5">
          <h3 className="px-1 text-sm font-medium text-muted-foreground">
            <Trans>Not available yet</Trans>
          </h3>
          <ul className="flex min-w-0 flex-col gap-1.5">
            {unavailable.map(({ item, needs }) => (
              <li
                key={item.type}
                className="flex min-w-0 flex-col gap-0.5 rounded-xl border border-dashed border-input px-3 py-2"
              >
                <span className="text-sm font-medium">{item.name}</span>
                <span className="text-xs text-muted-foreground">{needs}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
