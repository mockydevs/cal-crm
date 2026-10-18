import { Field as FieldPrimitive } from '@base-ui/react/field';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// Base UI's Field, laid out as a form field: the label above the
// control, then a hint or the error. Base UI ties them to the control (for, aria-describedby,
// aria-invalid), and shows the error a Form was given for the field's name.

type WithClassName<Props> = Omit<Props, 'className'> & { className?: string };

export function Field({
  className,
  ...props
}: WithClassName<FieldPrimitive.Root.Props>): ReactElement {
  return (
    <FieldPrimitive.Root
      data-slot="field"
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  );
}

export function FieldLabel({
  className,
  ...props
}: WithClassName<FieldPrimitive.Label.Props>): ReactElement {
  return (
    <FieldPrimitive.Label
      data-slot="field-label"
      className={cn('text-sm font-medium', className)}
      {...props}
    />
  );
}

export function FieldDescription({
  className,
  ...props
}: WithClassName<FieldPrimitive.Description.Props>): ReactElement {
  return (
    <FieldPrimitive.Description
      data-slot="field-description"
      className={cn('text-sm leading-normal text-muted-foreground', className)}
      {...props}
    />
  );
}

export function FieldError({
  className,
  ...props
}: WithClassName<FieldPrimitive.Error.Props>): ReactElement {
  return (
    <FieldPrimitive.Error
      data-slot="field-error"
      className={cn('text-sm leading-normal font-medium text-destructive', className)}
      {...props}
    />
  );
}
