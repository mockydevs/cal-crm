import { contrastRatio, MIN_CONTRAST } from '@repo/ui/lib/brand';
import { describe, expect, it } from 'vitest';
import { bookingLook, bookingTheme, flatten, inkOn, readableOn } from './public-booking-theme';

const appearance = {
  style: 'neo' as const,
  primaryColor: '#178af6',
  backgroundColor: '#ffffff',
  buttonText: '',
  logoUrl: null,
  coverUrl: null,
};

/** Every pair of words and what they sit on that the widget draws. */
const textPairs = (theme: Record<string, string>): [string, string, string][] => {
  const token = (name: string): string => {
    const value = theme[name];
    if (value === undefined) throw new Error(`No ${name}`);
    return value;
  };
  return [
    ['ink', token('--ink'), token('--surface')],
    ['body', token('--body'), token('--surface')],
    ['muted', token('--muted'), token('--surface')],
    ['danger', token('--danger'), token('--surface')],
    ['link', token('--accent-text'), token('--surface')],
    ['button', token('--accent-ink'), token('--accent')],
    ['button hovered', token('--accent-ink'), token('--accent-hover')],
  ];
};

describe('the booking widget’s colours', () => {
  it('lays a see-through colour over what is under it', () => {
    expect(flatten('#178af6', '#ffffff')).toBe('#178AF6');
    expect(flatten('#00000080', '#ffffff')).toBe('#7F7F7F');
    expect(flatten('#ff000000', '#ffffff')).toBe('#FFFFFF');
  });

  it('writes on a fill in ink, white or black, whichever reads at 4.5:1', () => {
    expect(inkOn('#FFFFFF')).toBe('#101828');
    expect(inkOn('#101828')).toBe('#FFFFFF');
    // A middle grey where neither white nor the ink reaches 4.5:1, and black does.
    expect(contrastRatio('#FFFFFF', '#777777')).toBeLessThan(MIN_CONTRAST);
    expect(contrastRatio('#101828', '#777777')).toBeLessThan(MIN_CONTRAST);
    expect(inkOn('#777777')).toBe('#000000');
  });

  it('keeps a readable colour as it is, and moves an unreadable one only as far as needed', () => {
    expect(readableOn('#004EEB', '#FFFFFF')).toBe('#004EEB');
    const moved = readableOn('#FFE14D', '#FFFFFF');
    expect(moved).not.toBe('#FFE14D');
    expect(contrastRatio(moved, '#FFFFFF')).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it.each([
    ['#178af6', '#ffffff'],
    ['#ffe14d', '#ffffff'],
    ['#ffffff', '#ffffff'],
    ['#000000', '#000000'],
    ['#777777', '#101828'],
    ['#ff00ff', '#00ffff'],
    ['#178af680', '#10182840'],
    ['#00000000', '#00000000'],
  ])('keeps every word readable with primary %s on background %s', (primary, background) => {
    for (const [name, text, ground] of textPairs(bookingTheme(primary, background)))
      expect(contrastRatio(text, ground), name).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it('keeps the owner’s colours where they already read', () => {
    const theme = bookingTheme('#004eeb', '#ffffff');
    expect(theme['--surface']).toBe('#FFFFFF');
    expect(theme['--accent']).toBe('#004EEB');
    expect(theme['--accent-ink']).toBe('#FFFFFF');
    expect(theme['--accent-text']).toBe('#004EEB');
    // A dark background turns the words light.
    expect(bookingTheme('#004eeb', '#101828')['--ink']).toBe('#FFFFFF');
  });

  it('draws colours and the button’s words for Neo only, as GoHighLevel does', () => {
    expect(bookingLook({ ...appearance, buttonText: '  Book my tour ' })).toEqual({
      theme: bookingTheme('#178af6', '#ffffff'),
      scheme: 'light',
      buttonText: 'Book my tour',
    });
    expect(bookingLook(appearance).buttonText).toBeUndefined();
    expect(bookingLook({ ...appearance, backgroundColor: '#101828' }).scheme).toBe('dark');
    expect(
      bookingLook({
        ...appearance,
        style: 'classic',
        backgroundColor: '#101828',
        buttonText: 'Book my tour',
      }),
    ).toEqual({ theme: undefined, scheme: 'light', buttonText: undefined });
  });
});
