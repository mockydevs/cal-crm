// "Create new funnel" and "Create new website" (GoHighLevel's dialog): from blank with a
// name, or from a template chosen in the template library; and the dialog that imports a
// shared bundle. Fetched when one of them is first opened, so the lists stay light. "Build
// with AI" is not here: nothing the server sends says whether an AI provider is set up for
// building sites.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import {
  createSite,
  importSite,
  listSiteTemplates,
  setSiteTemplateFavorite,
  type Site,
  type SiteKind,
  type SiteTemplateSummary,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Dialog } from '@repo/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, X } from 'lucide-react';
import { useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { apiIn } from './api';
import { ListSearch } from './list-toolbar';
import { noRejection, type Rejection } from './problems';
import {
  iconButtonClassName,
  ListProblem,
  retryFaults,
  returnTo,
  savingProblem,
  SmallDialog,
  useSettled,
} from './settings-list';
import { emptyTrail, trailBack, trailCursor, trailForward } from './settings-rules';
import { FormRefusal, NameDialog } from './sites-dialogs';
import {
  noTemplateFilters,
  templateLists,
  templateQueryOf,
  templatesNarrowed,
  toggled,
  type TemplateFilters,
  type TemplateList,
} from './sites-rules';
import { useBusiness } from './workspace';

interface CreateProps {
  /** The folder the list is showing, which the new site goes into; none at Home. */
  readonly folderId: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onCreated: (site: Site) => void;
}

type Source = 'blank' | 'templates';

export default function SiteCreateDialog({
  kind,
  folderId,
  returnFocus,
  onClose,
  onCreated,
}: CreateProps & { readonly kind: SiteKind }): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const funnel = kind === 'funnel';
  const [source, setSource] = useState<Source>('blank');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  // The library is open, and then the template chosen in it is waiting for a name.
  const [browsing, setBrowsing] = useState(false);
  const [chosen, setChosen] = useState<SiteTemplateSummary>();
  const create = useMutation({
    mutationFn: (input: { readonly name: string; readonly templateId?: string }) =>
      apiIn(business.id).request(createSite, {
        body: { kind, folderId: folderId ?? null, ...input },
      }),
    onSuccess: onCreated,
  });

  if (chosen !== undefined) {
    const chosenName = chosen.name;
    return (
      <NameDialog
        title={funnel ? <Trans>Name your funnel</Trans> : <Trans>Name your website</Trans>}
        label={funnel ? <Trans>Funnel name</Trans> : <Trans>Website name</Trans>}
        hint={<Trans>It starts as a copy of the template {chosenName}.</Trans>}
        initial={chosen.name.slice(0, 120)}
        saveLabel={<Trans>Create</Trans>}
        savingLabel={<Trans>Creating…</Trans>}
        fallback={t`It wasn't created. Check your connection and try again.`}
        returnFocus={returnFocus}
        onClose={onClose}
        save={(named) => create.mutateAsync({ name: named, templateId: chosen.id })}
      />
    );
  }
  if (browsing) {
    return (
      <TemplateLibrary
        kind={kind}
        returnFocus={returnFocus}
        onClose={onClose}
        onChoose={setChosen}
      />
    );
  }

  const ready = (source === 'templates' || name.trim() !== '') && !create.isPending;
  const tileClassName =
    'flex min-w-0 cursor-pointer items-start gap-3 rounded-card border border-border p-3 has-checked:border-primary has-checked:bg-accent';
  const tileTextClassName = 'flex min-w-0 flex-col gap-0.5 text-sm text-muted-foreground';
  const tileTitleClassName = 'font-medium text-foreground';
  return (
    <SmallDialog
      open
      title={funnel ? <Trans>Create new funnel</Trans> : <Trans>Create new website</Trans>}
      returnFocus={returnFocus}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          if (source === 'templates') {
            setBrowsing(true);
            return;
          }
          setProblem(noRejection);
          create.mutate(
            { name: name.trim() },
            {
              onError: (error) => {
                setProblem(
                  savingProblem(error, t`It wasn't created. Check your connection and try again.`),
                );
              },
            },
          );
        }}
      >
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="sr-only">
            <Trans>How to start</Trans>
          </legend>
          <label className={tileClassName}>
            <input
              type="radio"
              name="source"
              className="mt-1 size-4 shrink-0"
              checked={source === 'blank'}
              onChange={() => {
                setSource('blank');
              }}
            />
            <span className={tileTextClassName}>
              <span className={tileTitleClassName}>
                <Trans>From blank</Trans>
              </span>
              {funnel ? (
                <Trans>Design from scratch using the funnel builder.</Trans>
              ) : (
                <Trans>Design from scratch using the website builder.</Trans>
              )}
            </span>
          </label>
          <label className={tileClassName}>
            <input
              type="radio"
              name="source"
              className="mt-1 size-4 shrink-0"
              checked={source === 'templates'}
              onChange={() => {
                setSource('templates');
              }}
            />
            <span className={tileTextClassName}>
              <span className={tileTitleClassName}>
                <Trans>From templates</Trans>
              </span>
              {funnel ? (
                <Trans>Jump start with an awesome prebuilt funnel</Trans>
              ) : (
                <Trans>Jump start with an awesome prebuilt website</Trans>
              )}
            </span>
          </label>
        </fieldset>
        {source === 'blank' ? (
          <Field name="name" invalid={problem.fields['name'] !== undefined}>
            <FieldLabel>
              {funnel ? <Trans>Funnel name</Trans> : <Trans>Website name</Trans>}
            </FieldLabel>
            <Input
              required
              maxLength={120}
              autoComplete="off"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(noRejection);
              }}
            />
            {problem.fields['name'] === undefined ? null : (
              <FieldError match>{problem.fields['name']}</FieldError>
            )}
          </Field>
        ) : null}
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={create.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {source === 'templates' ? (
              <Trans>Continue</Trans>
            ) : create.isPending ? (
              <Trans>Creating…</Trans>
            ) : (
              <Trans>Create</Trans>
            )}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}

