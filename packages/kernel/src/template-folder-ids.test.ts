import { describe, expect, it } from 'vitest';

import { parsePublicId, toPublicId } from './ids.js';

describe('message template folder identity', () => {
  it('preserves a distinct permanent prefix and UUIDv7', () => {
    const uuid = '01890a5d-ac96-774b-bcce-b302099a8057';
    expect(toPublicId('template_folder', uuid)).toBe('tfld_01h455vb4pex5vsknk084sn02q');
    expect(parsePublicId('template_folder', 'tfld_01h455vb4pex5vsknk084sn02q')).toBe(uuid);
    expect(parsePublicId('template', 'tfld_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('template_folder', 'tmpl_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
    expect(parsePublicId('template_folder', 'afol_01h455vb4pex5vsknk084sn02q')).toBeUndefined();
  });
});
