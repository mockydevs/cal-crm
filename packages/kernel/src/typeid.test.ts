import { describe, expect, it } from 'vitest';

import { decodeTypeId, encodeTypeId } from './index.js';

// Test vectors from the TypeID spec, version 0.3.0: spec/valid.json and spec/invalid.json
// in https://github.com/jetify-com/typeid (Apache-2.0).
const valid = [
  {
    typeid: '00000000000000000000000000',
    prefix: '',
    uuid: '00000000-0000-0000-0000-000000000000',
  },
  {
    typeid: '00000000000000000000000001',
    prefix: '',
    uuid: '00000000-0000-0000-0000-000000000001',
  },
  {
    typeid: '0000000000000000000000000a',
    prefix: '',
    uuid: '00000000-0000-0000-0000-00000000000a',
  },
  {
    typeid: '0000000000000000000000000g',
    prefix: '',
    uuid: '00000000-0000-0000-0000-000000000010',
  },
  {
    typeid: '00000000000000000000000010',
    prefix: '',
    uuid: '00000000-0000-0000-0000-000000000020',
  },
  {
    typeid: '7zzzzzzzzzzzzzzzzzzzzzzzzz',
    prefix: '',
    uuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  },
  {
    typeid: 'prefix_0123456789abcdefghjkmnpqrs',
    prefix: 'prefix',
    uuid: '0110c853-1d09-52d8-d73e-1194e95b5f19',
  },
  {
    typeid: 'prefix_01h455vb4pex5vsknk084sn02q',
    prefix: 'prefix',
    uuid: '01890a5d-ac96-774b-bcce-b302099a8057',
  },
  {
    typeid: 'pre_fix_00000000000000000000000000',
    prefix: 'pre_fix',
    uuid: '00000000-0000-0000-0000-000000000000',
  },
];

const invalid = [
  ['prefix-uppercase', 'PREFIX_00000000000000000000000000'],
  ['prefix-numeric', '12345_00000000000000000000000000'],
  ['prefix-period', 'pre.fix_00000000000000000000000000'],
  ['prefix-non-ascii', 'préfix_00000000000000000000000000'],
  ['prefix-spaces', '  prefix_00000000000000000000000000'],
  [
    'prefix-64-chars',
    'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijkl_00000000000000000000000000',
  ],
  ['separator-empty-prefix', '_00000000000000000000000000'],
  ['separator-empty', '_'],
  ['suffix-short', 'prefix_1234567890123456789012345'],
  ['suffix-long', 'prefix_123456789012345678901234567'],
  ['suffix-spaces', 'prefix_1234567890123456789012345 '],
  ['suffix-uppercase', 'prefix_0123456789ABCDEFGHJKMNPQRS'],
  ['suffix-hyphens', 'prefix_123456789-123456789-123456'],
  ['suffix-wrong-alphabet', 'prefix_ooooooiiiiiiuuuuuuulllllll'],
  ['suffix-ambiguous-crockford', 'prefix_i23456789ol23456789oi23456'],
  ['suffix-hyphens-crockford', 'prefix_123456789-0123456789-0123456'],
  ['suffix-overflow', 'prefix_8zzzzzzzzzzzzzzzzzzzzzzzzz'],
  ['prefix-underscore-start', '_prefix_00000000000000000000000000'],
  ['prefix-underscore-end', 'prefix__00000000000000000000000000'],
  ['empty', ''],
  ['prefix-empty', 'prefix_'],
];

describe('TypeID', () => {
  it.each(valid)('encodes $uuid with prefix "$prefix" as $typeid', ({ typeid, prefix, uuid }) => {
    expect(encodeTypeId(prefix, uuid)).toBe(typeid);
  });

  it.each(valid)('decodes $typeid', ({ typeid, prefix, uuid }) => {
    expect(decodeTypeId(typeid)).toEqual({ prefix, uuid });
  });

  it.each(invalid)('rejects %s: %j', (_name, typeid) => {
    expect(decodeTypeId(typeid)).toBeUndefined();
  });

  it('refuses to encode a prefix the spec forbids, or something that is not a UUID', () => {
    expect(() => encodeTypeId('Contact', '01890a5d-ac96-774b-bcce-b302099a8057')).toThrow(
      TypeError,
    );
    expect(() => encodeTypeId('contact', '01890a5dac96774bbccb302099a8057')).toThrow(TypeError);
  });
});
