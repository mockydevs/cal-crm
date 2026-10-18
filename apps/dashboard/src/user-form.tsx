// Add user and Edit user, as GoHighLevel's page in the owner's screenshot: a back arrow and
// a title, five tabs down the left, Cancel and Next at the bottom right. Two things differ
// on purpose. Adding a person sends an invitation and nobody types another person's
// password (decision 2), so there is no password field and no "Advanced settings", which
// held only that. And the signature is the app's own simple rich text, not HTML (decision
// 7).
//
// One form holds every tab, so nothing typed is lost between them; Save sends the whole of
// it (addUser, or updateUser). The User availability tab saves through its own endpoints,
// with its own button.
import { Trans, useLingui } from '@lingui/react/macro';
import {
  addUser,
  createFileLink,
  getBusinessProfile,
  getUser,
  listCalendars,
  listUsers,
  updateUser,
  uploadFile,
  type Calendar,
  type UserDetail,
} from '@repo/contracts';
import { ApiError, type Client } from '@repo/sdk';
import { Button, buttonVariants } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Select } from '@repo/ui/components/select';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  CalendarDays,
  Camera,
  Clock,
  Phone,
  ShieldCheck,
  User,
  type LucideIcon,
} from 'lucide-react';
import { lazy, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Switch } from './automation-switch';
import { PanelContent } from './list-toolbar';
import { rejection } from './problems';
import { ListProblem } from './list-table';
import { retryFaults } from './settings-list';
import { usePageTitle } from './shell/page';
import { CallsTab, RolesTab } from './user-form-tabs';
import { UsersLink, useGoToUsers, type UsersPlace } from './users-links';
import {
  avatarAccept,
  avatarProblem,
  checkDraft,
  defaultRole,
  draftOf,
  infoFields,
  tabAfter,
  tabByKey,
  usersKey,
  usersNoticeKey,
  userTabs,
  type Role,
  type UserDraft,
  type UserTab,
} from './users-rules';

// Fetched as the form first shows them: libphonenumber, and the rich-text engine.
const PhoneField = lazy(() => import('./user-phone-field'));
const SignatureEditor = lazy(() => import('./user-signature-editor'));
// Fetched as their tabs are first opened: neither is needed to add or rename someone.
const UserAvailability = lazy(async () => ({
  default: (await import('./user-availability')).UserAvailability,
}));
const MemberCalendars = lazy(() => import('./user-calendars'));

/** The first field marked wrong on the tab showing. */
const FIRST_PROBLEM = '[role="tabpanel"]:not([hidden]) [aria-invalid="true"]';

const tabIcons: Readonly<Record<UserTab, LucideIcon>> = {
  info: User,
  roles: ShieldCheck,
  calls: Phone,
  availability: Clock,
  calendars: CalendarDays,
};

/** Every calendar of the business: the list comes fifty at a time. */
async function allCalendars(client: Client): Promise<Calendar[]> {
  const items: Calendar[] = [];
  let after: string | undefined;
  do {
    const page = await client.request(listCalendars, {
      query: { limit: 50, ...(after === undefined ? {} : { after }) },
    });
    items.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined && items.length < 1000);
  return items;
}

function Required(): ReactElement {
  return (
    <span aria-hidden className="text-destructive">
      {' *'}
    </span>
  );
}

function TextField({
  name,
  label,
  required = false,
  problem,
  description,
  children,
}: {
  readonly name: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly problem: string | undefined;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Field name={name} invalid={problem !== undefined} className="min-w-0">
      <FieldLabel>
        {label}
        {required ? <Required /> : null}
      </FieldLabel>
      {children}
      {description === undefined ? null : <FieldDescription>{description}</FieldDescription>}
      {problem === undefined ? null : <FieldError match>{problem}</FieldError>}
    </Field>
  );
}

