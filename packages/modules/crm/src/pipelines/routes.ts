import { runCommand, type ApiRoute } from '@repo/commands';
import {
  deletePipeline,
  deletePipelineInput,
  duplicatePipeline,
  duplicatePipelineInput,
  getOpportunitySettings,
  getPipelines,
  movePipeline,
  movePipelineInput,
  parseInput,
  savePipelines,
  updateOpportunitySettings,
} from '@repo/contracts';
import { withTenant } from '@repo/db';

import { readOpportunitySettings, updateOpportunitySettingsCommand } from '../deals/owner-rules.js';
import { deletePipelineCommand, duplicatePipelineCommand, movePipelineCommand } from './manage.js';
import { readPipelines, savePipelinesCommand } from './pipelines.js';

export const pipelineRoutes: readonly ApiRoute[] = [
  {
    endpoint: getPipelines,
    run: ({ invocation }, { db }) =>
      withTenant(db, invocation.context, (trx) => readPipelines(trx, invocation)),
  },
  {
    endpoint: savePipelines,
    command: savePipelinesCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, savePipelinesCommand, body, invocation),
  },
  // One pipeline moved, copied or deleted by itself. Each body is checked as the API
  // documents it; the id comes from the path.
  {
    endpoint: movePipeline,
    command: movePipelineCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        movePipelineCommand,
        { ...parseInput(movePipelineInput, body), ...parseInput(movePipeline.params, params) },
        invocation,
      ),
  },
  {
    endpoint: duplicatePipeline,
    command: duplicatePipelineCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        duplicatePipelineCommand,
        {
          ...parseInput(duplicatePipelineInput, body),
          ...parseInput(duplicatePipeline.params, params),
        },
        invocation,
      ),
  },
  {
    endpoint: deletePipeline,
    command: deletePipelineCommand,
    run: ({ invocation, params, body }, services) =>
      runCommand(
        services,
        deletePipelineCommand,
        { ...parseInput(deletePipelineInput, body), ...parseInput(deletePipeline.params, params) },
        invocation,
      ),
  },
  // The opportunity settings of the business.
  {
    endpoint: getOpportunitySettings,
    run: ({ invocation }, { db }) =>
      withTenant(db, invocation.context, (trx) => readOpportunitySettings(trx, invocation)),
  },
  {
    endpoint: updateOpportunitySettings,
    command: updateOpportunitySettingsCommand,
    run: ({ invocation, body }, services) =>
      runCommand(services, updateOpportunitySettingsCommand, body, invocation),
  },
];
