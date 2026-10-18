// A trigger's filters, compact: only the filters that are set are on the panel, and "Add
// filters" is a menu of what can still be added: a lead source, a session source, an answer
// of the form, or any other field. A lead source or a session source is a row of chips with
// a list that can be searched, never every name at once. And the form a "Form submitted"
// trigger names, as a list that can be searched, where a form that is still a draft is
// offered and named as one.
//
// A filter only narrows which events start the workflow. It never changes what is kept of
// how a contact arrived.
//
// Its words are in the builder's own catalog (lingui.config.ts, automation-words.ts).
import { Trans, useLingui } from '@lingui/react/macro';
import { MAX_TRIGGER_SOURCES } from '@repo/contracts';
import type { Client } from '@repo/sdk';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { FieldSpec } from './automation-fields';
import type { FilterRow } from './automation-filters';
import { customSources, leadSourceNames, sourcesOf } from './automation-lead-sources';
import { answerRow, type AnswerField, type BuilderSetup } from './automation-submission';
import {
  addableCompactFilters,
  formOptions,
  formState,
  formStateWords,
  shownCompactFilters,
  type FormRecord,
} from './automation-trigger-filters';
import { SearchPicker } from './search-picker';
import type { PickerItem } from './search-picker-rules';

/** A new row: no field yet (automation-filters.ts, emptyRow). */
const emptyRow: FilterRow = { field: '', operator: 'equals', value: undefined };

/**
 * The business's forms that are not archived, with whether each is published: read once
 * for a panel, so a draft a trigger names is called by its name. Nothing while they are
 * being read, or when they cannot be: the panel then says only what the setup knows.
 */
function useFormRecords(client: Client | undefined): readonly FormRecord[] | undefined {
  const [records, setRecords] = useState<readonly FormRecord[]>();
  // A client is made anew each time the builder draws: the forms are read once a panel.
  const clientRef = useRef(client);
  const readable = client !== undefined;
  useEffect(() => {
    const client = clientRef.current;
    if (client === undefined) return undefined;
    let current = true;
    // The forms' own contract comes with the read, apart from the panel.
    const read = async (): Promise<void> => {
      const { readFormRecords } = await import('./automation-form-records');
      const found = await readFormRecords(client);
      if (current) setRecords(found);
    };
    read().catch(() => {
      // Not being able to read them is not a failure of the panel: it says less.
      if (current) setRecords(undefined);
    });
    return () => {
      current = false;
    };
  }, [readable]);
  return records;
}

/** "Form is": the form a trigger starts for, or any form. */
export function FormChoice({
  id,
  label,
  value,
  setup,
  client,
  problem,
  describedBy,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly setup: BuilderSetup;
  /** The business's API, to name a form that is a draft; without it, only the setup's forms. */
  readonly client: Client | undefined;
  /** What the checks said of the form, when it is not about its being unpublished. */
  readonly problem: string | undefined;
  readonly describedBy: string | undefined;
  readonly onChange: (form: string | undefined) => void;
}): ReactElement {
  const { t } = useLingui();
  const records = useFormRecords(client);
  // Without a way to read the forms, what the setup lacks is said to be missing.
  const state = formState(value, setup.forms, client === undefined ? [] : records);
  const any = t`Any form`;
  const items: PickerItem[] = [
    { id: '', name: any },
    ...formOptions(setup.forms, records).map((form) => ({
      id: form.id,
      name: form.name,
      mark: form.mark,
    })),
  ];
  const chosen =
    state.kind === 'any'
      ? ''
      : state.kind === 'checking' || state.kind === 'missing'
        ? state.written
        : state.id;
  const words = formStateWords(state);
  const archivedName = state.kind === 'archived' ? state.name : '';
  const stateId = `${id}-state`;
  // A draft or an archived form is said in its own words: the checks' "no such form" is not.
  const shownProblem = words === undefined ? problem : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <SearchPicker
        id={id}
        control
        label={label}
        placeholder={any}
        searchLabel={t`Search forms`}
        items={items}
        selected={[chosen]}
        unlisted={(written) =>
          state.kind === 'archived'
            ? t`${archivedName} (archived)`
            : state.kind === 'missing'
              ? t`${written} (not found)`
              : written
        }
        empty={t`No forms match.`}
        none={t`This business has no forms yet.`}
        invalid={words !== undefined || shownProblem !== undefined}
        describedBy={
          [describedBy, words === undefined ? undefined : stateId]
            .filter((each) => each !== undefined)
            .join(' ') || undefined
        }
        onChange={([next]) => {
          onChange(next === undefined || next === '' ? undefined : next);
        }}
      />
      {words === undefined ? null : (
        <p id={stateId} className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
          {state.kind === 'draft' ? (
            <span className="rounded-full bg-attention px-2 py-0.5 text-xs font-medium text-attention-foreground">
              <Trans>Draft</Trans>
            </span>
          ) : null}
          <span
            className={
              state.kind === 'draft' ? 'text-muted-foreground' : 'font-medium text-destructive'
            }
          >
            {words}
          </span>
        </p>
      )}
      {shownProblem === undefined ? null : (
        <p className="text-sm font-medium text-destructive">{shownProblem}</p>
      )}
    </div>
  );
}

