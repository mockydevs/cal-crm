import {
  requireBusiness,
  runCommand,
  type ApiRoute,
  type RouteRequest,
  type Services,
} from '@repo/commands';
import {
  createField,
  getFields,
  updateField,
  parseInput,
  updateFieldInput,
  type FieldDefinition,
} from '@repo/contracts';
import { withTenant } from '@repo/db';
import { NotFoundError, parsePublicId } from '@repo/kernel';
import { createFieldCommand, readFields, updateFieldCommand } from './fields.js';
export const fieldRoutes: readonly ApiRoute[] = [
  {
    endpoint: getFields,
    run: ({ invocation }, { db }) =>
      withTenant(db, invocation.context, (trx) => readFields(trx, invocation)),
  },
  {
    endpoint: createField,
    command: createFieldCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, createFieldCommand, body, invocation),
  },
  {
    endpoint: updateField,
    command: updateFieldCommand,
    run: async (
      { invocation, body, params }: RouteRequest,
      services: Services,
    ): Promise<FieldDefinition> => {
      requireBusiness(invocation.context);
      const parsed = parseInput(updateField.params, params);
      // Do not describe an inaccessible field's input requirements (API isolation suite).
      await withTenant(services.db, invocation.context, async (trx) => {
        const row = await trx
          .selectFrom('crm.field_definitions')
          .select('id')
          .where('id', '=', parsePublicId('field', parsed.fieldId) ?? '')
          .executeTakeFirst();
        if (row === undefined) throw new NotFoundError('Field', parsed.fieldId);
      });
      return runCommand(
        services,
        updateFieldCommand,
        { ...parseInput(updateFieldInput, body), ...parsed },
        invocation,
      );
    },
  },
];
