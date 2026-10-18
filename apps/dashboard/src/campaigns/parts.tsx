// What the campaign screens share on screen: a status as a pill, the looks of
// a card and of a small grey label above its value, and a folder as a choice in a list.
import { useLingui } from '@lingui/react/macro';
import type { EmailCampaignFolder, EmailCampaignStatus } from '@repo/contracts';
import type { ReactElement, ReactNode } from 'react';
import { folderLabels, statusTones, statusWords, type Tone } from './rules';

export const cardClassName =
  'flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4';
/** A small grey label above a value. */
export const labelClassName = 'text-xs font-medium text-muted-foreground';
export const hintClassName = 'text-sm text-muted-foreground';
export const problemClassName = 'text-sm font-medium text-destructive';
export const linkClassName =
  'font-medium text-link underline-offset-2 hover:underline focus-visible:underline';

const neutralClassName = 'bg-secondary text-secondary-foreground';
const goodClassName = 'bg-success-subtle text-success';
const activeClassName = 'bg-assistant text-assistant-foreground';
const warningClassName = 'bg-attention text-attention-foreground';
const badClassName = 'border border-destructive bg-card text-destructive';
const toneClassNames: Readonly<Record<Tone, string>> = {
  neutral: neutralClassName,
  good: goodClassName,
  active: activeClassName,
  warning: warningClassName,
  bad: badClassName,
};

export function Pill({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span
      className={`inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${toneClassNames[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { readonly status: EmailCampaignStatus }): ReactElement {
  const { i18n } = useLingui();
  return <Pill tone={statusTones[status]}>{i18n._(statusWords[status])}</Pill>;
}

/** A small grey label above its value. */
export function Fact({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={labelClassName}>{label}</dt>
      <dd className="min-w-0 text-md text-body wrap-anywhere">{children}</dd>
    </div>
  );
}

/** The folders as the options of a list, each with the path that leads to it. */
export function folderOptions(
  folders: readonly EmailCampaignFolder[],
): readonly { readonly id: string; readonly label: string }[] {
  const labels = folderLabels(folders);
  return folders.map((folder) => ({ id: folder.id, label: labels.get(folder.id) ?? folder.name }));
}
