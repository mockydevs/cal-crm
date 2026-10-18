import { expect, it } from 'vitest';
import { formsSearch } from './forms-search';

it('keeps the open form when the address names one', () => {
  const form = 'form_01k8e2wzr0e008000000000001';
  expect(formsSearch({ form })).toEqual({ form });
});

it('drops anything that is not the id of a form', () => {
  expect(formsSearch({})).toEqual({});
  expect(formsSearch({ form: 'new' })).toEqual({});
  expect(formsSearch({ form: 7 })).toEqual({});
  expect(formsSearch({ form: 'con_01k8e2wzr0e008000000000001' })).toEqual({});
});