/** One compact filter: what it is, the chosen as chips, and the list to choose from. */
function CompactFilter({
  field,
  value,
  onChange,
  onRemove,
}: {
  readonly field: FieldSpec;
  readonly value: unknown;
  readonly onChange: (next: string[] | undefined) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const name = i18n._(field.label);
  const chosen = sourcesOf(value);
  const sources = field.key === 'sources';
  const items: PickerItem[] = sources
    ? [...leadSourceNames, ...customSources(chosen)].map((each) => ({ id: each, name: each }))
    : field.input.kind === 'choices'
      ? field.input.options.map((option) => ({
          id: option.value,
          name: i18n._(option.label),
        }))
      : [];
  const nameOf = (id: string): string =>
    sources ? id : (items.find((item) => item.id === id)?.name ?? id);
  // A lead source is compared without regard to capitals: a name is chosen once.
  const selected = sources
    ? chosen.map(
        (each) => items.find((item) => item.id.toLowerCase() === each.toLowerCase())?.id ?? each,
      )
    : chosen;
  const full = sources && chosen.length >= MAX_TRIGGER_SOURCES;
  const set = (next: readonly string[]): void => {
    onChange(next.length === 0 ? undefined : [...next]);
  };
  return (
    <li
      data-setting={field.key}
      className="flex min-w-0 items-start gap-2 rounded-xl border border-border p-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">{name}</span>
        {chosen.length === 0 ? null : (
          <ul aria-label={name} className="flex min-w-0 list-none flex-wrap gap-1.5 p-0">
            {selected.map((each) => {
              const shown = nameOf(each);
              return (
                <li
                  key={each}
                  className="flex max-w-full min-w-0 items-center gap-0.5 rounded-full bg-secondary py-0.5 pr-0.5 pl-2.5 text-sm font-medium text-secondary-foreground"
                >
                  <span className="min-w-0 wrap-anywhere">{shown}</span>
                  <button
                    type="button"
                    aria-label={t`Remove ${shown}`}
                    title={t`Remove ${shown}`}
                    className="flex size-6 shrink-0 items-center justify-center rounded-full outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      set(selected.filter((other) => other !== each));
                    }}
                  >
                    <X aria-hidden className="size-3.5" strokeWidth={2.2} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <SearchPicker
          control
          multiple
          label={name}
          placeholder={
            sources
              ? full
                ? t`That is the most a trigger can list`
                : t`Choose lead sources`
              : t`Choose session sources`
          }
          searchLabel={sources ? t`Search or type a lead source` : t`Search session sources`}
          items={items}
          selected={selected}
          {...(sources && !full ? { ownUpTo: 200 } : {})}
          empty={t`Nothing matches.`}
          none={t`Nothing to choose from.`}
          onChange={(next) => {
            // At the most a trigger lists, a row can still be unticked.
            if (full && next.length > selected.length) return;
            set(next);
          }}
        />
        <p className="text-sm text-muted-foreground">
          {chosen.length === 0 ? (
            <Trans>Nothing is chosen yet, so this filter lets every lead through.</Trans>
          ) : sources ? (
            <Trans>
              Starts only for a lead whose source is one of these. The source is worked out from how
              the lead arrived; this filter never changes it.
            </Trans>
          ) : (
            <Trans>
              Starts only for a lead that arrived through one of these channels. This filter never
              changes how a lead is recorded.
            </Trans>
          )}
        </p>
      </div>
      <button
        type="button"
        aria-label={t`Remove filter: ${name}`}
        title={t`Remove filter: ${name}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-control text-body hover:bg-secondary hover:text-foreground lg:size-9"
        onClick={onRemove}
      >
        <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
      </button>
    </li>
  );
}

export interface TriggerFiltersProps {
  /** The id of the heading that names the group. */
  readonly labelId: string;
  /** The trigger's settings that are filters (its lead sources, its session sources). */
  readonly fields: readonly FieldSpec[];
  readonly config: Readonly<Record<string, unknown>>;
  /** The answers of the form this trigger names, which a filter can read. */
  readonly answers: readonly AnswerField[];
  /** The rows of the trigger's condition; nothing when rows can't hold it. */
  readonly rows: readonly FilterRow[] | undefined;
  /** The condition as it reads, for one that rows can't hold. */
  readonly writtenWords: string;
  /** The editor of the rows (automation-filter-editor.tsx), which the panel already has. */
  readonly children: ReactNode;
  readonly onSet: (key: string, value: unknown) => void;
  readonly onRows: (rows: FilterRow[]) => void;
  readonly onEditInJson: (() => void) | undefined;
}

export default function TriggerFilters({
  labelId,
  fields,
  config,
  answers,
  rows,
  writtenWords,
  children,
  onSet,
  onRows,
  onEditInJson,
}: TriggerFiltersProps): ReactElement {
  const { t } = useLingui();
  const groupRef = useRef<HTMLDivElement>(null);
  // The filters added here and not filled in yet: they stay until taken off.
  const [opened, setOpened] = useState<readonly string[]>([]);
  // What was just added, by its setting, or 'row': the keyboard goes to it as the menu closes.
  const addedRef = useRef<string | undefined>(undefined);
  const keys = fields.map((field) => field.key);
  const shown = shownCompactFilters(keys, config, opened);
  const addable = addableCompactFilters(keys, shown);
  // An answer to a question of the form; the page it was sent from is "another field".
  const [firstAnswer] = answers.filter((answer) => answer.path.startsWith('trigger.answers.'));
  const none = shown.length === 0 && (rows?.length ?? 0) === 0;

  // What was added is drawn a moment after the menu closes: the keyboard goes to it then.
  const [focusing, setFocusing] = useState<string>();
  useEffect(() => {
    if (focusing === undefined) return undefined;
    let tries = 0;
    let held = 0;
    let frame = 0;
    const focus = (): void => {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- a selector, not words
      const rowControl = '[data-filter-rows] > li:last-child [data-field-control]';
      const selector =
        focusing === 'row'
          ? rowControl
          : // eslint-disable-next-line lingui/no-unlocalized-strings -- a selector, not words
            `[data-setting="${focusing}"] [data-field-control]`;
      const control = groupRef.current?.querySelector<HTMLElement>(selector);
      tries += 1;
      // While the menu is closing the panel does not take the keyboard, and as it closes
      // the keyboard may be handed back to the menu's button: asked until it has stayed.
      const active = document.activeElement;
      // The person has gone on to something else (the list just opened, say): left alone.
      const elsewhere =
        active instanceof HTMLElement &&
        active !== control &&
        // eslint-disable-next-line lingui/no-unlocalized-strings -- a selector, not words
        active.matches('input, textarea, select, [role="combobox"]');
      if (active === control) held += 1;
      else if (!elsewhere) {
        held = 0;
        control?.focus();
      }
      if (!elsewhere && held < 3 && tries < 40) frame = requestAnimationFrame(focus);
      else setFocusing(undefined);
    };
    frame = requestAnimationFrame(focus);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusing]);
  const added = (): boolean => {
    const what = addedRef.current;
    addedRef.current = undefined;
    if (what === undefined) return true;
    setFocusing(what);
    return false;
  };

  return (
    <div
      ref={groupRef}
      role="group"
      aria-labelledby={labelId}
      data-setting="filters"
      className="flex min-w-0 flex-col gap-2"
    >
      <span id={labelId} className="text-xs font-medium tracking-wider text-body uppercase">
        <Trans>Filters</Trans>
      </span>
      {none && rows !== undefined ? (
        <p className="text-sm text-muted-foreground">
          <Trans>No filters applied: every event of this kind starts the workflow.</Trans>
        </p>
      ) : null}
      {shown.length === 0 ? null : (
        <ul aria-label={t`Source filters`} className="flex min-w-0 list-none flex-col gap-3 p-0">
          {shown.map((key) => {
            const field = fields.find((each) => each.key === key);
            return field === undefined ? null : (
              <CompactFilter
                key={key}
                field={field}
                value={config[key]}
                onChange={(next) => {
                  onSet(key, next);
                }}
                onRemove={() => {
                  setOpened((current) => current.filter((each) => each !== key));
                  onSet(key, undefined);
                }}
              />
            );
          })}
        </ul>
      )}
      {rows === undefined ? (
        <div className="flex min-w-0 flex-col items-start gap-2 rounded-xl border border-dashed border-input px-3.5 py-3">
          <span className="max-w-full text-md wrap-anywhere">{writtenWords}</span>
          <span className="text-sm text-muted-foreground">
            <Trans>These filters are edited in the JSON view.</Trans>
          </span>
          {onEditInJson === undefined ? null : (
            <Button type="button" variant="secondary" size="small" onClick={onEditInJson}>
              <Trans>Edit in JSON</Trans>
            </Button>
          )}
        </div>
      ) : (
        children
      )}
      {addable.length === 0 && firstAnswer === undefined ? (
        // One thing can be added: the button adds it, with no menu of one line to open.
        rows === undefined ? null : (
          <Button
            type="button"
            variant="quiet"
            size="small"
            className="self-start text-link hover:text-link"
            onClick={() => {
              onRows([...rows, emptyRow]);
            }}
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add filters</Trans>
          </Button>
        )
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="quiet"
                size="small"
                className="self-start text-link hover:text-link"
              />
            }
          >
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            <Trans>Add filters</Trans>
          </DropdownMenuTrigger>
          {/* Drawn inside this group, which is inside the panel: at the end of the page it
              would be under the panel. The keyboard goes to what was added, not back to
              this button. */}
          <DropdownMenuContent container={groupRef} finalFocus={added}>
            {addable.map((key) => (
              <DropdownMenuItem
                key={key}
                onClick={() => {
                  setOpened((current) => [...current, key]);
                  addedRef.current = key;
                }}
              >
                {key === 'sources' ? <Trans>Lead source</Trans> : <Trans>Session source</Trans>}
              </DropdownMenuItem>
            ))}
            {rows === undefined || firstAnswer === undefined ? null : (
              <DropdownMenuItem
                onClick={() => {
                  onRows([...rows, answerRow(firstAnswer)]);
                  addedRef.current = 'row';
                }}
              >
                <Trans>An answer on the form</Trans>
              </DropdownMenuItem>
            )}
            {rows === undefined ? null : (
              <DropdownMenuItem
                onClick={() => {
                  onRows([...rows, emptyRow]);
                  addedRef.current = 'row';
                }}
              >
                <Trans>Another field</Trans>
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
