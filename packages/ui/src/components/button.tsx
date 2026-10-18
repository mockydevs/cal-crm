import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova button, sized for the design system: 36px tall
// with 8px corners (small: 32px) in the desktop layout, and 44px (small: 40px) below it,
// where fingers do the pressing.
const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-primary text-primary-foreground shadow-[0_1px_2px_rgb(16_24_40/0.05)] hover:bg-primary-hover',
        secondary: 'border border-input bg-card text-foreground hover:bg-muted',
        quiet:
          'bg-transparent font-normal text-muted-foreground hover:bg-muted hover:text-foreground',
      },
      size: {
        default: 'min-h-11 px-3.5 py-2 text-sm lg:min-h-9',
        small: 'min-h-10 px-3 text-sm lg:min-h-8',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'default',
    },
  },
);

export type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps): ReactElement {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
