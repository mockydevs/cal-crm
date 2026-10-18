/** Who or what is acting, as the database records it (events.actor_kind and the like). */
export const actorKinds = [
  'user',
  'ai_agent',
  'automation',
  'api_key',
  'system',
  'contact',
  'form',
  'import',
] as const;

export type ActorKind = (typeof actorKinds)[number];

/**
 * Whom a transaction acts for. Row-level security reads it, so it decides which rows the
 * transaction can see and write. Every id is a UUID.
 */
export interface TenantContext {
  readonly agencyId: string;
  /** Left out for agency staff working with no business selected. */
  readonly businessId?: string;
  readonly userId?: string;
  readonly actorKind: ActorKind;
  readonly actorId?: string;
  /** Shared by everything that one originating request causes. */
  readonly correlationId: string;
}

/**
 * The settings a transaction sets before anything else, each with set_config(name,
 * value, true) so they end with the transaction. A missing value is an empty string,
 * which the database reads as NULL.
 */
export function tenantSettings(context: TenantContext): [name: string, value: string][] {
  return [
    ['app.agency_id', context.agencyId],
    ['app.business_id', context.businessId ?? ''],
    ['app.user_id', context.userId ?? ''],
    ['app.actor_kind', context.actorKind],
    ['app.actor_id', context.actorId ?? ''],
    ['app.correlation_id', context.correlationId],
  ];
}
