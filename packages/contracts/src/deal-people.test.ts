import { toPublicId } from '@repo/kernel';
import { describe, expect, it } from 'vitest';

import { endpoints } from './api.js';
import {
  assignDealOwnerCommandInput,
  contactDeals,
  contactDealsQuery,
  dealDetails,
  dealFollowersCommandInput,
  dealPeopleEndpoints,
  setDealContactsCommandInput,
  setDealContactsInput,
} from './deal-people.js';
import {
  createDealInput,
  deal,
  dealListExtrasOf,
  dealListQuery,
  dealSortDirection,
  dealStageSummaryQuery,
  MAX_DEAL_ADDITIONAL_CONTACTS,
} from './deals.js';
import {
  deletePipelineCommandInput,
  duplicatePipelineCommandInput,
  movePipelineCommandInput,
  opportunitySettings,
  pipelineSettingEndpoints,
  savePipelinesInput,
  updateOpportunitySettingsInput,
} from './pipelines.js';
import {
  createViewInput,
  dealTableColumnKeys,
  dealTableColumns,
  dealViewChanges,
  dealViewState,
} from './saved-views.js';

const uuid = (n: number) => `01890a5d-ac96-774b-bcce-${n.toString(16).padStart(12, '0')}`;
const contact = (n: number) => toPublicId('contact', uuid(n));
const dealId = toPublicId('deal', uuid(1));
const revision = 'a'.repeat(64);
const newDeal = {
  name: 'Garden fence',
  pipelineId: toPublicId('pipeline', uuid(2)),
  stageId: toPublicId('stage', uuid(3)),
  currency: 'KES',
};
const shown = {
  ...newDeal,
  id: dealId,
  amount: null,
  expectedCloseDate: null,
  status: 'open',
  outcomeReason: null,
  pipelineName: 'Sales',
  stageName: 'New lead',
  closedAt: null,
  stageEnteredAt: '2026-10-11T00:00:00.000Z',
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
  trashedAt: null,
  revision,
  canManage: true,
};

describe("a deal's contacts", () => {
  it('are one primary and at most ten others, none of them the primary, each once', () => {
    const input = (primaryContactId: string | null, additionalContactIds: string[]) =>
      setDealContactsInput.safeParse({ primaryContactId, additionalContactIds, revision });
    const others = Array.from({ length: MAX_DEAL_ADDITIONAL_CONTACTS + 1 }, (_, n) =>
      contact(n + 10),
    );
    expect(input(contact(1), others.slice(0, MAX_DEAL_ADDITIONAL_CONTACTS)).success).toBe(true);
    expect(input(null, []).success).toBe(true);
    expect(input(contact(1), others).success).toBe(false);
    expect(input(contact(1), [contact(1)]).error?.issues[0]?.path).toEqual([
      'additionalContactIds',
      0,
    ]);
    expect(input(null, [contact(2), contact(2)]).error?.issues[0]?.path).toEqual([
      'additionalContactIds',
      1,
    ]);
    // A revision and a contact's own id are required; nothing else is taken.
    expect(setDealContactsInput.safeParse({ primaryContactId: null }).success).toBe(false);
    expect(input(dealId, []).success).toBe(false);
    expect(
      setDealContactsCommandInput.parse({
        id: dealId,
        primaryContactId: contact(1),
        additionalContactIds: [],
        revision,
      }).id,
    ).toBe(dealId);
  });

  it('can be named by a new deal, under the same rules, and are optional there', () => {
    expect(createDealInput.parse(newDeal)).not.toHaveProperty('primaryContactId');
    expect(
      createDealInput.parse({ ...newDeal, primaryContactId: contact(1) }).primaryContactId,
    ).toBe(contact(1));
    expect(
      createDealInput.safeParse({
        ...newDeal,
        primaryContactId: contact(1),
        additionalContactIds: [contact(1)],
      }).success,
    ).toBe(false);
    expect(createDealInput.safeParse({ ...newDeal, primaryContactId: null }).success).toBe(false);
  });
});

describe("a deal's owner and followers", () => {
  it("take the contact page's inputs, with the deal's id", () => {
    const membership = toPublicId('membership', uuid(4));
    expect(assignDealOwnerCommandInput.parse({ id: dealId, owner: 'me' }).owner).toBe('me');
    expect(
      assignDealOwnerCommandInput.parse({ id: dealId, owner: null, revision }).owner,
    ).toBeNull();
    expect(assignDealOwnerCommandInput.safeParse({ id: contact(1), owner: 'me' }).success).toBe(
      false,
    );
    expect(
      dealFollowersCommandInput.parse({ id: dealId, followers: ['me', membership] }).followers,
    ).toHaveLength(2);
    expect(dealFollowersCommandInput.safeParse({ id: dealId, followers: [] }).success).toBe(false);
  });
});