const libraryClassName =
  'fixed top-1/2 left-1/2 z-[65] flex h-[calc(100dvh-32px)] w-[min(1200px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-card bg-card text-card-foreground shadow-xl outline-none';
const sideButtonClassName =
  'flex min-h-11 w-full items-center rounded-control px-3 text-left text-sm text-body -outline-offset-2 hover:bg-muted aria-pressed:bg-accent aria-pressed:font-medium aria-pressed:text-link lg:min-h-9';

/** A filter that folds: the values the server offers, each with how many templates have it. */
function Facet({
  title,
  values,
  ticked,
  onToggle,
}: {
  readonly title: ReactNode;
  readonly values: readonly { readonly value: string; readonly count: number }[];
  readonly ticked: readonly string[];
  readonly onToggle: (value: string) => void;
}): ReactElement | null {
  // The server takes several values with commas between them, so one that holds a comma
  // could not be asked for.
  const offered = values.filter((each) => !each.value.includes(','));
  return offered.length === 0 ? null : (
    <details open className="border-t border-border pt-2">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-control px-1 text-sm font-medium lg:min-h-9">
        {title}
      </summary>
      <ul className="flex flex-col">
        {offered.map((each) => (
          <li key={each.value}>
            <label className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-sm lg:min-h-8">
              <input
                type="checkbox"
                className="size-4 shrink-0"
                checked={ticked.includes(each.value)}
                onChange={() => {
                  onToggle(each.value);
                }}
              />
              <span className="min-w-0 flex-1 wrap-anywhere">{each.value}</span>
              <span className="text-muted-foreground">{each.count}</span>
            </label>
          </li>
        ))}
      </ul>
    </details>
  );
}

