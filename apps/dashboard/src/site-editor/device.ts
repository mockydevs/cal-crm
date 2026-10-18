// What a node looks like on each device: `style` is the desktop's, `responsive` holds what
// a tablet and a phone change, and `hidden` says where the node is not shown. The canvas
// library stores no value per device, so these few functions are the whole of "per-device
// editing": the fields read and write a node's `look` through them, and the canvas draws
// the same look with the published page's own stylesheet rules (node-css.ts).
import type { PageStyle } from '@repo/contracts';
import { BREAKPOINTS } from '@repo/site-render';
import { PREVIEW_WIDTHS } from '../site-publish-rules';

export type Device = 'desktop' | 'tablet' | 'mobile';
export const DEVICES: readonly Device[] = ['desktop', 'tablet', 'mobile'];

/** The widths the canvas is drawn at: one inside each device's range of the published page. */
export const DEVICE_WIDTH: Readonly<Record<Device, number>> = PREVIEW_WIDTHS;
/**
 * The widest screen that still counts as each narrower device: the published page's own
 * breakpoints (packages/site-render), so the canvas and the page give way at the same widths.
 */
export const DEVICE_MAX_WIDTH = BREAKPOINTS;

/** A node's `look`, as document-map.ts keeps it among the canvas's props. */
export interface Look {
  readonly style?: PageStyle;
  readonly responsive?: { readonly tablet?: PageStyle; readonly mobile?: PageStyle };
  readonly hidden?: Partial<Record<Device, boolean>>;
  readonly customClass?: string;
}

/** The device a preview of this width stands for. */
export function deviceForWidth(width: number | '100%'): Device {
  if (width === '100%' || width > DEVICE_MAX_WIDTH.tablet) return 'desktop';
  return width > DEVICE_MAX_WIDTH.mobile ? 'tablet' : 'mobile';
}

/** What the node looks like on a device: the desktop's style under that device's changes. */
export function styleOn(look: Look, device: Device): PageStyle {
  const base = look.style ?? {};
  if (device === 'desktop') return base;
  const tablet = { ...base, ...look.responsive?.tablet };
  return device === 'tablet' ? tablet : { ...tablet, ...look.responsive?.mobile };
}

/** Whether a value was set for this very device, and not handed down from a wider one. */
export function isOwnValue(look: Look, device: Device, key: keyof PageStyle): boolean {
  const own = device === 'desktop' ? look.style : look.responsive?.[device];
  return own !== undefined && key in own;
}

function without<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value };
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a copy, and the key is one of the type's own
  delete copy[key];
  return copy;
}

/**
 * The look with one property set for one device, or cleared when `value` is undefined.
 * Nothing empty is left behind: a device with no changes loses its entry, so a page that
 * is edited and put back is the page it was.
 */
export function setStyle<Key extends keyof PageStyle>(
  look: Look,
  device: Device,
  key: Key,
  value: PageStyle[Key] | undefined,
): Look {
  const change = (style: PageStyle | undefined): PageStyle | undefined => {
    const next = value === undefined ? without(style ?? {}, key) : { ...style, [key]: value };
    return Object.keys(next).length === 0 ? undefined : next;
  };
  if (device === 'desktop') {
    const style = change(look.style);
    return style === undefined ? without(look, 'style') : { ...look, style };
  }
  const changed = change(look.responsive?.[device]);
  const responsive =
    changed === undefined
      ? without(look.responsive ?? {}, device)
      : { ...look.responsive, [device]: changed };
  return Object.keys(responsive).length === 0
    ? without(look, 'responsive')
    : { ...look, responsive };
}

/** The look with the node hidden, or shown again, on one device. */
export function setHidden(look: Look, device: Device, hide: boolean): Look {
  const hidden = hide ? { ...look.hidden, [device]: true } : without(look.hidden ?? {}, device);
  return Object.keys(hidden).length === 0 ? without(look, 'hidden') : { ...look, hidden };
}
