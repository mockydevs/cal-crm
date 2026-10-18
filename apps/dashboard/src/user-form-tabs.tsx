// The tabs of Add user and Edit user after User info: Roles & permissions (one role, and
// what it grants: there are no per-person switches in the backend, so none are drawn) and
// Call & voicemail (no phone system yet: it says so). The other two tabs are fetched as
// they are first opened (user-availability.tsx, user-calendars.tsx).
import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { UserDetail } from '@repo/contracts';
import { Select } from '@repo/ui/components/select';
import { useId, type ReactElement } from 'react';
import { permissionNames } from './permission-names';
import { assignableRoles, type Role } from './users-rules';

const noteClassName = 'text-md text-muted-foreground';
const headingClassName = 'text-lg font-semibold';

export function RolesTab({
  roles,
  roleId,
  user,
  locked,
  problem,
  onChange,
}: {
  readonly roles: readonly Role[];
  readonly roleId: string;
  /** The person being edited; nobody yet on Add user. */
  readonly user: UserDetail | undefined;
  /** True when nothing on the form may be changed. */
  readonly locked: boolean;
  readonly problem: string | undefined;
  readonly onChange: (roleId: string) => void;
}): ReactElement {
  const { t, i18n } = useLingui();
  const labelId = useId();
  const reasonId = useId();
  const offered = assignableRoles(roles);
  const known = roles.find((role) => role.id === roleId);
  // Ownership is not given here, so an owner's own role is shown and nothing else is offered.
  const choices = known !== undefined && !offered.includes(known) ? [known, ...offered] : offered;
  const reason =
    user?.isOwner === true
      ? t`Ownership is assigned separately, so an owner's role isn't changed here.`
      : user?.isSelf === true
        ? t`You can't change your own role.`
        : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <h2 className={headingClassName}>
        <Trans>Roles & permissions</Trans>
      </h2>
      <div className="flex min-w-0 flex-col gap-1.5 sm:max-w-80">
        <span id={labelId} className="text-sm font-medium">
          <Trans>User role</Trans>
        </span>
        <Select
          aria-labelledby={labelId}
          {...(reason === undefined ? {} : { 'aria-describedby': reasonId })}
          aria-invalid={problem !== undefined}
          disabled={locked || reason !== undefined}
          value={roleId}
          onValueChange={onChange}
        >
          {known === undefined && user !== undefined ? (
            <option value={roleId} disabled>
              {user.roleName}
            </option>
          ) : null}
          {choices.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
        {reason === undefined ? null : (
          <p id={reasonId} className="text-sm text-muted-foreground">
            {reason}
          </p>
        )}
        {problem === undefined ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {problem}
          </p>
        )}
      </div>
      {known === undefined ? null : (
        <section aria-label={t`What this role can do`} className="flex flex-col gap-2">
          <h3 className="text-md font-semibold">
            <Trans>What this role can do</Trans>
          </h3>
          {known.permissions.length === 0 ? (
            <p className={noteClassName}>
              <Trans>Can view this workspace.</Trans>
            </p>
          ) : (
            <ul className="list-disc pl-5 text-sm text-body">
              {known.permissions.map((key) => (
                <li key={key}>{i18n._(permissionNames[key] ?? msg`Additional permissions`)}</li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">
            <Trans>
              What a person can do comes from their role. It can't be set person by person in this
              version.
            </Trans>
          </p>
        </section>
      )}
    </div>
  );
}

export function CallsTab(): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <h2 className={headingClassName}>
        <Trans>Call & voicemail</Trans>
      </h2>
      <p className={noteClassName}>
        <Trans>
          Calls and voicemail need the phone system, which isn't set up in this version.
        </Trans>
      </p>
    </div>
  );
}
