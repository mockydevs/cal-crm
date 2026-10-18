import { describe, expect, it } from 'vitest';
import { deviceForWidth, isOwnValue, setHidden, setStyle, styleOn, type Look } from './device';

const look: Look = {
  style: { fontSize: 48, textColor: '#111111' },
  responsive: { tablet: { fontSize: 36 }, mobile: { textColor: '#222222' } },
};

describe('deviceForWidth', () => {
  it.each([
    ['100%', 'desktop'],
    [1280, 'desktop'],
    [1025, 'desktop'],
    [1024, 'tablet'],
    [768, 'tablet'],
    [641, 'tablet'],
    [640, 'mobile'],
    [360, 'mobile'],
  ] as const)('reads %s as %s', (width, device) => {
    expect(deviceForWidth(width)).toBe(device);
  });
});

describe('styleOn', () => {
  it('hands each narrower device what the wider ones set', () => {
    expect(styleOn(look, 'desktop')).toStrictEqual({ fontSize: 48, textColor: '#111111' });
    expect(styleOn(look, 'tablet')).toStrictEqual({ fontSize: 36, textColor: '#111111' });
    expect(styleOn(look, 'mobile')).toStrictEqual({ fontSize: 36, textColor: '#222222' });
    expect(styleOn({}, 'mobile')).toStrictEqual({});
    expect(styleOn({}, 'desktop')).toStrictEqual({});
  });

  it('tells a value set for a device from one handed down', () => {
    expect(isOwnValue(look, 'desktop', 'fontSize')).toBe(true);
    expect(isOwnValue(look, 'tablet', 'fontSize')).toBe(true);
    expect(isOwnValue(look, 'mobile', 'fontSize')).toBe(false);
    expect(isOwnValue({}, 'tablet', 'fontSize')).toBe(false);
    expect(isOwnValue({}, 'desktop', 'fontSize')).toBe(false);
  });
});

describe('setStyle', () => {
  it('writes the desktop’s value to style and a narrower one to responsive', () => {
    expect(setStyle({}, 'desktop', 'fontSize', 20)).toStrictEqual({ style: { fontSize: 20 } });
    expect(setStyle({}, 'mobile', 'fontSize', 14)).toStrictEqual({
      responsive: { mobile: { fontSize: 14 } },
    });
    expect(setStyle(look, 'tablet', 'textAlign', 'center')).toStrictEqual({
      ...look,
      responsive: { ...look.responsive, tablet: { fontSize: 36, textAlign: 'center' } },
    });
  });

  it('leaves nothing empty behind when a value is cleared', () => {
    const set = setStyle({ customClass: 'a' }, 'tablet', 'fontSize', 30);
    expect(setStyle(set, 'tablet', 'fontSize', undefined)).toStrictEqual({ customClass: 'a' });
    expect(setStyle({ style: { fontSize: 2 } }, 'desktop', 'fontSize', undefined)).toStrictEqual(
      {},
    );
    expect(setStyle(look, 'mobile', 'textColor', undefined)).toStrictEqual({
      style: look.style,
      responsive: { tablet: { fontSize: 36 } },
    });
    expect(setStyle({}, 'mobile', 'fontSize', undefined)).toStrictEqual({});
    expect(setStyle({}, 'desktop', 'fontSize', undefined)).toStrictEqual({});
  });

  it('puts a page back as it was: set then clear is the look it started from', () => {
    const edited = setStyle(
      setStyle(look, 'mobile', 'fontSize', 12),
      'mobile',
      'fontSize',
      undefined,
    );
    expect(edited).toStrictEqual(look);
  });

  it('does not change the look it was given', () => {
    const before = JSON.stringify(look);
    setStyle(look, 'tablet', 'fontSize', 1);
    setHidden(look, 'tablet', true);
    expect(JSON.stringify(look)).toBe(before);
  });
});

describe('setHidden', () => {
  it('hides on one device and shows again without leaving an empty entry', () => {
    const hidden = setHidden({}, 'mobile', true);
    expect(hidden).toStrictEqual({ hidden: { mobile: true } });
    expect(setHidden(hidden, 'tablet', true)).toStrictEqual({
      hidden: { mobile: true, tablet: true },
    });
    expect(setHidden(hidden, 'mobile', false)).toStrictEqual({});
    expect(setHidden({}, 'desktop', false)).toStrictEqual({});
    expect(setHidden({ hidden: { mobile: true, tablet: true } }, 'tablet', false)).toStrictEqual({
      hidden: { mobile: true },
    });
  });
});
