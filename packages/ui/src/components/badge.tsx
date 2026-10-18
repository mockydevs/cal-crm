import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// From shadcn/ui's base-nova badge, as the design's pill labels: "Waiting on you"
// (attention), status labels (neutral), and what the assistant did (assistant).
const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-full font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3.5',
  {
    variants: {
      variant: {
        attention: 'bg-attention text-attention-foreground',
        neutral: 'bg-secondary text-secondary-foreground',
        assistant: 'bg-assistant text-assistant-foreground',
      },
      size: {
        default: 'px-3 py-1.5 text-sm',
        count: 'h-6 min-w-6 px-[7px] text-[13px]',
      },
    },
    defaultVariants: {
      variant: 'neutral',
      size: 'default',
    },
  },
);

export type BadgeProps = useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, size, render, ...props }: BadgeProps): ReactElement {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      { className: cn(badgeVariants({ variant, size }), className) },
      props,
    ),
    render,
    state: { slot: 'badge', variant },
  });
}

export { badgeVariants };