function TemplateLibrary({
  kind,
  returnFocus,
  onClose,
  onChoose,
}: {
  readonly kind: SiteKind;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onChoose: (template: SiteTemplateSummary) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const cache = useQueryClient();
  const funnel = kind === 'funnel';
  const [filters, setFilters] = useState<TemplateFilters>(noTemplateFilters);
  const [text, setText] = useState('');
  const settled = useSettled(text);
  const [trail, setTrail] = useState(emptyTrail);
  const [notice, setNotice] = useState('');
  const change = (next: Partial<TemplateFilters>): void => {
    setFilters((now) => ({ ...now, ...next }));
    setTrail(emptyTrail);
  };
  // Another search starts at its first page.
  const [searched, setSearched] = useState(settled);
  if (searched !== settled) {
    setSearched(settled);
    setTrail(emptyTrail);
  }
  const asking = { ...filters, text: settled };
  const query = templateQueryOf(kind, asking, trailCursor(trail));
  const templatesKey = ['b', business.id, 'sites', 'templates'] as const;
  const templates = useQuery({
    queryKey: [...templatesKey, query] as const,
    queryFn: () => apiIn(business.id).request(listSiteTemplates, { query }),
    placeholderData: keepPreviousData,
    retry: retryFaults,
  });
  const words = {
    favorite: (name: string) => t`${name} is in your favorites.`,
    notFavorite: (name: string) => t`${name} is no longer in your favorites.`,
    choose: (name: string) => t`Choose ${name}`,
    mark: (name: string) => t`Favorite ${name}`,
  };
  const favorite = useMutation({
    mutationFn: (template: SiteTemplateSummary) =>
      apiIn(business.id).request(setSiteTemplateFavorite, {
        params: { id: template.id },
        body: { favorite: !template.favorite },
      }),
    onSuccess: async (saved) => {
      await cache.invalidateQueries({ queryKey: templatesKey });
      setNotice(saved.favorite ? words.favorite(saved.name) : words.notFavorite(saved.name));
    },
    onError: () => {
      setNotice(t`Your favorites weren't changed. Check your connection and try again.`);
    },
  });
  const listed = templates.data;
  const items = listed?.items ?? [];
  const listNames = {
    all: <Trans>All templates</Trans>,
    mine: <Trans>My templates</Trans>,
    shared: <Trans>Shared with me</Trans>,
    favorites: <Trans>Favorites</Trans>,
  } satisfies Record<TemplateList, ReactNode>;
  const title = funnel ? t`Funnel templates` : t`Website templates`;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-60 bg-foreground/40" />
        <Dialog.Popup className={libraryClassName} finalFocus={returnTo(returnFocus)}>
          <div className="flex min-w-0 items-center justify-between gap-3 border-b px-4 py-3">
            <Dialog.Title className="text-lg font-medium">{title}</Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="quiet" size="small" className="px-2.5" aria-label={t`Close`} />
              }
            >
              <X aria-hidden className="size-5" strokeWidth={1.8} />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
            <aside
              aria-label={t`Template lists and filters`}
              className="flex shrink-0 flex-col gap-2 border-b p-3 md:w-64 md:overflow-y-auto md:border-r md:border-b-0"
            >
              <div role="group" aria-label={t`Template lists`} className="flex flex-col gap-0.5">
                {templateLists.map((list) => (
                  <button
                    key={list}
                    type="button"
                    aria-pressed={filters.list === list}
                    className={sideButtonClassName}
                    onClick={() => {
                      change({ list });
                    }}
                  >
                    {listNames[list]}
                  </button>
                ))}
              </div>
              <Facet
                title={<Trans>Browse categories</Trans>}
                values={listed?.facets.categories ?? []}
                ticked={filters.categories}
                onToggle={(value) => {
                  change({ categories: toggled(filters.categories, value) });
                }}
              />
              <Facet
                title={<Trans>Types</Trans>}
                values={listed?.facets.types ?? []}
                ticked={filters.types}
                onToggle={(value) => {
                  change({ types: toggled(filters.types, value) });
                }}
              />
              <Facet
                title={<Trans>Tags</Trans>}
                values={listed?.facets.tags ?? []}
                ticked={filters.tags}
                onToggle={(value) => {
                  change({ tags: toggled(filters.tags, value) });
                }}
              />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2">
                <ListSearch label={t`Search templates`} value={text} onChange={setText} />
                <div className="w-48">
                  <Select
                    aria-label={t`Sort templates`}
                    value={filters.sort}
                    onValueChange={(sort) => {
                      change({ sort: sort === 'popular' ? 'popular' : 'recent' });
                    }}
                  >
                    <option value="recent">{t`Recently added`}</option>
                    <option value="popular">{t`Most popular`}</option>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-sm">
                {listed === undefined ? null : (
                  <p role="status">
                    <Plural
                      value={listed.total}
                      one="Showing # template"
                      other="Showing # templates"
                    />
                  </p>
                )}
                {templatesNarrowed(asking) ? (
                  <Button
                    variant="quiet"
                    size="small"
                    onClick={() => {
                      setText('');
                      change({ categories: [], types: [], tags: [] });
                    }}
                  >
                    <Trans>Clear filters</Trans>
                  </Button>
                ) : null}
              </div>
              <p role="status" aria-live="polite" className="text-sm text-body empty:hidden">
                {notice}
              </p>
              {templates.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  <Trans>Loading templates…</Trans>
                </p>
              ) : null}
              {templates.isError ? (
                <ListProblem
                  onRetry={() => {
                    setTrail(emptyTrail);
                    void templates.refetch();
                  }}
                >
                  <Trans>The templates couldn't be loaded.</Trans>
                </ListProblem>
              ) : null}
              {listed !== undefined && items.length === 0 ? (
                <p className="py-10 text-center text-md text-muted-foreground">
                  {templatesNarrowed(asking) ? (
                    <Trans>No templates match.</Trans>
                  ) : filters.list === 'favorites' ? (
                    <Trans>You have no favorite templates yet.</Trans>
                  ) : filters.list === 'mine' ? (
                    <Trans>This business has saved no templates yet.</Trans>
                  ) : filters.list === 'shared' ? (
                    <Trans>No templates have been shared with this business yet.</Trans>
                  ) : (
                    <Trans>There are no templates yet.</Trans>
                  )}
                </p>
              ) : null}
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
                {items.map((template) => (
                  <li
                    key={template.id}
                    className="flex min-w-0 flex-col gap-2 rounded-card border border-border p-3"
                  >
                    <div aria-hidden className="flex h-28 overflow-hidden rounded-control bg-muted">
                      {template.colors.map((color) => (
                        <span key={color} className="flex-1" style={{ backgroundColor: color }} />
                      ))}
                    </div>
                    <h3 className="text-sm font-medium wrap-anywhere">{template.name}</h3>
                    {template.description === '' ? null : (
                      <p className="line-clamp-3 text-sm text-muted-foreground">
                        {template.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {[template.category, template.pageType]
                        .filter((each) => each !== null)
                        .join(' · ')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {funnel ? (
                        <Plural value={template.stepCount} one="# step" other="# steps" />
                      ) : (
                        <Plural value={template.stepCount} one="# page" other="# pages" />
                      )}
                      {' · '}
                      <Plural value={template.uses} one="used # time" other="used # times" />
                    </p>
                    <div className="mt-auto flex items-center justify-between gap-2">
                      <Button
                        size="small"
                        aria-label={words.choose(template.name)}
                        onClick={() => {
                          onChoose(template);
                        }}
                      >
                        <Trans>Choose</Trans>
                      </Button>
                      <button
                        type="button"
                        className={iconButtonClassName}
                        aria-pressed={template.favorite}
                        aria-label={words.mark(template.name)}
                        disabled={favorite.isPending}
                        onClick={() => {
                          setNotice('');
                          favorite.mutate(template);
                        }}
                      >
                        <Heart
                          aria-hidden
                          className={`size-[18px] ${template.favorite ? 'fill-current text-destructive' : ''}`}
                          strokeWidth={1.8}
                        />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              {listed !== undefined && (trail.index > 0 || listed.next !== null) ? (
                <nav aria-label={t`Template pages`} className="flex justify-end gap-2">
                  <Button
                    variant="quiet"
                    size="small"
                    disabled={trail.index === 0 || templates.isFetching}
                    onClick={() => {
                      setTrail(trailBack);
                    }}
                  >
                    <Trans>Previous</Trans>
                  </Button>
                  <Button
                    variant="quiet"
                    size="small"
                    disabled={listed.next === null || templates.isFetching}
                    onClick={() => {
                      setTrail(trailForward(trail, listed.next));
                    }}
                  >
                    <Trans>Next</Trans>
                  </Button>
                </nav>
              ) : null}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Imports a bundle another business of the agency exported with Share. */
export function SiteImportDialog({
  folderId,
  returnFocus,
  onClose,
  onCreated,
}: CreateProps): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const [bundle, setBundle] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const bring = useMutation({
    mutationFn: () =>
      apiIn(business.id).request(importSite, {
        body: {
          bundle: bundle.trim(),
          folderId: folderId ?? null,
          ...(name.trim() === '' ? {} : { name: name.trim() }),
        },
      }),
    onSuccess: onCreated,
    onError: (error) => {
      setProblem(savingProblem(error, t`It wasn't imported. Check your connection and try again.`));
    },
  });
  const ready = bundle.trim() !== '' && !bring.isPending;
  return (
    <SmallDialog
      open
      title={<Trans>Import a shared funnel or website</Trans>}
      description={
        <Trans>
          Paste the text that Share gave in another business of this agency. It arrives as a copy,
          unpublished.
        </Trans>
      }
      returnFocus={returnFocus}
      onClose={() => {
        if (!bring.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setProblem(noRejection);
          bring.mutate();
        }}
      >
        <Field name="bundle" invalid={problem.fields['bundle'] !== undefined}>
          <FieldLabel>
            <Trans>Shared text</Trans>
          </FieldLabel>
          <Textarea
            required
            rows={5}
            className="font-mono text-xs break-all"
            value={bundle}
            onChange={(event) => {
              setBundle(event.target.value);
            }}
          />
          {problem.fields['bundle'] === undefined ? null : (
            <FieldError match>{problem.fields['bundle']}</FieldError>
          )}
        </Field>
        <Field name="name" invalid={problem.fields['name'] !== undefined}>
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            maxLength={120}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <FieldDescription>
            <Trans>Leave blank to keep the name it was shared under.</Trans>
          </FieldDescription>
          {problem.fields['name'] === undefined ? null : (
            <FieldError match>{problem.fields['name']}</FieldError>
          )}
        </Field>
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={bring.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {bring.isPending ? <Trans>Importing…</Trans> : <Trans>Import</Trans>}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
