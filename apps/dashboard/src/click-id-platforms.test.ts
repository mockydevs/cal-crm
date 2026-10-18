import { clickIdNames } from '@repo/contracts';
import { expect, it } from 'vitest';
import {
  clickIdPlatforms,
  isClickIdPlatform,
  platformNames,
  platformsOf,
} from './click-id-platforms';

it('names each platform once, in a fixed order, whichever of its ids are held', () => {
  expect(platformsOf(['fbclid', 'wbraid', 'gclid', 'gbraid'])).toEqual(['google', 'meta']);
  expect(platformsOf(['ctwa_clid'])).toEqual(['meta']);
  expect(platformsOf(['li_fat_id', 'ttclid', 'msclkid'])).toEqual([
    'microsoft',
    'tiktok',
    'linkedin',
  ]);
  expect(platformsOf([])).toEqual([]);
});

it('has a platform for every click id the contract names', () => {
  expect(platformsOf(clickIdNames)).toEqual([...clickIdPlatforms]);
});

it('keeps a name it does not know as it is, once, after the ones it knows', () => {
  expect(platformsOf(['newclid', 'gclid', 'newclid', 'toString'])).toEqual([
    'google',
    'newclid',
    'toString',
  ]);
});

it('has a name for every platform, and tells a platform from another name', () => {
  for (const platform of clickIdPlatforms) expect(platformNames[platform].message).toBeTruthy();
  expect(isClickIdPlatform('meta')).toBe(true);
  expect(isClickIdPlatform('newclid')).toBe(false);
});
