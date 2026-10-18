// The contract of the workflow list and tabs: what was added to the automation API stays
// optional, so answers and fixtures written before it still parse, and each new input takes
// exactly what it documents.
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  automation,
  automationList,
  automationRunList,
  listAutomationRuns,
  listAutomations,
} from './automations-api.js';
import {
  AUTOMATION_FOLDER_MAX_DEPTH,
  automationManageEndpoints,
  automationStats,
  automationStepRunList,
  createAutomationFolderInput,
  listAutomationStepRuns,
  moveAutomationInput,
  updateAutomationFolderInput,
} from './automations-manage.js';

const AUTOMATION = 'aut_01h455vb4pex5vsknk084sn02q';
const FOLDER = 'afol_01h455vb4pex5vsknk084sn02q';
const RUN = 'arun_01h455vb4pex5vsknk084sn02q';
const CONTACT = 'con_01h455vb4pex5vsknk084sn02q';
const AT = '2026-10-10T09:00:00.000Z';

// An automation and a run exactly as the API answered before folders and counts existed.
const summaryBefore = {
  id: AUTOMATION,
  name: 'Follow-up',
  description: '',
  status: 'active',
  draftVersion: 2,
  liveVersion: 1,
  lastRunAt: null,
  createdAt: AT,
  updatedAt: AT,
};
const runBefore = {
  id: RUN,
  automationId: AUTOMATION,
  automationName: 'Follow-up',
  version: 1,
  status: 'waiting',
  recordId: CONTACT,
  record: { id: CONTACT, name: 'Ada', trashed: false },
  currentStep: 'pause',
  exitReason: null,
  wakeAt: AT,
  startedAt: AT,
  finishedAt: null,
};

