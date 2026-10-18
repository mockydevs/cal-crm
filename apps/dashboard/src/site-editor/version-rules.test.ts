import { describe, expect, it } from 'vitest';
import {
  groupVersions,
  kindOf,
  nameOf,
  VERSION_NAME_MAX,
  versionNameOf,
  writtenAt,
  type ListedVersion,
} from './version-rules';

const version = (number: number, rest: Partial<ListedVersion> = {}): ListedVersion => ({
  number,
  createdAt: `2026-10-12T0${String(number)}:00:00.000Z`,
  restoredFrom: null,
  current: false,
  published: false,
  ...rest,
});

describe('groupVersions', () => {
  it('lists the working draft, the kept versions and the automatic checkpoints apart, newest first', () => {
    const items = [
      version(1, { kind: 'saved' }),
      version(2, { kind: 'checkpoint' }),
      version(3, { kind: 'saved', name: 'Before the launch' }),
      version(4, { kind: 'saved', published: true }),
      version(5, { kind: 'checkpoint' }),
      version(6, { kind: 'draft', current: true }),
    ];
    const groups = groupVersions(items);
    expect(groups.draft?.number).toBe(6);
    expect(groups.kept.map((each) => each.number)).toEqual([4, 3, 1]);
    expect(groups.checkpoints.map((each) => each.number)).toEqual([5, 2]);
    // Every version is in exactly one list.
    expect(
      [groups.draft, ...groups.kept, ...groups.checkpoints].map((each) => each?.number).sort(),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('shows many autosaves and one version saved on purpose as one named version, not many', () => {
    // Five autosaves rewrote version 2 in place; "Save a version" then kept it under a name.
    const groups = groupVersions([
      version(2, { kind: 'saved', name: 'Before the launch', current: true }),
      version(1, { kind: 'saved' }),
    ]);
    expect(groups.draft).toBeUndefined();
    expect(groups.checkpoints).toEqual([]);
    expect(groups.kept.map(nameOf)).toEqual(['Before the launch', undefined]);
  });

  it('takes the versions of a server from before the working draft as kept ones', () => {
    const groups = groupVersions([version(2, { current: true }), version(1)]);
    expect(groups.draft).toBeUndefined();
    expect(groups.kept.map((each) => each.number)).toEqual([2, 1]);
    expect(groups.checkpoints).toEqual([]);
    expect(kindOf(version(1))).toBe('saved');
  });

  it('leaves nothing out: a draft that is not the newest is listed with the checkpoints', () => {
    const groups = groupVersions([
      version(1, { kind: 'draft' }),
      version(2, { kind: 'draft', current: true }),
    ]);
    expect(groups.draft?.number).toBe(2);
    expect(groups.checkpoints.map((each) => each.number)).toEqual([1]);
    expect(groupVersions([]).draft).toBeUndefined();
    expect(groupVersions([version(1, { kind: 'draft' })]).checkpoints).toHaveLength(1);
  });

  it('does not change the list it was given', () => {
    const items = [version(1), version(3), version(2)];
    groupVersions(items);
    expect(items.map((each) => each.number)).toEqual([1, 3, 2]);
  });
});

describe('a version’s name and time', () => {
  it('reads the name it was saved under, and none from an empty one', () => {
    expect(nameOf(version(1, { name: ' Before the launch ' }))).toBe('Before the launch');
    expect(nameOf(version(1, { name: '' }))).toBeUndefined();
    expect(nameOf(version(1, { name: '  ' }))).toBeUndefined();
    expect(nameOf(version(1, { name: null }))).toBeUndefined();
    expect(nameOf(version(1))).toBeUndefined();
  });

  it('dates a working draft and a checkpoint by their last autosave, a kept version by its saving', () => {
    const updatedAt = '2026-10-12T09:30:00.000Z';
    expect(writtenAt(version(2, { kind: 'draft', updatedAt }))).toBe(updatedAt);
    expect(writtenAt(version(2, { kind: 'checkpoint', updatedAt }))).toBe(updatedAt);
    expect(writtenAt(version(2, { kind: 'draft' }))).toBe('2026-10-12T02:00:00.000Z');
    expect(writtenAt(version(2, { kind: 'saved', updatedAt }))).toBe('2026-10-12T02:00:00.000Z');
    expect(writtenAt(version(2, { updatedAt }))).toBe('2026-10-12T02:00:00.000Z');
  });

  it('sends a typed name trimmed, and none when the box was left empty', () => {
    expect(versionNameOf('  Before the launch ')).toBe('Before the launch');
    expect(versionNameOf('')).toBeUndefined();
    expect(versionNameOf('   ')).toBeUndefined();
    expect(VERSION_NAME_MAX).toBe(120);
  });
});
