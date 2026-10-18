// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { pageAction, pageStyle } from '@repo/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AddressBox,
  ColorBox,
  EdgesBox,
  isLinkAddress,
  isMediaAddress,
  LengthBox,
  NumberBox,
  SwitchRow,
  TextBox,
} from './field-parts';

beforeAll(() => {
  i18n.loadAndActivate({ locale: 'en', messages: {} });
});
afterEach(cleanup);

const show = (view: ReactElement): void => {
  render(<I18nProvider i18n={i18n}>{view}</I18nProvider>);
};
const type = (name: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(name), { target: { value } });
};

describe('AddressBox', () => {
  it('hands on an address the page document takes, and keeps anything else in the box', () => {
    const onChange = vi.fn();
    show(<AddressBox label="Image address" kind="media" value={null} onChange={onChange} />);
    type('Image address', 'http://example.com/a.png');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Image address')).toHaveProperty(
      'value',
      'http://example.com/a.png',
    );
    expect(screen.getByText(/Use a secure web address starting with https/)).toBeDefined();
    type('Image address', ' https://example.com/a.png ');
    expect(onChange).toHaveBeenLastCalledWith('https://example.com/a.png');
    expect(screen.queryByText(/Use a secure web address/)).toBeNull();
    cleanup();
    show(<AddressBox label="Image address" kind="media" value="/a.png" onChange={onChange} />);
    type('Image address', '');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it('says what a link may be', () => {
    const onChange = vi.fn();
    show(<AddressBox label="Address" kind="link" value="/thanks" onChange={onChange} />);
    type('Address', 'javascript:alert(1)');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Use a web address, a mailto: or tel: address/)).toBeDefined();
    type('Address', 'mailto:dana@example.com');
    expect(onChange).toHaveBeenLastCalledWith('mailto:dana@example.com');
  });

  it('agrees with the contract about every address', () => {
    const media = pageStyle.shape.backgroundImageUrl;
    const link = (href: string): boolean =>
      pageAction.safeParse({ type: 'url', href, newTab: false }).success;
    for (const text of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      '/picture.png',
      '//example.com/a.png',
      '{{contact.photo}}',
      '{{Contact}}',
      'https://example.com/a b.png',
      'https://example.com/"x',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'mailto:a@example.com',
      'tel:+254700000000',
      '#top',
      'ftp://example.com',
      `https://example.com/${'a'.repeat(2000)}`,
    ]) {
      expect(isMediaAddress(text), text).toBe(media.safeParse(text).success);
      expect(isLinkAddress(text), text).toBe(link(text));
    }
  });
});

describe('ColorBox', () => {
  it('takes a hex colour or transparent, and nothing else', () => {
    const onChange = vi.fn();
    show(<ColorBox label="Text colour" value="#1f2937" onChange={onChange} />);
    type('Text colour', 'red');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Use a hex colour such as #1f2937, or transparent.')).toBeDefined();
    type('Text colour', '#0f0');
    expect(onChange).toHaveBeenLastCalledWith('#0f0');
    type('Text colour', 'transparent');
    expect(onChange).toHaveBeenLastCalledWith('transparent');
    type('Text colour', '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    type('Text colour: pick a colour', '#ff0000');
    expect(onChange).toHaveBeenLastCalledWith('#ff0000');
  });

  it('shows the browser’s picker a colour it can show', () => {
    const picker = (value: string | undefined): unknown => {
      cleanup();
      show(<ColorBox label="C" value={value} onChange={() => undefined} />);
      return screen.getByLabelText('C: pick a colour').getAttribute('value');
    };
    expect(picker('#0F0')).toBe('#00ff00');
    expect(picker('#0f08')).toBe('#00ff00');
    expect(picker('#11223344')).toBe('#112233');
    expect(picker('transparent')).toBe('#000000');
    expect(picker(undefined)).toBe('#000000');
  });
});

describe('NumberBox', () => {
  it('hands on a number within bounds, and "not set" for an empty box', () => {
    const onChange = vi.fn();
    show(<NumberBox label="Text size (px)" value={16} min={1} max={400} onChange={onChange} />);
    type('Text size (px)', '500');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Use a number from 1 to 400.')).toBeDefined();
    type('Text size (px)', '22');
    expect(onChange).toHaveBeenLastCalledWith(22);
    type('Text size (px)', '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('never hands on "not set" for a number that must be there', () => {
    const onChange = vi.fn();
    show(
      <NumberBox label="Thickness (px)" value={2} min={1} max={50} required onChange={onChange} />,
    );
    type('Thickness (px)', '');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(screen.getByLabelText('Thickness (px)'));
    expect(screen.getByLabelText('Thickness (px)')).toHaveProperty('value', '2');
  });
});

describe('TextBox', () => {
  it('keeps in the box what the page document would not take, and says why', () => {
    const onChange = vi.fn();
    show(
      <TextBox
        label="Label"
        value="Go"
        onChange={onChange}
        accepts={(text) => text !== ''}
        refusal="A button needs a label."
      />,
    );
    type('Label', '');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('A button needs a label.')).toBeDefined();
    type('Label', 'Go on');
    expect(onChange).toHaveBeenLastCalledWith('Go on');
    expect(screen.queryByText('A button needs a label.')).toBeNull();
  });

  it('hands on everything when nothing is refused, on one line or several', () => {
    const onChange = vi.fn();
    show(<TextBox label="Second line" value="" onChange={onChange} hint="Shown smaller." />);
    type('Second line', 'x');
    expect(onChange).toHaveBeenLastCalledWith('x');
    expect(screen.getByText('Shown smaller.')).toBeDefined();
    cleanup();
    show(<TextBox label="CSS" value="" multiline mono onChange={onChange} />);
    type('CSS', 'a{}');
    expect(onChange).toHaveBeenLastCalledWith('a{}');
    expect(screen.getByLabelText('CSS').tagName).toBe('TEXTAREA');
  });
});

describe('EdgesBox and LengthBox', () => {
  it('sets one side and leaves the others; all unset is "not set"', () => {
    const onChange = vi.fn();
    show(<EdgesBox label="Padding (px)" value={{ top: 8 }} min={0} onChange={onChange} />);
    type('Padding (px), Left', '12');
    expect(onChange).toHaveBeenLastCalledWith({ top: 8, left: 12 });
    type('Padding (px), Left', '-5');
    expect(onChange).toHaveBeenLastCalledWith({ top: 8, left: 0 });
    type('Padding (px), Top', '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('gives a length its unit, and nothing for an empty amount', () => {
    const onChange = vi.fn();
    show(<LengthBox label="Width" value={undefined} onChange={onChange} />);
    type('Width, amount', '50');
    expect(onChange).toHaveBeenLastCalledWith({ value: 50, unit: 'px' });
    cleanup();
    show(<LengthBox label="Width" value={{ value: 50, unit: '%' }} onChange={onChange} />);
    type('Width, amount', '20000');
    expect(onChange).toHaveBeenLastCalledWith({ value: 10_000, unit: '%' });
    type('Width, amount', '');
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});

describe('SwitchRow', () => {
  it('is a switch named by its label', () => {
    const onChange = vi.fn();
    show(<SwitchRow label="Open in a new tab" checked={false} onChange={onChange} hint="Hint." />);
    fireEvent.click(screen.getByRole('switch', { name: 'Open in a new tab' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
