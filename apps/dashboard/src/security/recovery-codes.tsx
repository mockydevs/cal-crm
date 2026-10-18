import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@repo/ui/components/button';
import { useState, type ReactElement } from 'react';

export interface RecoveryCodesProps {
  readonly codes: readonly string[];
}

/** Recovery codes, shown once, with a way to copy them. */
export function RecoveryCodes({ codes }: RecoveryCodesProps): ReactElement {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-md leading-normal">
        <Trans>
          Keep these recovery codes somewhere safe, such as a password manager. If you lose your
          phone, each one signs you in once. You won't see them again.
        </Trans>
      </p>
      <ul
        aria-label={t`Recovery codes`}
        className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-x-6 gap-y-1.5 rounded-md bg-muted p-4 font-mono text-md"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <Button
        variant="secondary"
        size="small"
        className="self-start"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join('\n')).then(() => {
            setCopied(true);
          });
        }}
      >
        {copied ? <Trans>Copied</Trans> : <Trans>Copy the codes</Trans>}
      </Button>
    </div>
  );
}
