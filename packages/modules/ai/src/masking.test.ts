import { describe, expect, it } from 'vitest';
import { maskContactDetails } from './masking.js';

describe('contact privacy before sending a prompt', () => {
  it('masks phone numbers separated by whitespace instead of treating them as one long number', () => {
    expect(maskContactDetails('0712345678 0798765432')).toBe('[phone] [phone]');
  });
  it('hides email addresses and international and Kenyan local phone numbers', () => {
    expect(
      maskContactDetails(
        'Email jane.doe+crm@example.co.ke; call +254 712 345 678 or 0712-345-678.',
      ),
    ).toBe('Email [email]; call [phone] or [phone].');
  });
  it('preserves dates, short numbers and identifiers while masking formatted US phones', () => {
    expect(
      maskContactDetails(
        'Meeting 2026-10-09, invoice INV12345678, 42 seats. Call +1 (415) 555-0123.',
      ),
    ).toBe('Meeting 2026-10-09, invoice INV12345678, 42 seats. Call [phone].');
  });
  it('masks repeated addresses and contiguous phones without retaining original values', () => {
    expect(maskContactDetails('a@example.com / a@example.com / 254712345678 / 0201234567')).toBe(
      '[email] / [email] / [phone] / [phone]',
    );
  });
  it('is idempotent and leaves empty text and text without contact details intact', () => {
    expect(maskContactDetails('')).toBe('');
    expect(maskContactDetails('Draft a welcome message.')).toBe('Draft a welcome message.');
    expect(maskContactDetails('[email] [phone]')).toBe('[email] [phone]');
  });
});
