// The library as a compact table: a tick box, the name with the subject under it, the type,
// the workflows that use it (a button that lists them), the folder and when it was last
// changed, then Open (shown on hover) and the template's menu.
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { MessageTemplateSummary } from '@repo/contracts';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@repo/ui/components/popover';
import { Button } from '@repo/ui/components/button';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactElement } from 'react';
import { apiIn } from '../api';
import {
  compactCellClassName,
  compactHeaderClassName,
  hoverOpenClassName,
  nameButtonClassName,
  rowClassName,
  Tag,
  TickBox,
  wideOnlyClassName,
} from '../email-library/table';
import { tableClassName, tableRegionClassName } from '../list-table';
import { RowMenu, type RowAction } from '../email-library/row-menu';
import { useBusiness } from '../workspace';

export interface RowProps {
  readonly item: MessageTemplateSummary;
  readonly ticked: boolean;
  readonly onTick: (on: boolean) => void;
  readonly actions: readonly RowAction[];
  readonly onOpen: (() => void) | undefined;
  readonly onMenu: (trigger: HTMLElement | null) => void;
  /** When it was last changed, or put in the trash, as the reader reads dates. */
  readonly when: string;
}

/** Designed or plain text, as a small pill. */
export function TypeTag({ format }: { readonly format: 'text' | 'html' }): ReactElement {
  return <Tag>{format === 'html' ? <Trans>Designed</Trans> : <Trans>Plain text</Trans>}</Tag>;
}

/**
 * How many workflows use a template. A number above none is a button: it lists the
 * workflows, each a way to open it in the builder.
 */
export function UsedIn({
  template,
}: {
  readonly template: Pick<MessageTemplateSummary, 'id' | 'name' | 'workflowUses'>;
}): ReactElement | null {
  const { t } = useLingui();
  const business = useBusiness();
  const [open, setOpen] = useState(false);
  const uses = useQuery({
    queryKey: ['b', business.id, 'template-workflow-actions', template.id],
    // The workflows' contract arrives with the first look, not with the page.
    queryFn: async () =>
      apiIn(business.id).request(
        (await import('../template-workflow-api')).listTemplateWorkflowActions,
        { params: { id: template.id }, query: { limit: 100 } },
      ),
    enabled: open,
    staleTime: 60_000,
    retry: false,
  });
  const count = template.workflowUses;
  if (count === null || count === undefined) return null;
  if (count === 0)
    return (
      <span className="text-xs text-muted-foreground">
        <Trans>Not used</Trans>
      </span>
    );
  const { name } = template;
  const label = plural(count, { one: 'Used in # workflow', other: 'Used in # workflows' });
  // One workflow can use a template in its draft and in its running version: listed once.
  const workflows = [
    ...new Map(
      (uses.data?.items ?? []).map((action) => [action.automation.id, action.automation]),
    ).values(),
  ];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="rounded-control text-left text-xs font-medium whitespace-nowrap text-link -outline-offset-2 hover:underline"
        aria-label={t`${label}: ${name}`}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent className="w-72">
        <PopoverTitle>{t`Workflows using ${name}`}</PopoverTitle>
        {uses.isPending ? <p role="status" className="text-sm">{t`Loading…`}</p> : null}
        {uses.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {t`The workflows could not be loaded.`}
          </p>
        ) : null}
        {workflows.length === 0 ? null : (
          <ul className="flex flex-col gap-1">
            {workflows.map((workflow) => (
              <li key={workflow.id} className="min-w-0">
                <Link
                  to="/b/$slug/automations"
                  params={{ slug: business.slug }}
                  search={{ automation: workflow.id }}
                  className="block truncate rounded-control py-1 text-sm text-link -outline-offset-2 hover:underline"
                >
                  {workflow.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

export function TemplateTable({
  rows,
  page,
  onTickPage,
  whenLabel,
  canTick,
}: {
  readonly rows: readonly RowProps[];
  readonly page: boolean | 'some';
  readonly onTickPage: (on: boolean) => void;
  /** "Updated", or "Deleted" in the trash. */
  readonly whenLabel: string;
  readonly canTick: boolean;
}): ReactElement {
  const { t } = useLingui();
  return (
    <div className={tableRegionClassName}>
      <table className={`${tableClassName} min-w-[34rem] table-fixed`}>
        <thead>
          <tr>
            {canTick ? (
              <th scope="col" className={`${compactHeaderClassName} w-12 px-1`}>
                <TickBox
                  label={t`Select all templates on this page`}
                  checked={page}
                  onChange={onTickPage}
                />
              </th>
            ) : null}
            <th scope="col" className={`${compactHeaderClassName} w-[44%] min-w-56`}>
              <Trans>Name</Trans>
            </th>
            <th scope="col" className={`${compactHeaderClassName} ${wideOnlyClassName} w-28`}>
              <Trans>Type</Trans>
            </th>
            <th scope="col" className={`${compactHeaderClassName} w-40`}>
              <Trans>Workflows</Trans>
            </th>
            <th scope="col" className={`${compactHeaderClassName} hidden w-36 xl:table-cell`}>
              <Trans>Folder</Trans>
            </th>
            <th scope="col" className={`${compactHeaderClassName} ${wideOnlyClassName} w-40`}>
              {whenLabel}
            </th>
            <th scope="col" className={`${compactHeaderClassName} w-28`}>
              <span className="sr-only">
                <Trans>Actions</Trans>
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <TemplateRow key={row.item.id} {...row} canTick={canTick} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TemplateRow({
  item,
  ticked,
  onTick,
  actions,
  onOpen,
  onMenu,
  when,
  canTick,
}: RowProps & { readonly canTick: boolean }): ReactElement {
  const { t } = useLingui();
  const { name } = item;
  return (
    <tr className={rowClassName} data-ticked={ticked ? true : undefined}>
      {canTick ? (
        <td className={`${compactCellClassName} px-1`}>
          <TickBox label={t`Select ${name}`} checked={ticked} onChange={onTick} />
        </td>
      ) : null}
      <td className={compactCellClassName}>
        <div className="flex min-w-0 flex-col">
          {onOpen === undefined ? (
            <span className="truncate font-medium text-foreground">{name}</span>
          ) : (
            <button type="button" className={nameButtonClassName} onClick={onOpen}>
              {name}
            </button>
          )}
          <span className="truncate text-xs text-muted-foreground">{item.subject}</span>
        </div>
      </td>
      <td className={`${compactCellClassName} ${wideOnlyClassName}`}>
        <TypeTag format={item.format} />
      </td>
      <td className={compactCellClassName}>
        <UsedIn template={item} />
      </td>
      <td className={`${compactCellClassName} hidden truncate xl:table-cell`}>
        {item.folder === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="truncate" title={item.folder.path.join(' / ')}>
            {item.folder.name}
          </span>
        )}
      </td>
      <td className={`${compactCellClassName} ${wideOnlyClassName} text-xs whitespace-nowrap`}>
        {when}
      </td>
      <td className={`${compactCellClassName} text-right`}>
        <div className="flex items-center justify-end gap-1">
          {onOpen === undefined ? null : (
            <Button
              size="small"
              variant="secondary"
              className={hoverOpenClassName}
              aria-label={t`Open ${name}`}
              onClick={onOpen}
            >
              <Trans>Open</Trans>
            </Button>
          )}
          {actions.length === 0 ? null : (
            <RowMenu label={t`Actions for ${name}`} actions={actions} onOpen={onMenu} />
          )}
        </div>
      </td>
    </tr>
  );
}
