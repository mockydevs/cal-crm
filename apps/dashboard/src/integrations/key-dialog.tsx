// Connecting an integration that takes a pasted key: one box, sent once and never shown
// again. A key the provider or the server refuses stays in the box, with the reason in the
// server's words under it.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  connectIntegration,
  INTEGRATION_LIMITS,
  type IntegrationConnectStarted,
} from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { useMutation } from '@tanstack/react-query';
import { useId, useState, type ReactElement, type RefObject } from 'react';
import { apiIn } from '../api';
import { SmallDialog } from '../settings-list';
import { useBusiness } from '../workspace';
import { saidBy } from './rules';

export function KeyDialog({
  integrationKey,
  name,
  returnFocus,
  onClose,
  onConnected,
}: {
  readonly integrationKey: string;
  readonly name: string;
  readonly returnFocus: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
  readonly onConnected: (started: IntegrationConnectStarted) => void;
}): ReactElement {
  const { t } = useLingui();
  const business = useBusiness();
  const boxId = useId();
  const problemId = useId();
  const [value, setValue] = useState('');
  const connect = useMutation({
    mutationFn: (apiKey: string) =>
      apiIn(business.id).request(connectIntegration, {
        params: { provider: integrationKey },
        body: { apiKey },
      }),
    onSuccess: onConnected,
  });
  const problem = connect.isError
    ? saidBy(connect.error, t`It wasn't connected. Check your connection and try again.`)
    : undefined;
  return (
    <SmallDialog
      open
      onClose={onClose}
      title={t`Connect ${name}`}
      description={t`Paste the key from your ${name} account. It is kept sealed and never shown again.`}
      returnFocus={returnFocus}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          connect.mutate(value);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={boxId} className="text-sm font-medium">
            <Trans>Key</Trans>
          </label>
          <Input
            id={boxId}
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            maxLength={INTEGRATION_LIMITS.apiKey}
            value={value}
            aria-invalid={problem === undefined ? undefined : true}
            aria-describedby={problem === undefined ? undefined : problemId}
            onChange={(event) => {
              setValue(event.target.value);
            }}
          />
          {problem === undefined ? null : (
            <p id={problemId} role="alert" className="text-sm font-medium text-destructive">
              {problem}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={connect.isPending} onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button type="submit" disabled={connect.isPending || value.trim() === ''}>
            <Trans>Connect</Trans>
          </Button>
        </div>
      </form>
    </SmallDialog>
  );
}
