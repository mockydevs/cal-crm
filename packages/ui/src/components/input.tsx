import { Input as InputPrimitive } from '@base-ui/react/input';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova input, sized for the design system: 36px tall
// (44px below the desktop layout), 6px corners, body text. Inside a Field, its label,
// description and error are wired to it.
export type InputProps = Omit<InputPrimitive.Props, 'className'> & { className?: string };

export function Input({ className, ...props }: InputProps): ReactElement {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        'min-h-11 w-full min-w-0 rounded-control border border-input bg-card px-3 text-md text-foreground transition-colors placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 data-invalid:border-destructive lg:min-h-9',
        className,
      )}
      {...props}
    />
  );
}
