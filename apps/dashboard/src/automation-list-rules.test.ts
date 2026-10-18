import { describe, expect, it } from 'vitest';
import {
  copyName,
  folderChoices,
  folderPath,
  foldersIn,
  isNarrowed,
  listQuery,
  overviewOf,
} from './automation-list-rules';

const folders = [
  { id: 'afol_a', parentId: null, name: 'Leads' },
  { id: 'afol_b', parentId: 'afol_a', name: 'Weddings' },
  { id: 'afol_c', parentId: null, name: 'Archive' },
];

describe('folders in the list of workflows', () => {
  it('finds the path from the top level down to a folder', () => {
    expect(folderPath(folders, 'afol_b').map((folder) => folder.name)).toEqual([
      'Leads',
      'Weddings',
    ]);
    expect(folderPath(folders, undefined)).toEqual([]);
  });

  it('has no path to a folder that is not there, nor through one that is missing', () => {
    expect(folderPath(folders, 'afol_gone')).toEqual([]);
    expect(folderPath([{ id: 'afol_x', parentId: 'afol_gone', name: 'Orphan' }], 'afol_x')).toEqual(
      [],
    );
  });

  it('stops at the depth folders nest to, when the tree loops', () => {
    const loop = [
      { id: 'afol_1', parentId: 'afol_2', name: 'One' },
      { id: 'afol_2', parentId: 'afol_1', name: 'Two' },
    ];
    expect(folderPath(loop, 'afol_1')).toHaveLength(5);
  });

  it('lists the folders directly in a place', () => {
    expect(foldersIn(folders, undefined).map((folder) => folder.name)).toEqual([
      'Leads',
      'Archive',
    ]);
    expect(foldersIn(folders, 'afol_a').map((folder) => folder.name)).toEqual(['Weddings']);
  });

  it('names every folder by its whole path, in order, as a place to move to', () => {
    expect(folderChoices(folders)).toEqual([
      { id: 'afol_c', label: 'Archive' },
      { id: 'afol_a', label: 'Leads' },
      { id: 'afol_b', label: 'Leads / Weddings' },
    ]);
    expect(folderChoices([{ id: 'afol_x', parentId: 'afol_gone', name: 'Orphan' }])).toEqual([]);
  });
});

describe('what the list asks for', () => {
  const all = { deleted: false, folder: undefined, status: undefined, q: '' };

  it('is the top level alone when nothing narrows it', () => {
    expect(listQuery(all)).toEqual({ folder: 'root' });
    expect(isNarrowed(all)).toBe(false);
  });

  it('looks in every folder for a name or a status at the top level', () => {
    expect(listQuery({ ...all, q: ' quote ' })).toEqual({ q: 'quote' });
    expect(listQuery({ ...all, status: 'active' })).toEqual({ status: 'active' });
    expect(isNarrowed({ ...all, q: 'quote' })).toBe(true);
    expect(isNarrowed({ ...all, status: 'draft' })).toBe(true);
  });

  it('stays in a folder that is open', () => {
    expect(listQuery({ ...all, folder: 'afol_a' })).toEqual({ folder: 'afol_a' });
    expect(listQuery({ ...all, folder: 'afol_a', status: 'paused', q: 'x' })).toEqual({
      status: 'paused',
      folder: 'afol_a',
      q: 'x',
    });
  });

  it('asks for the Deleted list by its status, in no folder', () => {
    expect(listQuery({ ...all, deleted: true, folder: 'afol_a', status: 'active' })).toEqual({
      status: 'archived',
    });
    expect(listQuery({ ...all, deleted: true, q: 'old' })).toEqual({
      status: 'archived',
      q: 'old',
    });
  });
});

describe('the name of a copy', () => {
  it('marks the original name, and keeps to the longest a name may be', () => {
    expect(copyName('Welcome', '(copy)')).toBe('Welcome (copy)');
    const long = copyName('a'.repeat(119), '(copy)');
    expect(long).toHaveLength(120);
    expect(long.endsWith(' (copy)')).toBe(true);
  });
});

describe('the Overview numbers', () => {
  it('counts workflows, the published ones, and what they have enrolled', () => {
    expect(
      overviewOf([
        { status: 'active', totalEnrolled: 10, activeEnrolled: 2 },
        { status: 'paused', totalEnrolled: 5 },
        { status: 'draft' },
      ]),
    ).toEqual({ workflows: 3, published: 1, enrolled: 15, active: 2 });
    expect(overviewOf([])).toEqual({ workflows: 0, published: 0, enrolled: 0, active: 0 });
  });
});