describe('what is answered', () => {
  const person = {
    membershipId: toPublicId('membership', uuid(4)),
    name: 'Dana Brooks',
    you: true,
  };
  const linked = { id: contact(1), name: 'Maya', email: null, phone: null, trashed: false };

  it('is the details of a deal, and a deal list row with only the extras it was asked for', () => {
    expect(
      dealDetails.parse({
        id: dealId,
        owner: person,
        ownerRevision: revision,
        followers: [person],
        primaryContact: linked,
        additionalContacts: [],
        contactsRevision: revision,
        createdBy: { kind: 'user', name: 'Dana Brooks', you: true },
        createdAt: '2026-10-11T00:00:00.000Z',
        canManage: true,
        canReadAudit: false,
      }).primaryContact?.name,
    ).toBe('Maya');
    // A deal as it always was still parses, and so does one with every extra.
    expect(deal.parse(shown)).not.toHaveProperty('owner');
    expect(deal.parse({ ...shown, primaryContact: null, owner: person, tags: [] })).toMatchObject({
      primaryContact: null,
      owner: person,
      tags: [],
    });
    expect(
      contactDeals.parse({ items: [{ deal: shown, primary: true }], more: false, canManage: true })
        .items,
    ).toHaveLength(1);
  });

  it('names the extras of a list by a comma-separated include, each once, in a fixed order', () => {
    expect(dealListQuery.parse({ include: 'tags,contact' }).include).toBe('tags,contact');
    expect(dealListExtrasOf('tags,contact,tags')).toEqual(['contact', 'tags']);
    expect(dealListExtrasOf(undefined)).toEqual([]);
    expect(dealListQuery.safeParse({ include: 'contact,notes' }).success).toBe(false);
    expect(dealListQuery.safeParse({ include: '' }).success).toBe(false);
    expect(contactDealsQuery.parse({})).toEqual({ status: 'all' });
    expect(contactDealsQuery.safeParse({ status: 'abandoned' }).success).toBe(false);
  });

  it('is registered: six operations, each once', () => {
    const registered = endpoints.map((endpoint) => endpoint.operationId);
    for (const endpoint of dealPeopleEndpoints)
      expect(registered.filter((id) => id === endpoint.operationId)).toHaveLength(1);
    expect(dealPeopleEndpoints).toHaveLength(6);
  });
});

describe('the deal list', () => {
  it('runs in one of four built-in orders, each both ways, or by a field, never both', () => {
    expect(dealListQuery.parse({})).not.toHaveProperty('sort');
    expect(dealListQuery.parse({ sort: 'value', direction: 'asc' })).toMatchObject({
      sort: 'value',
      direction: 'asc',
    });
    expect(dealSortDirection('name')).toBe('asc');
    expect(dealSortDirection('created')).toBe('desc');
    expect(dealSortDirection('value', 'asc')).toBe('asc');
    const sortField = toPublicId('field', uuid(5));
    expect(dealListQuery.safeParse({ sort: 'name', sortField }).success).toBe(false);
    expect(dealListQuery.safeParse({ sort: 'created', sortField }).success).toBe(true);
    expect(dealListQuery.safeParse({ sort: 'stage' }).success).toBe(false);
    expect(dealListQuery.safeParse({ direction: 'up' }).success).toBe(false);
  });

  it('takes a search of at most 200 characters, trimmed, for the list and for the board', () => {
    const pipelineId = toPublicId('pipeline', uuid(2));
    expect(dealListQuery.parse({ q: '  fence ' }).q).toBe('fence');
    expect(dealListQuery.safeParse({ q: 'x'.repeat(201) }).success).toBe(false);
    expect(dealStageSummaryQuery.parse({ pipelineId, q: 'fence' }).q).toBe('fence');
    expect(dealStageSummaryQuery.safeParse({ pipelineId, sort: 'name' }).success).toBe(false);
  });

  it('is saved with its order and its table columns, the name first and each once', () => {
    expect(dealViewState.parse({ sort: 'updated', direction: 'asc' })).toEqual({
      sort: 'updated',
      direction: 'asc',
    });
    expect(dealViewState.safeParse({ direction: 'asc' }).success).toBe(false);
    expect(
      dealViewState.safeParse({ sort: 'name', sortField: toPublicId('field', uuid(5)) }).success,
    ).toBe(false);
    expect(dealTableColumns.parse([...dealTableColumnKeys])).toHaveLength(
      dealTableColumnKeys.length,
    );
    for (const wrong of [[], ['value', 'name'], ['name', 'value', 'value'], ['name', 'company']])
      expect(dealTableColumns.safeParse(wrong).success).toBe(false);
    const view = { objectKey: 'deal', name: 'Open', state: {}, columns: ['name'] };
    expect(
      createViewInput.parse({ ...view, tableColumns: ['name', 'created', 'updated', 'source'] }),
    ).toMatchObject({ tableColumns: ['name', 'created', 'updated', 'source'] });
    expect(createViewInput.parse(view)).not.toHaveProperty('tableColumns');
    const changes = { name: 'Open', state: {}, columns: ['name'], revision };
    expect(dealViewChanges.parse({ ...changes, tableColumns: null }).tableColumns).toBeNull();
    expect(dealViewChanges.parse(changes)).not.toHaveProperty('tableColumns');
  });
});

