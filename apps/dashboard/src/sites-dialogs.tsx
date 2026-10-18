// The small dialogs the Sites pages share: one that asks for a name (a new folder, a
// rename) and the words a refusal is shown in. What is typed is sent as it is; the server's
// own words come back under the box when it refuses.
import { Trans } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { noRejection, type Rejection } from './problems';
import { savingProblem, SmallDialog } from './settings-list';

/** What a refused save says about the form as a whole, above its buttons. */
export function FormRefusal({ problem }: { readonly problem: Rejection }): ReactElement | null {
  return problem.form === undefined ? null : (
    <p role="alert" className="text-sm font-medium text-destructive">
      {problem.form}
    </p>
  );
}

export function NameDialog({
  title,
  label,
  hint,
  initial = '',
  saveLabel,
  savingLabel,
  fallback,
  returnFocus,
  save,
  onClose,
}: {
  readonly title: ReactNode;
  /** What the box is called, such as "Folder name". */
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly initial?: string;
  readonly saveLabel: ReactNode;
  readonly savingLabel: ReactNode;
  /** What is said when the save failed without the server saying why. */
  readonly fallback: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  /** Saves the name; the dialog stays open, with the reason, when it is refused. */
  readonly save: (name: string) => Promise<unknown>;
  readonly onClose: () => void;
}): ReactElement {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<Rejection>(noRejection);
  const saving = useMutation({
    mutationFn: save,
    onError: (error) => {
      setProblem(savingProblem(error, fallback));
    },
  });
  const ready = name.trim() !== '' && !saving.isPending;
  return (
    <SmallDialog
      open
      title={title}
      returnFocus={returnFocus}
      onClose={() => {
        if (!saving.isPending) onClose();
      }}
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setProblem(noRejection);
          saving.mutate(name.trim());
        }}
      >
        <Field name="name" invalid={problem.fields['name'] !== undefined}>
          <FieldLabel>{label}</FieldLabel>
          <Input
            required
            maxLength={120}
            autoComplete="off"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(noRejection);
            }}
          />
          {hint === undefined ? null : <FieldDescription>{hint}</FieldDescription>}
          {problem.fields['name'] === undefined ? null : (
            <FieldError match>{problem.fields['name']}</FieldError>
          )}
        </Field>
        <FormRefusal problem={problem} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={saving.isPending}
            onClick={() => {
              onClose();
            }}
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={!ready}>
            {saving.isPending ? savingLabel : saveLabel}
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
