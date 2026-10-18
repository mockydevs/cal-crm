// Confirmation consent: the box the public booking page shows for confirmation emails, and
// its words. Switched on, the page asks the visitor to agree with this wording (or the
// standard wording when it is empty) and keeps what they agreed to as proof; switched off,
// there is no box and no confirmation email is sent. Bot protection: off, or ALTCHA's proof
// of work, solved by the visitor's browser before a booking is taken.
import { Trans, useLingui } from '@lingui/react/macro';
import { CALENDAR_LIMITS } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import type { ReactElement } from 'react';
import { Labeled, SectionCard, SwitchRow, type SectionProps } from './calendar-settings-parts';

export default function FormsSection({ draft, change, problems, off }: SectionProps): ReactElement {
  const { t } = useLingui();
  const limit = CALENDAR_LIMITS.consentText;
  return (
    <>
      <SectionCard
        title={<Trans>Confirmation consent</Trans>}
        description={
          <Trans>Whether the booking page asks the visitor to agree to confirmation emails.</Trans>
        }
      >
        <SwitchRow
          label={<Trans>Consent checkbox</Trans>}
          description={
            <Trans>
              On, the booking page shows a box with the wording below and keeps what the visitor
              agreed to as proof. Off, there is no box and no confirmation email is sent.
            </Trans>
          }
          checked={draft.consentEnabled}
          disabled={off}
          onChange={(consentEnabled) => {
            change({ consentEnabled });
          }}
        />
        <Labeled
          label={t`Consent wording`}
          problem={problems['consentText']}
          description={
            <Trans>
              Empty: "Email me confirmations and updates for this appointment." At most {limit}{' '}
              characters.
            </Trans>
          }
        >
          {(control) => (
            <Textarea
              {...control}
              rows={4}
              maxLength={limit}
              disabled={off || !draft.consentEnabled}
              placeholder={t`Email me confirmations and updates for this appointment.`}
              value={draft.consentText}
              onChange={(event) => {
                change({ consentText: event.target.value });
              }}
            />
          )}
        </Labeled>
      </SectionCard>
      <SectionCard
        title={<Trans>Bot protection</Trans>}
        description={
          <Trans>Whether the booking page asks for a proof of work before a booking.</Trans>
        }
      >
        <Labeled
          label={t`Bot protection`}
          problem={problems['botProtection']}
          description={
            <Trans>
              Proof of work asks the visitor's browser to solve a small puzzle by itself before a
              booking is taken (ALTCHA, run on this server). Visitors see and do nothing extra.
            </Trans>
          }
        >
          {(control) => (
            <Select
              {...control}
              disabled={off}
              value={draft.botProtection}
              onValueChange={(value) => {
                change({ botProtection: value === 'altcha' ? 'altcha' : 'off' });
              }}
            >
              <option value="off">{t`Off`}</option>
              <option value="altcha">{t`Proof of work (ALTCHA)`}</option>
            </Select>
          )}
        </Labeled>
      </SectionCard>
    </>
  );
}
