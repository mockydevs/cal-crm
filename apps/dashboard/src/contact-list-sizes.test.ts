import {
  CONTACT_COUNT_LIMIT as countLimit,
  CONTACT_PAGE_SIZE as pageSize,
  contactListExtras as extras,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { CONTACT_COUNT_LIMIT, CONTACT_PAGE_SIZE, contactListExtras } from './contact-list-sizes';

describe('the contact list sizes written again for its page', () => {
  it('are the contract’s, extras in the contract’s order', () => {
    expect(CONTACT_PAGE_SIZE).toBe(pageSize);
    expect(CONTACT_COUNT_LIMIT).toBe(countLimit);
    expect(contactListExtras).toEqual(extras);
  });
});
