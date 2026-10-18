// Whose click ids a touch or a link holds, by the platform's name. A click id is what an ad
// platform adds to a link to recognise the click (gclid, fbclid…); the dashboard says which
// platforms' ids are held and never shows an id itself.
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ClickIdName } from '@repo/contracts';

export const clickIdPlatforms = ['google', 'meta', 'microsoft', 'tiktok', 'linkedin'] as const;
export type ClickIdPlatform = (typeof clickIdPlatforms)[number];

const platformOf: Readonly<Record<ClickIdName, ClickIdPlatform>> = {
  gclid: 'google',
  gbraid: 'google',
  wbraid: 'google',
  fbclid: 'meta',
  ctwa_clid: 'meta',
  msclkid: 'microsoft',
  ttclid: 'tiktok',
  li_fat_id: 'linkedin',
};

/**
 * The platforms whose click ids are held, each once, in a fixed order. A name this
 * dashboard does not know yet is kept as it is, after them: it is a name, never a value.
 */
export function platformsOf(names: readonly string[]): string[] {
  const known = new Set<string>();
  const others: string[] = [];
  for (const name of names) {
    const platform = Object.hasOwn(platformOf, name) ? platformOf[name as ClickIdName] : undefined;
    if (platform !== undefined) known.add(platform);
    else if (!others.includes(name)) others.push(name);
  }
  return [...clickIdPlatforms.filter((platform) => known.has(platform)), ...others];
}

/** The platforms' own names: the same in every language. */
export const platformNames: Readonly<Record<ClickIdPlatform, MessageDescriptor>> = {
  google: msg`Google`,
  meta: msg`Meta`,
  microsoft: msg`Microsoft`,
  tiktok: msg`TikTok`,
  linkedin: msg`LinkedIn`,
};

export const isClickIdPlatform = (key: string): key is ClickIdPlatform =>
  (clickIdPlatforms as readonly string[]).includes(key);
