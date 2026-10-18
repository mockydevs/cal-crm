import { createApiKeyInput, type ApiKeyReadGroup } from '@repo/contracts';
import { snoozeTimeOf as futureDatetimeLocal } from './inbox-rules';

interface KeyPolicyDraft {
  readonly access: 'read-only' | 'custom' | 'full';
  readonly scopes: readonly string[];
  readonly readGroups: readonly ApiKeyReadGroup[];
  readonly chosen: ReadonlySet<string>;
  readonly selectedGroups: ReadonlySet<string>;
}

/** Turn the entered draft into the native body, intersecting every choice with current grants. */
export function apiKeyInputOf(
  values: Record<string, unknown>,
  policy: KeyPolicyDraft,
):
  | ReturnType<typeof createApiKeyInput.safeParse>
  | {
      readonly success: false;
      readonly expiryProblem: 'invalid' | 'past';
    } {
  const expiry = values['expiresAt'];
  const converted =
    expiry === '' || expiry === undefined
      ? undefined
      : typeof expiry === 'string'
        ? futureDatetimeLocal(expiry, new Date())
        : ({ ok: false, why: 'invalid' } as const);
  if (converted?.ok === false) return { success: false, expiryProblem: converted.why } as const;
  const { access, scopes, readGroups, chosen, selectedGroups } = policy;
  return createApiKeyInput.safeParse({
    name: values['name'],
    scopes: scopes.filter(
      (scope) =>
        access === 'full' ||
        (access === 'read-only'
          ? chosen.has(scope) && (scope === 'payments.read' || scope === 'reports.view')
          : chosen.has(scope)),
    ),
    readOnly: access === 'read-only',
    readGroups: readGroups.filter((group) => access === 'full' || selectedGroups.has(group)),
    ...(converted?.ok === true ? { expiresAt: converted.until } : {}),
  });
}
