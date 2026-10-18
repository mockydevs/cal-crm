import { Field } from '@base-ui/react/field';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova textarea, for longer answers. It's a
// Field control, so inside a Field its label, description and error are wired to it.
export type TextareaProps = Omit<Field.Control.Props, 'className' | 'render'> & {
  className?: string;
  /** Visible lines before it scrolls; people can drag it taller. */
  rows?: number;
};

export function Textarea({ className, rows = 2, ...props }: TextareaProps): ReactElement {
  return (
    <Field.Control
      data-slot="textarea"
      render={<textarea rows={rows} />}
      className={cn(
        'w-full min-w-0 resize-y rounded-control border border-input bg-card px-3 py-2 text-md text-foreground transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
