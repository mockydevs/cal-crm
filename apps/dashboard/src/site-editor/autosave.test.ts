import { describe, expect, it } from 'vitest';
import {
  autosave,
  canSaveNow,
  hasUnsavedWork,
  SAVE_PAUSE_MS,
  saveDueIn,
  startAutosave,
  type Autosave,
  type AutosaveEvent,
} from './autosave';

const after = (state: Autosave, ...events: AutosaveEvent[]): Autosave =>
  events.reduce(autosave, state);
const edited: AutosaveEvent = { type: 'edited' };
const started: AutosaveEvent = { type: 'save_started' };

describe('autosave', () => {
  it('starts saved, at the version the page was read at', () => {
    const state = startAutosave(4);
    expect(state).toMatchObject({ status: 'saved', baseVersion: 4, failures: 0 });
    expect(hasUnsavedWork(state)).toBe(false);
    expect(saveDueIn(state)).toBeNull();
    expect(canSaveNow(state)).toBe(false);
  });

  it('saves after a pause in the edits, and names the version the edits started from', () => {
    const dirty = after(startAutosave(4), edited, edited);
    expect(dirty.status).toBe('dirty');
    expect(hasUnsavedWork(dirty)).toBe(true);
    expect(saveDueIn(dirty)).toBe(SAVE_PAUSE_MS);
    expect(canSaveNow(dirty)).toBe(true);
    const saving = autosave(dirty, started);
    expect(saving).toMatchObject({ status: 'saving', baseVersion: 4, sent: 2 });
    expect(saveDueIn(saving)).toBeNull();
    expect(canSaveNow(saving)).toBe(false);
    const saved = autosave(saving, { type: 'save_succeeded', version: 5 });
    expect(saved).toMatchObject({ status: 'saved', baseVersion: 5 });
    expect(hasUnsavedWork(saved)).toBe(false);
  });

  it('saves again what was edited while a save was on its way', () => {
    const during = after(startAutosave(1), edited, started, edited);
    // The save is not interrupted.
    expect(during.status).toBe('saving');
    const landed = autosave(during, { type: 'save_succeeded', version: 2 });
    expect(landed).toMatchObject({ status: 'dirty', baseVersion: 2 });
    expect(saveDueIn(landed)).toBe(SAVE_PAUSE_MS);
    expect(after(landed, started, { type: 'save_succeeded', version: 3 })).toMatchObject({
      status: 'saved',
      baseVersion: 3,
    });
  });

  it('keeps the work when a save fails, and tries again later each time', () => {
    const once = after(startAutosave(1), edited, started, { type: 'save_failed' });
    expect(once).toMatchObject({ status: 'failed', failures: 1, baseVersion: 1 });
    expect(hasUnsavedWork(once)).toBe(true);
    expect(canSaveNow(once)).toBe(true);
    expect(saveDueIn(once)).toBe(2000);
    const waits = [once];
    for (let tries = 0; tries < 5; tries += 1)
      waits.push(after(waits.at(-1) ?? once, started, { type: 'save_failed' }));
    expect(waits.map(saveDueIn)).toStrictEqual([2000, 5000, 15_000, 30_000, 30_000, 30_000]);
    // The try that arrives ends the count.
    const saved = after(waits.at(-1) ?? once, started, { type: 'save_succeeded', version: 2 });
    expect(saved).toMatchObject({ status: 'saved', failures: 0, baseVersion: 2 });
    // An edit after a failure saves after the usual pause, not the long wait.
    expect(autosave(waits.at(-1) ?? once, edited)).toMatchObject({ status: 'dirty', failures: 0 });
  });

  it('waits for the person when someone else saved first: keep mine, or load theirs', () => {
    const conflict = after(startAutosave(3), edited, started, { type: 'conflict' });
    expect(conflict).toMatchObject({ status: 'conflict', baseVersion: 3 });
    expect(saveDueIn(conflict)).toBeNull();
    expect(canSaveNow(conflict)).toBe(false);
    expect(hasUnsavedWork(conflict)).toBe(true);
    // An edit meanwhile is kept, and the question stays.
    expect(autosave(conflict, edited).status).toBe('conflict');

    // Keep mine: the next save is made on top of theirs.
    const mine = autosave(conflict, { type: 'kept_mine', baseVersion: 4 });
    expect(mine).toMatchObject({ status: 'dirty', baseVersion: 4 });
    expect(canSaveNow(mine)).toBe(true);
    expect(after(mine, started, { type: 'save_succeeded', version: 5 })).toMatchObject({
      status: 'saved',
      baseVersion: 5,
    });

    // Load theirs: nothing of mine is left to save.
    const theirs = autosave(autosave(conflict, edited), { type: 'loaded', version: 4 });
    expect(theirs).toMatchObject({ status: 'saved', baseVersion: 4, failures: 0, valid: true });
    expect(hasUnsavedWork(theirs)).toBe(false);
    expect(after(theirs, edited, started).sent).toBe(theirs.edits + 1);
  });

  it('does not send a page the contract refuses, and sends it once it is put right', () => {
    const invalid = after(startAutosave(1), edited, { type: 'checked', valid: false });
    expect(invalid).toMatchObject({ status: 'invalid', valid: false });
    expect(saveDueIn(invalid)).toBeNull();
    expect(canSaveNow(invalid)).toBe(false);
    expect(hasUnsavedWork(invalid)).toBe(true);
    expect(autosave(invalid, { type: 'checked', valid: true }).status).toBe('dirty');
    expect(autosave(invalid, edited)).toMatchObject({ status: 'dirty', valid: true });
    // A check changes nothing while a save is on its way or a choice is owed.
    const saving = after(startAutosave(1), edited, started);
    expect(autosave(saving, { type: 'checked', valid: false })).toMatchObject({
      status: 'saving',
      valid: false,
    });
    // What was edited meanwhile is not valid: it waits to be put right, not to be sent.
    expect(
      after(
        saving,
        edited,
        { type: 'checked', valid: false },
        { type: 'save_succeeded', version: 2 },
      ),
    ).toMatchObject({ status: 'invalid', baseVersion: 2 });
    expect(
      after(
        startAutosave(1),
        edited,
        { type: 'checked', valid: false },
        {
          type: 'kept_mine',
          baseVersion: 2,
        },
      ).status,
    ).toBe('invalid');
  });

  it('stops trying when the server itself refuses the page', () => {
    const refused = after(startAutosave(1), edited, started, { type: 'save_refused' });
    expect(refused).toMatchObject({ status: 'invalid', valid: false, failures: 0 });
    expect(saveDueIn(refused)).toBeNull();
    expect(autosave(refused, edited).status).toBe('dirty');
  });

  it('never changes the state it was given', () => {
    const state = startAutosave(1);
    const before = JSON.stringify(state);
    after(state, edited, started, { type: 'save_failed' }, { type: 'conflict' });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('a version kept on purpose, or a publish', () => {
  it('moves what the next save starts from, and nothing else', () => {
    const saved = after(startAutosave(4), edited, started, { type: 'save_succeeded', version: 4 });
    expect(saved).toMatchObject({ status: 'saved', baseVersion: 4 });
    const moved = autosave(saved, { type: 'version_moved', version: 5 });
    expect(moved).toStrictEqual({ ...saved, baseVersion: 5 });
    // Edits made meanwhile are still unsaved, and are saved on top of the new version.
    const dirty = autosave(autosave(saved, edited), { type: 'version_moved', version: 5 });
    expect(dirty).toMatchObject({ status: 'dirty', baseVersion: 5 });
    expect(canSaveNow(dirty)).toBe(true);
  });

  it('keeps the version an autosave rewrote in place as its base', () => {
    // Five autosaves into one working draft: the version stays 2 throughout.
    let state = startAutosave(1);
    state = after(state, edited, started, { type: 'save_succeeded', version: 2 });
    for (let at = 0; at < 4; at += 1)
      state = after(state, edited, started, { type: 'save_succeeded', version: 2 });
    expect(state).toMatchObject({ status: 'saved', baseVersion: 2, failures: 0 });
    expect(hasUnsavedWork(state)).toBe(false);
  });
});
