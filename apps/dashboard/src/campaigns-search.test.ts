import { describe, expect, it } from 'vitest';
import { campaignsSearchOf } from './campaigns-search';

const folder = 'cfld_01h455vb4pex5vsknk084sn02q';

describe('campaignsSearchOf', () => {
  it('keeps nothing for every campaign', () => {
    expect(campaignsSearchOf({})).toEqual({});
    expect(campaignsSearchOf({ status: 'all', q: ' ' })).toEqual({});
  });

  it('keeps the folder, the status and the search', () => {
    expect(campaignsSearchOf({ folder, status: 'paused', q: ' spring ' })).toEqual({
      folder,
      status: 'paused',
      q: 'spring',
    });
  });

  it('keeps the campaigns in no folder', () => {
    expect(campaignsSearchOf({ folder: 'root', status: 'draft' })).toEqual({
      folder: 'root',
      status: 'draft',
    });
  });

  it('drops what it does not know', () => {
    expect(
      campaignsSearchOf({ folder: 'tfld_01h455vb4pex5vsknk084sn02q', status: 'archived' }),
    ).toEqual({});
  });
});
