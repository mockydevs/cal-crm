// The dialog two of the Tasks page's bulk actions are set up in: who the ticked tasks go
// to, or when they are due. Marking complete, reopening and deleting need nothing chosen,
// so the page runs those itself. Fetched when one of the two is first used.
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import type { TaskAssigneeList } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useId, useState, type ReactElement, type RefObject } from 'react';

import { SmallDialog } from './settings-list';
import type { TaskBulkChoice } from './task-bulk-rules';
import { dueInstant } from './task-rules';

const UNASSIGNED = 'none';
const ME = 'me';

export default function TaskBulkDialog({
  action,
  count,
  people,
  pending,
  problem,
  returnFocus,
  onClose,
  onRun,
}: {
  readonly action: 'assign' | 'set_due';
  /** How many tasks are ticked. */
  readonly count: number;
  /** Everyone on the team but the reader, as the Assignee chip lists them. */
  readonly people: TaskAssigneeList['items'];
  readonly pending: boolean;
  /** Why the last try failed, in the server's words or the page's. */
  readonly problem: string | undefined;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onRun: (choice: TaskBulkChoice) => void;
}): ReactElement {
  const { t } = useLingui();
  const formId = useId();
  const dueId = useId();
  const [assignee, setAssignee] = useState(UNASSIGNED);
  const [due, setDue] = useState('');
  const [clear, setClear] = useState(false);
  const [noSuchTime, setNoSuchTime] = useState(false);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const ready = action === 'assign' || clear || due !== '';
  return (
    <SmallDialog
      open
      onClose={() => {
        if (!pending) onClose();
      }}
      title={action === 'assign' ? <Trans>Assign tasks</Trans> : <Trans>Change due date</Trans>}
      description={<Plural value={count} one="# task is selected." other="# tasks are selected." />}
      returnFocus={returnFocus}
    >
      <form
        id={formId}
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || pending) return;
          if (action === 'assign') {
            onRun({ action, assignee: assignee === UNASSIGNED ? null : assignee });
            return;
          }
          const dueAt = clear ? null : dueInstant(due);
          if (dueAt === undefined) {
            setNoSuchTime(true);
            return;
          }
          onRun({ action, dueAt });
        }}
      >
        {action === 'assign' ? (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            <Trans>Assign to</Trans>
            <Select
              aria-label={t`Assign to`}
              value={assignee}
              disabled={pending}
              onValueChange={setAssignee}
            >
              <option value={UNASSIGNED}>{t`Unassigned`}</option>
              <option value={ME}>{t`Me`}</option>
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name ?? t`Unavailable person`}
                </option>
              ))}
            </Select>
          </label>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={dueId} className="text-sm font-medium">
                <Trans>Due date and time ({timeZone})</Trans>
              </label>
              <Input
                id={dueId}
                type="datetime-local"
                min="0001-01-01T00:00"
                max="9999-12-31T23:59"
                value={due}
                disabled={pending || clear}
                onChange={(event) => {
                  setDue(event.target.value);
                  setNoSuchTime(false);
                }}
              />
            </div>
            <label className="flex min-h-11 items-center gap-2 text-sm lg:min-h-9">
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={clear}
                disabled={pending}
                onChange={(event) => {
                  setClear(event.target.checked);
                  setNoSuchTime(false);
                }}
              />
              <Trans>Clear the due date instead</Trans>
            </label>
            {noSuchTime ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                <Trans>This time doesn't exist in {timeZone}. Choose another time.</Trans>
              </p>
            ) : null}
          </>
        )}
      </form>
      {problem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={pending} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" form={formId} disabled={!ready || pending}>
          {pending ? <Trans>Working…</Trans> : <Trans>Apply</Trans>}
        </Button>
      </div>
    </SmallDialog>
  );
}
