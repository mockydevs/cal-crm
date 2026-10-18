import {
  contactColumnLayout,
  contactColumnWidths,
  contactTableColumnKeys,
  contactViewColumnKeys,
  dealTableColumnKeys,
  dealTableColumns,
  MAX_COLUMN_WIDTH as maximum,
  MAX_CONTACT_LAYOUT_COLUMNS,
  MIN_COLUMN_WIDTH as minimum,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import {
  columnWidthsOf,
  contactColumnKeys,
  contactColumnsOf,
  dealColumnKeys,
  dealColumnsOf,
  firstTableColumnKeys,
  newListColumns,
  MAX_COLUMN_WIDTH,
  MAX_COLUMN_WIDTHS,
  MIN_COLUMN_WIDTH,
  widthsShown,
} from './list-columns';

describe('the columns written again for the routes', () => {
  it('are the contract columns, in the contract order', () => {
    expect(contactColumnKeys).toEqual(contactTableColumnKeys);
    expect(dealColumnKeys).toEqual(dealTableColumnKeys);
    expect(firstTableColumnKeys).toEqual(contactViewColumnKeys);
  });

  it('show a new list every built-in column but Email verification, which Manage fields adds', () => {
    expect(newListColumns).toEqual(
      contactTableColumnKeys.filter((key) => key !== 'emailVerification'),
    );
    expect(contactColumnsOf(['name', 'emailVerification'])).toEqual(['name', 'emailVerification']);
  });

  it('take the opportunity columns the contract takes, and refuse the ones it refuses', () => {
    for (const value of [
      ['name'],
      ['name', 'stage', 'value'],
      [...dealTableColumnKeys],
      ['name', 'name'],
      ['name', 'smartTags'],
      'name',
      undefined,
      [1],
    ]) {
      const parsed = dealTableColumns.safeParse(value);
      expect(dealColumnsOf(value)).toEqual(parsed.success ? parsed.data : undefined);
    }
  });

  it('take the contact columns and widths the contract takes', () => {
    const field = 'fld_01h455vb4pex5vsknk084sn02q';
    for (const value of [
      ['name', 'email', field],
      ['name', field, field],
      ['name', 'fld_nope'],
      ['name', 'shoeSize'],
      'name',
    ]) {
      const parsed = contactColumnLayout.safeParse(value);
      expect(contactColumnsOf(value)).toEqual(parsed.success ? parsed.data : undefined);
    }
    expect(contactColumnsOf([field, 'name'])).toEqual(['name', field]);
    expect(MIN_COLUMN_WIDTH).toBe(minimum);
    expect(MAX_COLUMN_WIDTH).toBe(maximum);
    for (const value of [{ name: 200, [field]: minimum }, { name: maximum }]) {
      expect(contactColumnWidths.safeParse(value).success).toBe(true);
      expect(columnWidthsOf(value)).toEqual(value);
    }
    // A width the contract refuses is left out, so an old address still opens.
    expect(columnWidthsOf({ name: minimum - 1, email: 200, shoeSize: 200, tags: 1.5 })).toEqual({
      email: 200,
    });
    expect(columnWidthsOf([200])).toBeUndefined();
  });

  it('keep at most as many widths as the contract, and only those of the columns shown', () => {
    expect(MAX_COLUMN_WIDTHS).toBe(MAX_CONTACT_LAYOUT_COLUMNS);
    const many = Object.fromEntries(
      Array.from({ length: MAX_COLUMN_WIDTHS + 5 }, (_, n) => [
        `fld_01h455vb4pex5vsknk084sn${String(n + 10)
          .padStart(3, '0')
          .slice(-3)}`,
        120,
      ]),
    );
    const kept = columnWidthsOf(many);
    expect(Object.keys(kept ?? {})).toHaveLength(MAX_COLUMN_WIDTHS);
    expect(contactColumnWidths.safeParse(kept).success).toBe(true);
    expect(widthsShown({ name: 200, email: 150, tags: 90 }, ['name', 'email'])).toEqual({
      name: 200,
      email: 150,
    });
    expect(widthsShown({ tags: 90 }, ['name'])).toBeUndefined();
    expect(widthsShown(undefined, ['name'])).toBeUndefined();
  });

  it('put the name first, and still read what the first table called the value and status', () => {
    expect(dealColumnsOf(['stage', 'name', 'owner'])).toEqual(['name', 'stage', 'owner']);
    expect(dealColumnsOf(['tags'])).toEqual(['name', 'tags']);
    expect(dealColumnsOf(['name', 'amount', 'outcome'])).toEqual(['name', 'value', 'status']);
    expect(dealColumnsOf(['amount', 'value'])).toBeUndefined();
  });
});
