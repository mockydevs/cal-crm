import { Form as FormPrimitive } from '@base-ui/react/form';
import type { ReactElement } from 'react';
import { cn } from '../lib/utils';

// Base UI's Form: it hands onFormSubmit the values by field name, and shows the errors it's
// given (usually the server's, by field name) under each Field until that field changes.
export type FormProps<Values extends Record<string, unknown>> = Omit<
  FormPrimitive.Props<Values>,
  'className'
> & { className?: string };

export function Form<Values extends Record<string, unknown>>({
  className,
  ...props
}: FormProps<Values>): ReactElement {
  return (
    <FormPrimitive<Values>
      data-slot="form"
      className={cn('flex flex-col gap-4', className)}
      {...props}
    />
  );
}
