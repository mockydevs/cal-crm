// Basic details of a calendar, as GoHighLevel's section in the owner's screenshot: logo,
// name, description, link, group and the title appointments are given. The description is
// plain text (decision 8). Ours beside them: the type, the time zone and whether the
// calendar is active, which the vendor keeps elsewhere.
import { Trans, useLingui } from '@lingui/react/macro';
import type { CalendarGroup, CalendarKind } from '@repo/contracts';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { Textarea } from '@repo/ui/components/textarea';
import { Tag } from 'lucide-react';
import { useId, useRef, type ReactElement } from 'react';
import {
  Labeled,
  NotYet,
  SectionCard,
  SwitchRow,
  type SectionProps,
} from './calendar-settings-parts';
import { ImageDrop } from './calendar-settings-image';
import {
  bookingPrefix,
  imageMegabytes,
  isBookableKind,
  kindChoices,
  mergeFields,
} from './calendar-settings-rules';
import { draftOnlyNote, kindNames } from './calendar-settings-words';
import { iconButtonClassName } from './settings-list';

export default function BasicSection({
  client,
  businessId,
  businessSlug,
  agencySlug,
  draft,
  change,
  problems,
  off,
  canManage,
  saved,
  groups,
}: SectionProps & {
  /** The groups a calendar can be put in; none while they are being read. */
  readonly groups: readonly CalendarGroup[] | undefined;
}): ReactElement {
  const { t, i18n } = useLingui();
  const zonesId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  // A draft saved as a type that can't take bookings keeps it on offer until it is changed.
  const kinds = kindChoices(saved?.calendar.kind ?? draft.kind);
  const bookable = isBookableKind(draft.kind);
  const groupMissing =
    draft.groupId !== null &&
    groups !== undefined &&
    !groups.some((group) => group.id === draft.groupId);
  /** Puts a merge field where the caret is in the title, or at its end. */
  const insert = (field: string): void => {
    const input = titleRef.current;
    const start = input?.selectionStart ?? draft.inviteTitle.length;
    const end = input?.selectionEnd ?? start;
    change({
      inviteTitle: `${draft.inviteTitle.slice(0, start)}${field}${draft.inviteTitle.slice(end)}`,
    });
  };
  return (
    <SectionCard
      title={<Trans>Basic details</Trans>}
      description={<Trans>Basic information used to identify this calendar.</Trans>}
    >
      <ImageDrop
        client={client}
        businessId={businessId}
        label={t`Calendar logo`}
        alt={t`Calendar logo preview`}
        hint={
          <Trans>
            PNG, JPEG, GIF or WebP, at most {imageMegabytes} MB. 180×180 px suits a logo best.
          </Trans>
        }
        fileId={draft.logoFileId}
        disabled={off}
        onChange={(logoFileId) => {
          change({ logoFileId });
        }}
      />
      <Labeled label={t`Calendar name`} problem={problems['name']}>
        {(control) => (
          <Input
            {...control}
            required
            maxLength={120}
            autoComplete="off"
            placeholder={t`(eg) Outbound reach`}
            disabled={off}
            value={draft.name}
            onChange={(event) => {
              change({ name: event.target.value });
            }}
          />
        )}
      </Labeled>
      <Labeled label={t`Description`} problem={problems['description']}>
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            maxLength={4000}
            placeholder={t`Write description`}
            disabled={off}
            value={draft.description}
            onChange={(event) => {
              change({ description: event.target.value });
            }}
          />
        )}
      </Labeled>
      <Labeled
        label={t`Custom URL`}
        problem={problems['bookingSlug']}
        description={<Trans>The public address people book at.</Trans>}
      >
        {(control) => (
          <div className="flex min-w-0 flex-col sm:flex-row">
            <span className="flex min-h-11 min-w-0 items-center rounded-t-control border border-input bg-muted px-3 text-md break-all text-body sm:max-w-[60%] sm:rounded-l-control sm:rounded-tr-none sm:border-r-0 lg:min-h-9">
              {bookingPrefix(agencySlug, businessSlug)}
            </span>
            <Input
              {...control}
              required
              maxLength={63}
              autoComplete="off"
              spellCheck={false}
              placeholder={t`my-calendar`}
              disabled={off}
              className="rounded-t-none sm:flex-1 sm:rounded-l-none sm:rounded-tr-control"
              value={draft.bookingSlug}
              onChange={(event) => {
                change({ bookingSlug: event.target.value });
              }}
            />
          </div>
        )}
      </Labeled>
      <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2">
        <Labeled label={t`Group`} problem={problems['groupId']}>
          {(control) => (
            <Select
              {...control}
              disabled={off || groups === undefined}
              value={draft.groupId ?? ''}
              onValueChange={(value) => {
                change({ groupId: value === '' ? null : value });
              }}
            >
              <option value="">{t`No group`}</option>
              {groupMissing ? (
                <option value={draft.groupId} disabled>
                  {t`Saved group`}
                </option>
              ) : null}
              {(groups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          )}
        </Labeled>
        <Labeled
          label={t`Meeting invite title`}
          problem={problems['inviteTitle']}
          description={
            <Trans>What an appointment booked here is called. Merge fields are filled in.</Trans>
          }
        >
          {(control) => (
            <div className="flex min-w-0 gap-2">
              <Input
                {...control}
                ref={titleRef}
                required
                maxLength={200}
                autoComplete="off"
                disabled={off}
                className="min-w-0 flex-1"
                value={draft.inviteTitle}
                onChange={(event) => {
                  change({ inviteTitle: event.target.value });
                }}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t`Insert a merge field`}
                  title={t`Insert a merge field`}
                  disabled={off}
                  className={`${iconButtonClassName} border border-input bg-card`}
                >
                  <Tag aria-hidden className="size-4" strokeWidth={1.8} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-56">
                  {mergeFields.map((field) => (
                    <DropdownMenuItem
                      key={field}
                      onClick={() => {
                        insert(field);
                      }}
                    >
                      <code className="font-mono text-sm">{field}</code>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </Labeled>
      </div>
      <div className="grid min-w-0 items-start gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <Labeled label={t`Calendar type`} problem={problems['kind']}>
          {(control) => (
            <Select
              {...control}
              disabled={off}
              value={draft.kind}
              onValueChange={(value) => {
                const kind: CalendarKind | undefined = kinds.find((each) => each === value);
                if (kind !== undefined) change({ kind });
              }}
            >
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {i18n._(kindNames[kind])}
                </option>
              ))}
            </Select>
          )}
        </Labeled>
        <Labeled label={t`Time zone`} problem={problems['timezone']}>
          {(control) => (
            <Input
              {...control}
              required
              list={zonesId}
              autoComplete="off"
              disabled={off}
              value={draft.timezone}
              onChange={(event) => {
                change({ timezone: event.target.value });
              }}
            />
          )}
        </Labeled>
        <datalist id={zonesId}>
          <option value="UTC" />
          {Intl.supportedValuesOf('timeZone').map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {/* A type that can't take bookings stays a draft: it has no switch to turn on. */}
        {bookable || draft.isActive ? (
          <SwitchRow
            label={<Trans>Active</Trans>}
            description={
              <Trans>
                Off, the calendar is a draft and its link takes no bookings. To take bookings it
                also needs its team. Confirmations are emailed only when a sender is chosen.
              </Trans>
            }
            checked={draft.isActive}
            disabled={off}
            onChange={(isActive) => {
              change({ isActive });
            }}
          />
        ) : (
          <NotYet>{i18n._(draftOnlyNote)}</NotYet>
        )}
        {problems['isActive'] === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problems['isActive']}
          </p>
        )}
      </div>
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">
          <Trans>Changing a calendar needs permission to manage calendars.</Trans>
        </p>
      )}
    </SectionCard>
  );
}