function UserForm({
  client,
  workspace,
  place,
  roles,
  canManage,
  user,
}: {
  readonly client: Client;
  readonly workspace: string;
  readonly place: UsersPlace;
  readonly roles: readonly Role[];
  readonly canManage: boolean;
  /** The person being edited; nobody yet on Add user. */
  readonly user: UserDetail | undefined;
}): ReactElement {
  const { t } = useLingui();
  const cache = useQueryClient();
  const goToUsers = useGoToUsers(place);
  const adding = user === undefined;
  const inBusiness = place.kind === 'business';
  const locked = !canManage || (user !== undefined && !user.canEdit);
  const [enteredDraft, setEnteredDraft] = useState<UserDraft>(() =>
    draftOf(user, defaultRole(roles)?.id ?? ''),
  );
  // Roles can arrive on a later refresh; keep entered details and explicit role choices.
  const draft: UserDraft = {
    ...enteredDraft,
    roleId: enteredDraft.roleId || (defaultRole(roles)?.id ?? ''),
  };
  const [tab, setTab] = useState<UserTab>('info');
  const [visited, setVisited] = useState<readonly UserTab[]>(['info']);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [formProblem, setFormProblem] = useState<string>();
  // Counts the times the keyboard is sent to what is wrong, so each one moves it again.
  const [sentToProblem, setSentToProblem] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const tabsRef = useRef(new Map<UserTab, HTMLButtonElement>());
  const baseId = useId();
  const signatureLabelId = useId();
  const calendarLabelId = useId();
  const fileId = useId();

  useEffect(() => {
    if (sentToProblem === 0) return;
    formRef.current?.querySelector<HTMLElement>(FIRST_PROBLEM)?.focus();
  }, [sentToProblem]);

  const calendars = useQuery({
    queryKey: [...usersKey(workspace), 'calendars'],
    queryFn: () => allCalendars(client),
    enabled: inBusiness,
    retry: retryFaults,
  });
  // The country a new phone number starts in: the business's own, when its profile has one.
  const profile = useQuery({
    queryKey: [...usersKey(workspace), 'business-country'],
    queryFn: () => client.request(getBusinessProfile, {}),
    enabled: inBusiness,
    retry: false,
    staleTime: 10 * 60 * 1000,
  });
  const avatar = useQuery({
    queryKey: [...usersKey(workspace), 'avatar', draft.avatarFileId],
    queryFn: () =>
      client.request(createFileLink, {
        params: { id: draft.avatarFileId ?? '' },
        body: { expiresIn: 3600 },
      }),
    enabled: draft.avatarFileId !== null,
    staleTime: 30 * 60 * 1000,
    refetchInterval: 30 * 60 * 1000,
  });

  const change = (changed: Partial<UserDraft>) => {
    setEnteredDraft((current) => ({ ...current, ...changed }));
    setProblems((current) =>
      Object.fromEntries(Object.entries(current).filter(([field]) => !(field in changed))),
    );
  };
  const open = (next: UserTab) => {
    setTab(next);
    setVisited((current) => (current.includes(next) ? current : [...current, next]));
  };
  const words = {
    email: t`Enter the email address.`,
    phone: t`Enter a phone number of the country chosen, or leave it empty.`,
    signature: t`The signature is too long. Shorten it.`,
  };
  /** Shows what is wrong, on the tab that holds the first of it. */
  const show = (fields: Record<string, string>) => {
    setProblems(fields);
    const onInfo = infoFields.some((field) => fields[field] !== undefined);
    if (onInfo) open('info');
    else if (fields['roleId'] !== undefined) open('roles');
    setSentToProblem((count) => count + 1);
  };

  const upload = useMutation({
    mutationFn: (file: File) =>
      client.request(uploadFile, {
        query: { filename: file.name },
        upload: { content: file, type: file.type },
      }),
    onSuccess: (stored) => {
      change({ avatarFileId: stored.id });
    },
    onError: (error) => {
      setProblems((current) => ({
        ...current,
        avatarFileId:
          error instanceof ApiError
            ? (error.problem.detail ?? t`The image wasn't uploaded. Try again.`)
            : t`The image wasn't uploaded. Check your connection and try again.`,
      }));
    },
  });

  const save = useMutation({
    mutationFn: (checked: Extract<ReturnType<typeof checkDraft>, { ok: true }>) =>
      checked.mode === 'add'
        ? client.request(addUser, { body: checked.body })
        : client.request(updateUser, { params: { userId: user?.id ?? '' }, body: checked.body }),
    onSuccess: async (saved) => {
      const { name } = saved;
      cache.setQueryData(
        usersNoticeKey(workspace),
        !adding
          ? t`${name} was saved.`
          : saved.deliveryFailed === true
            ? t`${name} was added, but the invitation email could not be sent. Use Resend invitation.`
            : t`${name} was invited. They join when they accept the email.`,
      );
      await cache.invalidateQueries({ queryKey: usersKey(workspace) });
      goToUsers();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.problem.errors !== undefined) {
        const refused = rejection(error.problem.errors);
        show(refused.fields);
        setFormProblem(
          refused.form ??
            (Object.keys(refused.fields).length === 0
              ? (error.problem.detail ?? t`The user wasn't saved. Try again.`)
              : undefined),
        );
        return;
      }
      setFormProblem(
        error instanceof ApiError
          ? (error.problem.detail ?? t`The user wasn't saved. Try again.`)
          : t`The user wasn't saved. Check your connection and try again.`,
      );
    },
  });
  const busy = save.isPending;
  const off = locked || busy;

  const labels: Readonly<Record<UserTab, string>> = {
    info: t`User info`,
    roles: t`Roles & permissions`,
    calls: t`Call & voicemail`,
    availability: t`User availability`,
    calendars: t`Calendar configuration`,
  };
  const nextTab = tabAfter(tab);
  // None for someone who has not joined: an invitation has no membership.
  const membershipId = user?.membershipId ?? undefined;
  // A refusal that names something no tab shows is said above the buttons.
  const placed: readonly string[] = [...infoFields, 'roleId'];
  const stray = Object.entries(problems).find(([field]) => !placed.includes(field))?.[1];
  const wholeProblem = formProblem ?? stray;
  const calendarItems = calendars.data ?? [];
  const savedCalendarMissing =
    draft.calendarId !== null &&
    calendars.data !== undefined &&
    !calendarItems.some((calendar) => calendar.id === draft.calendarId);

  return (
    <form
      ref={formRef}
      noValidate
      className="flex min-w-0 flex-col gap-5 rounded-card border border-border bg-card p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (off || upload.isPending) return;
        setFormProblem(undefined);
        const checked = checkDraft(draft, adding ? 'add' : 'edit', words);
        if (!checked.ok) {
          show(checked.fields);
          return;
        }
        setProblems({});
        save.mutate(checked);
      }}
    >
      {locked ? (
        <p className="text-sm text-muted-foreground">
          {!canManage ? (
            <Trans>
              You can look at this person. Changing them needs permission to manage users.
            </Trans>
          ) : user?.userType === 'agency' && inBusiness ? (
            <Trans>This person is on the agency's team. Change them in the agency's Users.</Trans>
          ) : (
            <Trans>Only an owner changes an owner.</Trans>
          )}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:gap-8">
        <div
          role="tablist"
          aria-label={adding ? t`Add user` : t`Edit user`}
          aria-orientation="vertical"
          className="flex min-w-0 shrink-0 gap-1 overflow-x-auto lg:w-60 lg:flex-col lg:overflow-visible"
        >
          {userTabs.map((each) => {
            const Icon = tabIcons[each];
            return (
              <button
                key={each}
                ref={(button) => {
                  if (button === null) tabsRef.current.delete(each);
                  else tabsRef.current.set(each, button);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${each}`}
                aria-selected={each === tab}
                aria-controls={`${baseId}-panel-${each}`}
                tabIndex={each === tab ? 0 : -1}
                className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-control px-3 text-left text-sm font-medium whitespace-nowrap text-body -outline-offset-2 hover:bg-muted hover:text-foreground aria-selected:bg-accent aria-selected:text-link lg:min-h-10"
                onClick={() => {
                  open(each);
                }}
                onKeyDown={(event) => {
                  const next = tabByKey(each, event.key);
                  if (next === undefined) return;
                  event.preventDefault();
                  open(next);
                  tabsRef.current.get(next)?.focus();
                }}
              >
                <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.8} />
                {labels[each]}
              </button>
            );
          })}
        </div>
        <div className="min-w-0 flex-1">
          <div
            role="tabpanel"
            id={`${baseId}-panel-info`}
            aria-labelledby={`${baseId}-tab-info`}
            hidden={tab !== 'info'}
            className="flex min-w-0 flex-col gap-5"
          >
            <h2 className="text-lg font-semibold">
              <Trans>Personal Details</Trans>
            </h2>
            <div className="flex min-w-0 flex-wrap items-center gap-4">
              <div className="relative shrink-0">
                <span className="flex size-20 items-center justify-center overflow-hidden rounded-full bg-muted text-2xl font-medium text-muted-foreground">
                  {draft.avatarFileId !== null && avatar.data !== undefined ? (
                    <img
                      src={avatar.data.url}
                      alt={t`Profile preview`}
                      className="size-full object-cover"
                    />
                  ) : (
                    <span aria-hidden>?</span>
                  )}
                </span>
                {locked ? null : (
                  <label
                    htmlFor={fileId}
                    title={t`Choose a profile image`}
                    className="absolute -right-1 -bottom-1 flex size-9 cursor-pointer items-center justify-center rounded-full border border-input bg-card text-body hover:bg-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                  >
                    <Camera aria-hidden className="size-4" strokeWidth={1.8} />
                    <span className="sr-only">
                      <Trans>Choose a profile image</Trans>
                    </span>
                    <input
                      id={fileId}
                      type="file"
                      accept={avatarAccept}
                      className="sr-only"
                      disabled={off || upload.isPending}
                      aria-describedby={`${fileId}-help`}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        // The same file can be chosen again after a refusal.
                        event.target.value = '';
                        if (file === undefined) return;
                        const refused = avatarProblem(file);
                        if (refused !== undefined) {
                          setProblems((current) => ({
                            ...current,
                            avatarFileId:
                              refused === 'size'
                                ? t`That image is bigger than 2.5 MB. Choose a smaller one.`
                                : t`Choose a PNG, JPEG, GIF or WebP image.`,
                          }));
                          return;
                        }
                        setProblems(({ avatarFileId: _gone, ...rest }) => rest);
                        upload.mutate(file);
                      }}
                    />
                  </label>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <p className="text-sm font-medium">
                  <Trans>Profile Image</Trans>
                </p>
                <p id={`${fileId}-help`} className="text-sm text-muted-foreground">
                  <Trans>The proposed size is 512*512 px no bigger than 2.5 MB</Trans>
                </p>
                {upload.isPending ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    <Trans>Uploading…</Trans>
                  </p>
                ) : null}
                {avatar.isError && draft.avatarFileId !== null ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>The image is saved, but its preview couldn't be loaded.</Trans>
                  </p>
                ) : null}
                {problems['avatarFileId'] === undefined ? null : (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    {problems['avatarFileId']}
                  </p>
                )}
                {draft.avatarFileId === null || locked ? null : (
                  <Button
                    variant="quiet"
                    size="small"
                    className="self-start"
                    disabled={off}
                    onClick={() => {
                      change({ avatarFileId: null });
                    }}
                  >
                    <Trans>Remove image</Trans>
                  </Button>
                )}
              </div>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <TextField
                name="firstName"
                label={<Trans>First name</Trans>}
                required
                problem={problems['firstName']}
              >
                <Input
                  required
                  maxLength={100}
                  autoComplete="off"
                  disabled={off}
                  value={draft.firstName}
                  onChange={(event) => {
                    change({ firstName: event.target.value });
                  }}
                />
              </TextField>
              <TextField
                name="lastName"
                label={<Trans>Last name</Trans>}
                required
                problem={problems['lastName']}
              >
                <Input
                  required
                  maxLength={100}
                  autoComplete="off"
                  disabled={off}
                  value={draft.lastName}
                  onChange={(event) => {
                    change({ lastName: event.target.value });
                  }}
                />
              </TextField>
            </div>
            <TextField
              name="email"
              label={<Trans>Email</Trans>}
              required
              problem={problems['email']}
              description={
                adding ? undefined : (
                  <Trans>
                    The address is the person's own sign-in account's. It isn't changed here.
                  </Trans>
                )
              }
            >
              <Input
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                readOnly={!adding}
                disabled={adding && off}
                value={draft.email}
                onChange={(event) => {
                  change({ email: event.target.value });
                }}
              />
            </TextField>
            <div className="grid min-w-0 items-start gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
              <PanelContent>
                <PhoneField
                  initial={user?.phone ?? null}
                  defaultCountry={profile.data?.address?.country ?? null}
                  disabled={off}
                  problem={problems['phone']}
                  onChange={(phone) => {
                    change({ phone });
                  }}
                />
              </PanelContent>
              <TextField
                name="extension"
                label={<Trans>Extension</Trans>}
                problem={problems['extension']}
              >
                <Input
                  inputMode="numeric"
                  maxLength={10}
                  autoComplete="off"
                  disabled={off}
                  value={draft.extension}
                  onChange={(event) => {
                    change({ extension: event.target.value });
                  }}
                />
              </TextField>
            </div>
            {inBusiness ? (
              <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-96">
                <span id={calendarLabelId} className="text-sm font-medium">
                  <Trans>Calendar</Trans>
                </span>
                <Select
                  aria-labelledby={calendarLabelId}
                  aria-invalid={problems['calendarId'] !== undefined}
                  disabled={off || calendars.data === undefined}
                  value={draft.calendarId ?? ''}
                  onValueChange={(value) => {
                    change({ calendarId: value === '' ? null : value });
                  }}
                >
                  <option value="">{t`Select a calendar`}</option>
                  {savedCalendarMissing ? (
                    <option value={draft.calendarId} disabled>
                      {t`Saved calendar`}
                    </option>
                  ) : null}
                  {calendarItems.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>
                      {calendar.name}
                    </option>
                  ))}
                </Select>
                <p className="text-sm text-muted-foreground">
                  <Trans>The calendar this person's own appointments go on by default.</Trans>
                </p>
                {calendars.isError ? (
                  <p className="text-sm text-muted-foreground">
                    <Trans>The calendars couldn't be loaded.</Trans>
                  </p>
                ) : null}
                {problems['calendarId'] === undefined ? null : (
                  <p role="alert" className="text-sm font-medium text-destructive">
                    {problems['calendarId']}
                  </p>
                )}
              </div>
            ) : null}
            <div className="flex min-w-0 flex-col gap-3">
              <h3 className="text-md font-semibold">
                <Trans>Signature</Trans>
              </h3>
              <div className="flex min-w-0 items-center gap-3">
                <Switch
                  checked={draft.signatureEnabled}
                  disabled={off}
                  aria-labelledby={signatureLabelId}
                  onChange={(signatureEnabled) => {
                    change({ signatureEnabled });
                  }}
                />
                <span id={signatureLabelId} className="text-sm font-medium">
                  <Trans>Add signature to outgoing emails</Trans>
                </span>
              </div>
              <PanelContent>
                <SignatureEditor
                  initial={user?.signature.document ?? null}
                  label={t`Email signature`}
                  disabled={off}
                  onChange={(signature) => {
                    change({ signature });
                  }}
                />
              </PanelContent>
              {problems['signature'] === undefined ? null : (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {problems['signature']}
                </p>
              )}
            </div>
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-panel-roles`}
            aria-labelledby={`${baseId}-tab-roles`}
            hidden={tab !== 'roles'}
          >
            <RolesTab
              roles={roles}
              roleId={draft.roleId}
              user={user}
              locked={off}
              problem={problems['roleId']}
              onChange={(roleId) => {
                change({ roleId });
              }}
            />
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-panel-calls`}
            aria-labelledby={`${baseId}-tab-calls`}
            hidden={tab !== 'calls'}
          >
            <CallsTab />
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-panel-availability`}
            aria-labelledby={`${baseId}-tab-availability`}
            hidden={tab !== 'availability'}
            className="flex min-w-0 flex-col gap-3"
          >
            <h2 className="text-lg font-semibold">
              <Trans>User availability</Trans>
            </h2>
            {!inBusiness ? (
              <p className="text-md text-muted-foreground">
                <Trans>
                  Availability is set business by business. Open this person in a business to set
                  theirs.
                </Trans>
              </p>
            ) : membershipId === undefined ? (
              <p className="text-md text-muted-foreground">
                <Trans>
                  Availability can be set once this person has joined. Until then they follow the
                  hours of the calendars they are put on.
                </Trans>
              </p>
            ) : visited.includes('availability') ? (
              <PanelContent>
                <UserAvailability
                  client={client}
                  workspace={workspace}
                  membershipId={membershipId}
                />
              </PanelContent>
            ) : null}
          </div>
          <div
            role="tabpanel"
            id={`${baseId}-panel-calendars`}
            aria-labelledby={`${baseId}-tab-calendars`}
            hidden={tab !== 'calendars'}
            className="flex min-w-0 flex-col gap-3"
          >
            <h2 className="text-lg font-semibold">
              <Trans>Calendar configuration</Trans>
            </h2>
            {place.kind === 'agency' ? (
              <p className="text-md text-muted-foreground">
                <Trans>
                  Calendars belong to a business. Open this person in a business to see the
                  calendars they are on.
                </Trans>
              </p>
            ) : membershipId === undefined ? (
              <p className="text-md text-muted-foreground">
                <Trans>
                  Once this person has joined, the calendars they are on are listed here. You add
                  them to a calendar's team in Settings, Calendars.
                </Trans>
              </p>
            ) : calendars.isError ? (
              <p role="alert" className="text-sm text-destructive">
                <Trans>The calendars couldn't be loaded. Reload the page to try again.</Trans>
              </p>
            ) : calendars.data === undefined ? (
              <p role="status" className="text-sm text-muted-foreground">
                <Trans>Loading calendars…</Trans>
              </p>
            ) : visited.includes('calendars') ? (
              <PanelContent>
                <MemberCalendars
                  client={client}
                  workspace={workspace}
                  slug={place.slug}
                  membershipId={membershipId}
                  calendars={calendars.data}
                />
              </PanelContent>
            ) : null}
          </div>
        </div>
      </div>
      {wholeProblem === undefined ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {wholeProblem}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
        {adding && !locked ? (
          <p className="mr-auto max-w-prose min-w-0 text-sm text-muted-foreground">
            <Trans>
              Saving sends this person an email invitation. They set their own password from it, and
              show as Invited until they accept.
            </Trans>
          </p>
        ) : null}
        <UsersLink place={place} className={buttonVariants({ variant: 'secondary' })}>
          <Trans>Cancel</Trans>
        </UsersLink>
        {nextTab === undefined ? null : (
          <Button
            variant={locked ? 'primary' : 'secondary'}
            onClick={() => {
              // The details are asked for before the tabs after them, as on the page copied.
              if (tab === 'info' && !locked) {
                const checked = checkDraft(draft, adding ? 'add' : 'edit', words);
                const wrong = checked.ok
                  ? []
                  : infoFields.filter((field) => checked.fields[field] !== undefined);
                if (!checked.ok && wrong.length > 0) {
                  show(
                    Object.fromEntries(wrong.map((field) => [field, checked.fields[field] ?? ''])),
                  );
                  return;
                }
              }
              open(nextTab);
              tabsRef.current.get(nextTab)?.focus();
            }}
          >
            <Trans>Next</Trans>
          </Button>
        )}
        {locked ? null : (
          <Button type="submit" disabled={busy || upload.isPending}>
            {busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Add user, or Edit user for the membership id given. */
export function UserFormPage({
  client,
  workspace,
  place,
  userId,
}: {
  readonly client: Client;
  /** What the cache is keyed by: the business's id, or "agency". */
  readonly workspace: string;
  readonly place: UsersPlace;
  readonly userId?: string;
}): ReactElement {
  const { t } = useLingui();
  const title = userId === undefined ? t`Add user` : t`Edit user`;
  usePageTitle(title);
  // The roles a person can be given, and whether this person may manage users at all.
  const settings = useQuery({
    queryKey: [...usersKey(workspace), 'roles'],
    queryFn: () => client.request(listUsers, { query: { limit: 1 } }),
    retry: retryFaults,
  });
  const person = useQuery({
    queryKey: [...usersKey(workspace), 'one', userId],
    queryFn: () => client.request(getUser, { params: { userId: userId ?? '' } }),
    enabled: userId !== undefined,
    retry: retryFaults,
    // A form being filled in is not replaced under the person filling it.
    refetchOnWindowFocus: false,
  });
  const gone = person.error instanceof ApiError && person.error.status === 404;
  const loading = settings.isPending || (userId !== undefined && person.isPending);
  const failed = settings.isError || person.isError;
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <UsersLink
          place={place}
          aria-label={t`Back to users`}
          title={t`Back to users`}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-body -outline-offset-2 hover:bg-secondary hover:text-foreground lg:size-9"
        >
          <ArrowLeft aria-hidden className="size-5" strokeWidth={1.8} />
        </UsersLink>
        <h1 className="min-w-0 text-[30px] leading-tight font-semibold">{title}</h1>
      </div>
      {loading && !failed ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : null}
      {gone ? (
        <p role="alert" className="text-md">
          <Trans>This person isn't in this workspace any more.</Trans>
        </p>
      ) : failed ? (
        <ListProblem
          onRetry={() => {
            void settings.refetch();
            if (userId !== undefined) void person.refetch();
          }}
        >
          <Trans>This page couldn't be loaded.</Trans>
        </ListProblem>
      ) : null}
      {settings.data === undefined || (userId !== undefined && person.data === undefined) ? null : (
        <UserForm
          key={person.data?.id ?? 'new'}
          client={client}
          workspace={workspace}
          place={place}
          roles={settings.data.roles}
          canManage={settings.data.canManage}
          user={person.data}
        />
      )}
    </>
  );
}
