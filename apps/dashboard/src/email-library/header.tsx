// The top of each Emails page (Campaigns and Templates), the same on both: the switch
// between the two pages, the page's title with what it is for behind an information mark,
// and the one button that adds something, with a menu when there is more than one kind.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/components/popover';
import { Link } from '@tanstack/react-router';
import { ChevronDown, Info, Plus } from 'lucide-react';
import { useRef, type ReactElement, type ReactNode } from 'react';
import { iconButtonClassName } from '../list-table';

const subTabClassName =
  'inline-flex min-h-11 items-center rounded-control px-3 text-[13px] font-medium text-body -outline-offset-2 hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-link aria-[current=page]:shadow-[0_1px_2px_rgb(16_24_40/0.05)] lg:min-h-7';

/** Emails' own pages, above the page: Campaigns first, as GoHighLevel has them. */
export function EmailsNav({
  slug,
  current,
}: {
  readonly slug: string;
  readonly current: 'campaigns' | 'templates';
}): ReactElement {
  const { t } = useLingui();
  return (
    <nav aria-label={t`Emails`}>
      <div className="inline-flex rounded-lg bg-muted p-1">
        <Link
          to="/b/$slug/marketing/emails/campaigns"
          params={{ slug }}
          aria-current={current === 'campaigns' ? 'page' : undefined}
          className={subTabClassName}
        >
          <Trans>Campaigns</Trans>
        </Link>
        <Link
          to="/b/$slug/marketing/emails/templates"
          params={{ slug }}
          aria-current={current === 'templates' ? 'page' : undefined}
          className={subTabClassName}
        >
          <Trans>Templates</Trans>
        </Link>
      </div>
    </nav>
  );
}

/** What a page is for, behind an information mark beside its title. */
export function InfoTip({
  label,
  children,
}: {
  /** What the mark is called, such as "About templates". */
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Popover>
      <PopoverTrigger aria-label={label} className={iconButtonClassName}>
        <Info aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.8} />
      </PopoverTrigger>
      <PopoverContent className="w-80 text-sm leading-relaxed text-body">{children}</PopoverContent>
    </Popover>
  );
}

export interface NewChoice {
  readonly label: string;
  /** One line under the label, saying what it makes. */
  readonly hint?: string;
  readonly onSelect: (trigger: HTMLElement | null) => void;
}

/** The one primary button that adds something; a menu of kinds when there is more than one. */
export function NewMenu({
  label,
  choices,
}: {
  readonly label: string;
  readonly choices: readonly NewChoice[];
}): ReactElement | null {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const actingRef = useRef(false);
  const [only] = choices;
  if (only === undefined) return null;
  if (choices.length === 1)
    return (
      <Button
        onClick={(event) => {
          only.onSelect(event.currentTarget);
        }}
      >
        <Plus aria-hidden className="size-4" strokeWidth={2} />
        {label}
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        ref={triggerRef}
        render={
          <Button>
            <Plus aria-hidden className="size-4" strokeWidth={2} />
            {label}
            <ChevronDown aria-hidden className="size-4" strokeWidth={2} />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        className="w-64"
        // What a choice opens takes the keyboard, and gives it back to this button.
        finalFocus={() => {
          const acting = actingRef.current;
          actingRef.current = false;
          return !acting;
        }}
      >
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.label}
            className="min-h-12 flex-col items-start justify-center gap-0.5 py-1.5"
            onClick={() => {
              actingRef.current = true;
              choice.onSelect(triggerRef.current);
            }}
          >
            <span className="font-medium">{choice.label}</span>
            {choice.hint === undefined ? null : (
              <span className="text-xs text-muted-foreground">{choice.hint}</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The words a library page says while it has nothing to show at all. */
export function LibraryEmpty({
  title,
  action,
}: {
  readonly title: ReactNode;
  readonly action: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <p className="text-md font-medium text-foreground">{title}</p>
      {action}
    </div>
  );
}

/** What the last action came to, said to everyone, a screen reader too. */
export function Notice({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <p role="status" className="min-h-0 text-sm text-body empty:hidden">
      {children}
    </p>
  );
}

export function NothingMatches(): ReactElement {
  return (
    <p className="px-3 py-10 text-center text-sm text-muted-foreground">
      <Trans>Nothing matches. Try another search or filter.</Trans>
    </p>
  );
}
