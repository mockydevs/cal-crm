import { Trans } from '@lingui/react/macro';
import type { ReactElement } from 'react';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Display only identifiers explicitly produced by a native dry-run action. */
export default function SimulatedOutput({
  step,
}: {
  readonly step: {
    readonly step: string;
    readonly type: string;
    readonly simulated?: unknown;
    readonly output?: unknown;
  };
}): ReactElement | null {
  if (step.simulated !== true || !isRecord(step.output)) return null;
  const note = step.type === 'note.create';
  if (!note && step.type !== 'task.create') return null;
  const id = step.output[note ? 'noteId' : 'taskId'];
  const prefix = `simulated:${note ? 'note' : 'task'}:${step.step}:`;
  if (
    typeof id !== 'string' ||
    !id.startsWith(prefix) ||
    !/^[1-9]\d{0,2}$/.test(id.slice(prefix.length))
  )
    return null;
  return (
    <div className="mt-1 rounded-xl border border-input px-3 py-2 text-sm">
      <p className="font-medium">
        <Trans>Simulated output</Trans>
      </p>
      <dl className="mt-1">
        <dt className="text-muted-foreground">
          {note ? <Trans>Note reference</Trans> : <Trans>Task reference</Trans>}
        </dt>
        <dd className="min-w-0 wrap-anywhere">
          <code>{id}</code>
        </dd>
      </dl>
      <p className="mt-1 text-muted-foreground">
        <Trans>This reference only exists in this test.</Trans>
      </p>
    </div>
  );
}
