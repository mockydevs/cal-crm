import { expect, it } from 'vitest';
import { folderDestinations, folderLabels } from './template-folder-rules';

it('distinguishes equal folder names under different parents using the full ancestry', () => {
  expect([
    ...folderLabels([
      { id: 'sales', parentId: null, name: 'Sales' },
      { id: 'support', parentId: null, name: 'Support' },
      { id: 'sales-guides', parentId: 'sales', name: 'Guides' },
      { id: 'support-guides', parentId: 'support', name: 'Guides' },
    ]),
  ]).toEqual([
    ['sales', 'Sales'],
    ['support', 'Support'],
    ['sales-guides', 'Sales / Guides'],
    ['support-guides', 'Support / Guides'],
  ]);
});

it('bounds ancestry labels for stale cycles and tolerates missing ancestors', () => {
  expect([
    ...folderLabels([
      { id: 'a', parentId: 'b', name: 'A' },
      { id: 'b', parentId: 'a', name: 'B' },
      { id: 'orphan', parentId: 'gone', name: 'Orphan' },
    ]),
  ]).toEqual([
    ['a', 'B / A'],
    ['b', 'A / B'],
    ['orphan', 'Orphan'],
  ]);
});

const tree = [
  { id: 'welcome', parentId: null },
  { id: 'guides', parentId: 'welcome' },
  { id: 'prices', parentId: 'guides' },
  { id: 'news', parentId: null },
  { id: 'monthly', parentId: 'news' },
];

it('offers all folders when creating and removes self and every descendant when moving', () => {
  expect(folderDestinations(tree).map((folder) => folder.id)).toEqual([
    'welcome',
    'guides',
    'prices',
    'news',
    'monthly',
  ]);
  expect(folderDestinations(tree, 'welcome').map((folder) => folder.id)).toEqual([
    'news',
    'monthly',
  ]);
  expect(folderDestinations(tree, 'guides').map((folder) => folder.id)).toEqual([
    'welcome',
    'news',
    'monthly',
  ]);
  expect(folderDestinations(tree, 'prices').map((folder) => folder.id)).toEqual([
    'welcome',
    'guides',
    'news',
    'monthly',
  ]);
});

it('does not hang or offer descendants when a stale tree contains a cycle', () => {
  expect(
    folderDestinations(
      [
        { id: 'a', parentId: 'b' },
        { id: 'b', parentId: 'a' },
        { id: 'safe', parentId: null },
      ],
      'a',
    ),
  ).toEqual([{ id: 'safe', parentId: null }]);
});
