// Staff & location, as GoHighLevel's section in the owner's screenshot: the staff of the
// calendar, and for each of them where they meet. A meeting location is words the business
// writes (decision 4): Custom, Phone or Address; or Google Meet, offered only to someone
// whose Google Calendar is connected, as its link is made there. Only people of this
// business's own team can be chosen (decision 2); a round robin calendar also gives each a
// weight.
import { Trans, useLingui } from '@lingui/react/macro';
import { CALENDAR_LIMITS } from '@repo/contracts';
import { Avatar } from '@repo/ui/components/avatar';
import { Button } from '@repo/ui/components/button';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Plus, Tag, Trash2 } from 'lucide-react';
import type { ReactElement } from 'react';
import { tintOf } from './avatar-tint';
import {
  Labeled,
  noteClassName,
  PeoplePicker,
  SectionCard,
  type SectionProps,
} from './calendar-settings-parts';
import { meetAvailableFor } from './calendar-connections-rules';
import { locationKinds, type LocationDraft, type MemberDraft } from './calendar-settings-rules';
import { useGoogleConnections } from './google-status';
import { locationKindNames } from './calendar-settings-words';
import { iconButtonClassName } from './settings-list';
import { initialsOf } from './workspace';

export default function StaffSection({
  client,
  businessId,
  draft,
  change,
  problems,
  off,
  people,
  saved,
}: SectionProps): ReactElement {
  const { t, i18n } = useLingui();
  // Google Meet is a place only for someone whose Google Calendar is connected.
  const google = useGoogleConnections(businessId, client).data;
  const single = draft.kind === 'personal' && draft.members.length <= 1;
  const limit = CALENDAR_LIMITS.memberLocations;
  const setMember = (membershipId: string, changed: Partial<MemberDraft>): void => {
    change({
      members: draft.members.map((member) =>
        member.membershipId === membershipId ? { ...member, ...changed } : member,
      ),
    });
  };
  const setLocation = (member: MemberDraft, key: string, changed: Partial<LocationDraft>): void => {
    setMember(member.membershipId, {
      locations: member.locations.map((location) =>
        location.key === key ? { ...location, ...changed } : location,
      ),
    });
  };
  return (
    <SectionCard
      title={<Trans>Staff & meeting location</Trans>}
      description={<Trans>Assign staff to this calendar and set where meetings take place.</Trans>}
    >
      <PeoplePicker
        label={t`Select staff & assign meeting location`}
        people={people ?? []}
        chosen={draft.members.map((member) => member.membershipId)}
        single={single}
        problem={problems['members']}
        disabled={off || people === undefined}
        description={
          draft.kind === 'personal' ? (
            <Trans>
              A personal calendar has exactly one person. Only people on this account's own team can
              be chosen.
            </Trans>
          ) : (
            <Trans>
              Choose one or more people. Only people on this account's own team can be chosen.
            </Trans>
          )
        }
        onChange={(ids) => {
          change({
            members: ids.map(
              (membershipId) =>
                draft.members.find((member) => member.membershipId === membershipId) ?? {
                  membershipId,
                  weight: '1',
                  locations: [],
                },
            ),
          });
        }}
      />
      {saved?.members.some((member) => member.membershipId === null) === true ? (
        <p className={noteClassName}>
          <Trans>
            Someone on this calendar is no longer on the business team. They get no bookings. Saving
            removes them from the calendar.
          </Trans>
        </p>
      ) : null}
      {draft.members.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col divide-y divide-border">
          {draft.members.map((member) => {
            const person = people?.find((each) => each.membershipId === member.membershipId);
            const name =
              person === undefined
                ? t`Unavailable member`
                : person.name === ''
                  ? person.email
                  : person.name;
            const full = member.locations.length >= limit;
            const meet = meetAvailableFor(google, member.membershipId);
            return (
              <li
                key={member.membershipId}
                className="grid min-w-0 gap-4 py-4 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
              >
                <div className="flex min-w-0 flex-col gap-3">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Avatar
                      size="medium"
                      tint={tintOf(member.membershipId)}
                      fallback={initialsOf(person?.name ?? '', person?.email ?? '?')}
                    />
                    <span className="min-w-0 text-md font-medium wrap-anywhere">{name}</span>
                  </span>
                  {draft.kind === 'round_robin' ? (
                    <Labeled
                      label={t`Booking weight for ${name}`}
                      description={
                        <Trans>From 1 to 100: a higher weight gets more bookings.</Trans>
                      }
                      className="sm:max-w-48"
                    >
                      {(control) => (
                        <Input
                          {...control}
                          inputMode="numeric"
                          autoComplete="off"
                          maxLength={3}
                          disabled={off}
                          value={member.weight}
                          onChange={(event) => {
                            setMember(member.membershipId, { weight: event.target.value });
                          }}
                        />
                      )}
                    </Labeled>
                  ) : null}
                </div>
                <div
                  role="group"
                  aria-label={t`Meeting locations of ${name}`}
                  className="flex min-w-0 flex-col gap-3"
                >
                  <span className="text-sm font-medium">
                    <Trans>Meeting location</Trans>
                  </span>
                  {member.locations.length === 0 ? (
                    <p className={noteClassName}>
                      <Trans>No location: appointments with this person say none.</Trans>
                    </p>
                  ) : null}
                  {member.locations.map((location, index) => {
                    const number = index + 1;
                    return (
                      <div
                        key={location.key}
                        className="flex min-w-0 flex-col gap-2 border-b border-border pb-3"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <Select
                            aria-label={t`Kind of meeting location ${number} of ${name}`}
                            disabled={off}
                            value={location.kind}
                            onValueChange={(value) => {
                              const kind = locationKinds.find((each) => each === value);
                              // A Meet needs no words of the business's: its link comes
                              // from Google once the appointment is written there.
                              if (kind === 'google_meet' && location.value.trim() === '')
                                setLocation(member, location.key, { kind, value: 'Google Meet' });
                              else if (kind !== undefined)
                                setLocation(member, location.key, { kind });
                            }}
                          >
                            {locationKinds
                              // A Meet already chosen stays shown, with why it isn't made.
                              .filter(
                                (kind) => kind !== 'google_meet' || meet || location.kind === kind,
                              )
                              .map((kind) => (
                                <option key={kind} value={kind}>
                                  {i18n._(locationKindNames[kind])}
                                </option>
                              ))}
                          </Select>
                          <button
                            type="button"
                            className={`${iconButtonClassName} border border-input bg-card`}
                            aria-label={t`Remove meeting location ${number} of ${name}`}
                            title={t`Remove location`}
                            disabled={off}
                            onClick={() => {
                              setMember(member.membershipId, {
                                locations: member.locations.filter(
                                  (each) => each.key !== location.key,
                                ),
                              });
                            }}
                          >
                            <Trash2 aria-hidden className="size-4" strokeWidth={1.8} />
                          </button>
                        </div>
                        <Input
                          aria-label={t`Meeting location ${number} of ${name}`}
                          placeholder={t`Meeting location`}
                          maxLength={500}
                          autoComplete="off"
                          disabled={off}
                          aria-invalid={
                            problems['members'] !== undefined && location.value.trim() === ''
                          }
                          value={location.value}
                          onChange={(event) => {
                            setLocation(member, location.key, { value: event.target.value });
                          }}
                        />
                        {location.kind === 'google_meet' && !meet ? (
                          <p className={noteClassName}>
                            <Trans>
                              {name}'s Google Calendar isn't connected, so no Meet can be made:
                              bookings get their next location instead, or none.
                            </Trans>
                          </p>
                        ) : null}
                        {location.label === null ? (
                          <Button
                            variant="quiet"
                            size="small"
                            className="self-start px-1 font-medium text-link"
                            disabled={off}
                            aria-label={t`Add display label to meeting location ${number} of ${name}`}
                            onClick={() => {
                              setLocation(member, location.key, { label: '' });
                            }}
                          >
                            <Tag aria-hidden className="size-4" strokeWidth={1.8} />
                            <Trans>Add display label</Trans>
                          </Button>
                        ) : (
                          <Input
                            aria-label={t`Display label of meeting location ${number} of ${name}`}
                            placeholder={t`Display label, such as Office`}
                            maxLength={80}
                            autoComplete="off"
                            disabled={off}
                            value={location.label}
                            onChange={(event) => {
                              setLocation(member, location.key, { label: event.target.value });
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
                  {google?.available === true && !meet ? (
                    <p className={noteClassName}>
                      <Trans>
                        Google Meet becomes a choice once {name} connects their Google Calendar in
                        Settings → Calendars → Connections.
                      </Trans>
                    </p>
                  ) : null}
                  <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
                    {full ? (
                      <span className={noteClassName}>
                        <Trans>A person can have up to {limit} locations.</Trans>
                      </span>
                    ) : null}
                    <Button
                      variant="secondary"
                      className="text-link"
                      disabled={off || full}
                      aria-label={t`Add location for ${name}`}
                      onClick={() => {
                        setMember(member.membershipId, {
                          locations: [
                            ...member.locations,
                            { key: crypto.randomUUID(), kind: 'custom', value: '', label: null },
                          ],
                        });
                      }}
                    >
                      <Plus aria-hidden className="size-4" strokeWidth={2} />
                      <Trans>Add location</Trans>
                    </Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className={noteClassName}>
        <Trans>
          The first location of the person who takes an appointment is the one that appointment is
          given.
        </Trans>
      </p>
    </SectionCard>
  );
}
