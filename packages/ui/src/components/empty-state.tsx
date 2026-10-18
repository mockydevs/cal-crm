import type { ReactElement, ReactNode } from 'react';
import { cn } from '../lib/utils';

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description: ReactNode;
  /** A decorative icon, such as a Lucide icon. */
  readonly icon?: ReactNode;
  /** Usually a button that starts the first item. */
  readonly action?: ReactNode;
  readonly className?: string;
}

/** What a list or page shows before it has anything in it. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps): ReactElement {
  return (
    <section
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-start gap-4 rounded-card border bg-card p-8 text-card-foreground',
        className,
      )}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden
          className="flex size-13 items-center justify-center rounded-full bg-muted [&_svg]:size-6"
        >
          {icon}
        </span>
      )}
      <div className="flex max-w-prose flex-col gap-1.5">
        <h2 className="text-xl font-semibold">{title}</h2>
        <p className="text-md text-muted-foreground">{description}</p>
      </div>
      {action}
    </section>
  );
}
