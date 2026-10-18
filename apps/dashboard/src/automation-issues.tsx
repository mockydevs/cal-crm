// What the checks found in an automation: errors, which block publishing, and warnings,
// which don't. Each says what is wrong, where (its JSON Pointer) and what to try, and can
// lead to its place: the step in the Steps view, or the text in the JSON view.
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import type { ReactElement } from 'react';

export interface ShownIssue {
  readonly level: 'error' | 'warning';
  readonly path: string;
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string | undefined;
}

/** A validation's errors, then its warnings. */
export function issuesOf(
  validation:
    | {
        readonly errors: readonly Omit<ShownIssue, 'level'>[];
        readonly warnings: readonly Omit<ShownIssue, 'level'>[];
      }
    | undefined,
): ShownIssue[] {
  if (validation === undefined) return [];
  const shown = (
    level: ShownIssue['level'],
    issues: readonly Omit<ShownIssue, 'level'>[],
  ): ShownIssue[] =>
    issues.map(({ path, code, message, suggestion }) => ({
      level,
      path,
      code,
      message,
      suggestion,
    }));
  return [...shown('error', validation.errors), ...shown('warning', validation.warnings)];
}

/**
 * Where the business's profile is, for the warning that it has no postal address: read
 * from the address of the page, so the list needs nothing handed to it. Opened in a new
 * tab: the builder may hold changes that are not saved.
 */
const profileAddress = (): string | undefined => {
  const business = /^\/b\/[^/]+/.exec(location.pathname)?.[0];
  return business === undefined ? undefined : `${business}/settings/business`;
};

/** One issue: its kind in words and with an icon, never by colour alone. */
export function IssueLine({ issue }: { readonly issue: ShownIssue }): ReactElement {
  const Icon = issue.level === 'error' ? CircleAlert : TriangleAlert;
  const profile = issue.code === 'no_postal_address' ? profileAddress() : undefined;
  return (
    <span className="flex min-w-0 items-start gap-2 text-sm">
      <Icon
        aria-hidden
        className={`mt-0.5 size-4 shrink-0 ${issue.level === 'error' ? 'text-destructive' : 'text-attention-foreground'}`}
        strokeWidth={1.8}
      />
      <span className="min-w-0 wrap-anywhere">
        <span className="font-semibold">
          {issue.level === 'error' ? <Trans>Error:</Trans> : <Trans>Warning:</Trans>}
        </span>{' '}
        {issue.message}
        {issue.suggestion === undefined ? null : <> {issue.suggestion}</>}
        {profile === undefined ? null : (
          <>
            {' '}
            <a href={profile} target="_blank" rel="noreferrer" className="text-link underline">
              <Trans>Open Business Profile in a new tab</Trans>
            </a>
          </>
        )}
      </span>
    </span>
  );
}

export function IssueList({
  issues,
  label,
  onLocate,
}: {
  readonly issues: readonly ShownIssue[];
  readonly label: string;
  /** Leads to the issue's place; without it the list only tells. */
  readonly onLocate?: ((issue: ShownIssue) => void) | undefined;
}): ReactElement {
  const { t } = useLingui();
  const showLabel = (message: string): string => t`Show where: ${message}`;
  return (
    <ul aria-label={label} className="flex min-w-0 flex-col gap-3">
      {issues.map((issue, position) => (
        <li
          key={`${issue.level}:${issue.path}:${issue.code}:${String(position)}`}
          className="flex min-w-0 flex-col items-start gap-1"
        >
          <IssueLine issue={issue} />
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 pl-6">
            <code className="max-w-full rounded-md bg-muted px-1.5 py-0.5 text-xs wrap-anywhere">
              {issue.path === '' ? '/' : issue.path}
            </code>
            {onLocate === undefined ? null : (
              <Button
                variant="quiet"
                size="small"
                className="text-link"
                aria-label={showLabel(issue.message)}
                onClick={() => {
                  onLocate(issue);
                }}
              >
                <Trans>Show where</Trans>
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
