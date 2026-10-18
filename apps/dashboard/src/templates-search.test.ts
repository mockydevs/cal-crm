import { describe, expect, it } from 'vitest';
import { templatesSearchOf } from './templates-search';

const folder = 'tfld_01h455vb4pex5vsknk084sn02q';

describe('templatesSearchOf', () => {
  it('keeps nothing for the whole library, newest view defaults left out', () => {
    expect(templatesSearchOf({})).toEqual({});
    expect(templatesSearchOf({ sort: 'name', layout: 'list', q: '  ' })).toEqual({});
  });

  it('keeps each choice the page offers', () => {
    expect(
      templatesSearchOf({
        folder,
        q: ' welcome ',
        type: 'html',
        used: 'no',
        sort: 'uses',
        layout: 'grid',
      }),
    ).toEqual({ folder, q: 'welcome', type: 'html', used: 'no', sort: 'uses', layout: 'grid' });
  });

  it('keeps the templates in no folder', () => {
    expect(templatesSearchOf({ folder: 'root', q: 'x' })).toEqual({ folder: 'root', q: 'x' });
    expect(templatesSearchOf({ show: 'trash', folder: 'root' })).toEqual({ show: 'trash' });
  });

  it('shows Archived or Trash instead of a folder', () => {
    expect(templatesSearchOf({ show: 'trash', folder })).toEqual({ show: 'trash' });
    expect(templatesSearchOf({ show: 'archived' })).toEqual({ show: 'archived' });
  });

  it('drops what it does not know', () => {
    expect(
      templatesSearchOf({
        folder: 'tmpl_01h455vb4pex5vsknk084sn02q',
        show: 'everything',
        type: 'pdf',
        used: 1,
        sort: 'size',
        layout: 'cards',
        q: 'x'.repeat(300),
      }),
    ).toEqual({ q: 'x'.repeat(120) });
  });
});