describe('what was added to existing answers', () => {
  it('is optional: an answer from before it still parses, unchanged', () => {
    const list = { canManage: true, items: [summaryBefore], nextCursor: null };
    expect(automationList.parse(list)).toEqual(list);
    const detail = { ...summaryBefore, draft: {}, live: null };
    expect(automation.parse(detail)).toEqual(detail);
    const runs = { items: [runBefore], nextCursor: null };
    expect(automationRunList.parse(runs)).toEqual(runs);
  });

  it('carries the folder, the counts, the deletion, the trigger and the step a run is at', () => {
    const summary = {
      ...summaryBefore,
      status: 'archived',
      folderId: null,
      totalEnrolled: 12,
      activeEnrolled: 3,
      deletedAt: AT,
      purgeAt: AT,
    };
    expect(
      automationList.parse({ canManage: true, items: [summary], nextCursor: null }).items,
    ).toEqual([summary]);
    const run = {
      ...runBefore,
      trigger: { id: 'created', type: 'contact.created' },
      currentAction: { step: 'pause', type: 'wait', label: null },
    };
    expect(automationRunList.parse({ items: [run], nextCursor: null }).items).toEqual([run]);
    expect(
      automationList.safeParse({
        canManage: true,
        items: [{ ...summaryBefore, totalEnrolled: -1 }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('the list filters', () => {
  it('take a folder or the top level, a name to search, and the Deleted list by status', () => {
    expect(listAutomations.query.parse({ folder: FOLDER, q: '  lead ' })).toEqual({
      folder: FOLDER,
      q: 'lead',
    });
    expect(listAutomations.query.parse({ folder: 'root', status: 'archived' })).toEqual({
      folder: 'root',
      status: 'archived',
    });
    expect(listAutomations.query.safeParse({ folder: 'home' }).success).toBe(false);
    expect(listAutomations.query.safeParse({ q: ' ' }).success).toBe(false);
  });

  it('take a date range, a record, a trigger and a status for the enrollment history', () => {
    const query = { status: 'waiting', from: AT, to: AT, record: CONTACT, trigger: 'created' };
    expect(listAutomationRuns.query.parse(query)).toEqual(query);
    expect(listAutomationRuns.query.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(listAutomationRuns.query.safeParse({ record: AUTOMATION }).success).toBe(false);
    expect(listAutomationRuns.query.safeParse({ trigger: 'Not A Key' }).success).toBe(false);
  });

  it('take a status, a step, a type, a date range and a record for the execution logs', () => {
    const query = {
      status: 'failed',
      step: 'send_guide',
      type: 'email.send',
      from: AT,
      to: AT,
      record: CONTACT,
    };
    expect(listAutomationStepRuns.query.parse(query)).toEqual(query);
    expect(listAutomationStepRuns.query.safeParse({ status: 'completed' }).success).toBe(false);
    expect(listAutomationStepRuns.query.safeParse({ after: RUN }).success).toBe(false);
    const empty = { items: [], nextCursor: null };
    expect(automationStepRunList.parse(empty)).toEqual(empty);
  });
});

describe('folders', () => {
  it('are named in 1 to 120 characters, trimmed, at the top level unless a parent is given', () => {
    expect(createAutomationFolderInput.parse({ name: '  Leads ' })).toEqual({
      name: 'Leads',
      parentId: null,
    });
    expect(createAutomationFolderInput.parse({ name: 'Leads', parentId: FOLDER }).parentId).toBe(
      FOLDER,
    );
    expect(createAutomationFolderInput.safeParse({ name: ' ' }).success).toBe(false);
    expect(createAutomationFolderInput.safeParse({ name: 'x'.repeat(121) }).success).toBe(false);
    expect(
      createAutomationFolderInput.safeParse({ name: 'Leads', parentId: AUTOMATION }).success,
    ).toBe(false);
    expect(AUTOMATION_FOLDER_MAX_DEPTH).toBe(5);
  });

  it('change only from the revision the caller saw, and move to a folder or the top level', () => {
    expect(updateAutomationFolderInput.parse({ revision: 3, name: ' Old leads ' })).toEqual({
      revision: 3,
      name: 'Old leads',
    });
    expect(updateAutomationFolderInput.parse({ revision: 1, parentId: null })).toEqual({
      revision: 1,
      parentId: null,
    });
    expect(updateAutomationFolderInput.safeParse({ name: 'Leads' }).success).toBe(false);
    expect(updateAutomationFolderInput.safeParse({ revision: 0, name: 'Leads' }).success).toBe(
      false,
    );
    expect(moveAutomationInput.parse({ folderId: null })).toEqual({ folderId: null });
    expect(moveAutomationInput.safeParse({}).success).toBe(false);
  });
});

describe('statistics', () => {
  it('give each count for the live version and for all time, and no live numbers without one', () => {
    const runs = { enrolled: 4, active: 1, completed: 2, exited: 1, failed: 0, cancelled: 0 };
    const steps = { entered: 4, completed: 3, failed: 0, waiting: 1, skipped: 0 };
    const stats = {
      automationId: AUTOMATION,
      liveVersion: null,
      runs: { allTime: runs, live: null },
      triggers: [
        {
          trigger: 'created',
          type: null,
          inLiveVersion: false,
          allTime: { enrolled: 4 },
          live: null,
        },
      ],
      steps: [
        {
          step: 'pause',
          type: 'wait',
          label: null,
          inLiveVersion: false,
          allTime: steps,
          live: null,
        },
      ],
    };
    expect(automationStats.parse(stats)).toEqual(stats);
    expect(
      automationStats.safeParse({
        ...stats,
        runs: { allTime: { ...runs, active: -1 }, live: null },
      }).success,
    ).toBe(false);
  });
});

describe('the registry', () => {
  it('lists each new operation once, under Automations, at a path of its own', () => {
    expect(automationManageEndpoints.map((endpoint) => endpoint.operationId)).toEqual([
      'listAutomationFolders',
      'createAutomationFolder',
      'updateAutomationFolder',
      'deleteAutomationFolder',
      'moveAutomation',
      'deleteAutomation',
      'restoreAutomation',
      'getAutomationStats',
      'listAutomationStepRuns',
      'listAutomationTriggerEvaluations',
      'explainAutomationContact',
    ]);
    for (const endpoint of automationManageEndpoints) {
      expect(endpoint.group).toBe('Automations');
      expect(endpoints.filter((each) => each.operationId === endpoint.operationId)).toEqual([
        endpoint,
      ]);
      expect(
        endpoints.filter((each) => each.method === endpoint.method && each.path === endpoint.path),
      ).toEqual([endpoint]);
    }
  });
});