describe('pipeline settings', () => {
  const stage = { name: 'New lead', description: '', archived: false };
  const save = (pipeline: object) =>
    savePipelinesInput.safeParse({
      revision,
      items: [{ name: 'Sales', description: '', archived: false, stages: [stage], ...pipeline }],
    });

  it('are optional in a save, so the first shape of the API still saves, and are checked when sent', () => {
    expect(save({}).success).toBe(true);
    expect(
      save({
        dealProbability: true,
        colorStyle: 'tint',
        showInFunnel: false,
        showInPie: true,
        // What was read can be sent back: the date is ignored.
        updatedAt: '2026-10-11T00:00:00.000Z',
        stages: [{ ...stage, probability: 40, color: '#12b76a', showInFunnel: false }],
      }).success,
    ).toBe(true);
    expect(save({ stages: [{ ...stage, probability: null, color: null }] }).success).toBe(true);
    for (const wrong of [
      { colorStyle: 'rainbow' },
      { stages: [{ ...stage, probability: 101 }] },
      { stages: [{ ...stage, probability: -1 }] },
      { stages: [{ ...stage, probability: 0.5 }] },
      { stages: [{ ...stage, color: '#FFF' }] },
      { stages: [{ ...stage, showInPie: 'no' }] },
      { owner: 'me' },
    ])
      expect(save(wrong).success).toBe(false);
  });

  it('move, copy and delete one pipeline from the revision of the configuration', () => {
    const id = toPublicId('pipeline', uuid(2));
    expect(movePipelineCommandInput.parse({ id, position: 3, revision }).position).toBe(3);
    for (const position of [0, 101, 1.5, '2'])
      expect(movePipelineCommandInput.safeParse({ id, position, revision }).success).toBe(false);
    expect(movePipelineCommandInput.safeParse({ id, position: 1 }).success).toBe(false);
    expect(duplicatePipelineCommandInput.parse({ id, revision })).not.toHaveProperty('name');
    expect(duplicatePipelineCommandInput.parse({ id, revision, name: ' Copy ' }).name).toBe('Copy');
    expect(duplicatePipelineCommandInput.safeParse({ id, revision, name: '' }).success).toBe(false);
    expect(deletePipelineCommandInput.safeParse({ id }).success).toBe(false);
    expect(deletePipelineCommandInput.safeParse({ id: dealId, revision }).success).toBe(false);
  });

  it('take the three opportunity settings together, under their revision', () => {
    const values = {
      allowDifferentOwners: false,
      opportunityOwnerFollowsContact: true,
      contactOwnerFollowsOpportunity: false,
    };
    expect(updateOpportunitySettingsInput.parse({ ...values, revision })).toMatchObject(values);
    expect(updateOpportunitySettingsInput.safeParse(values).success).toBe(false);
    expect(
      updateOpportunitySettingsInput.safeParse({ allowDifferentOwners: true, revision }).success,
    ).toBe(false);
    expect(opportunitySettings.parse({ ...values, revision, canManage: true }).canManage).toBe(
      true,
    );
    const registered = endpoints.map((endpoint) => endpoint.operationId);
    for (const endpoint of pipelineSettingEndpoints)
      expect(registered.filter((each) => each === endpoint.operationId)).toHaveLength(1);
  });

  it('gives a deal a probability of its own, in whole percent, or none', () => {
    expect(createDealInput.parse({ ...newDeal, probability: 60 }).probability).toBe(60);
    expect(createDealInput.parse({ ...newDeal, probability: null }).probability).toBeNull();
    expect(createDealInput.parse(newDeal)).not.toHaveProperty('probability');
    for (const probability of [-1, 101, 59.5, '60'])
      expect(createDealInput.safeParse({ ...newDeal, probability }).success).toBe(false);
    expect(deal.parse({ ...shown, probability: 60 }).probability).toBe(60);
  });
});
