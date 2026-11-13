import { describe, expect, it } from 'vitest';
import { DraftSaveOwner } from './draft-save-owner';

describe('DraftSaveOwner external reads', () => {
  it('rejects a reload after a user edits while the read is in flight', () => {
    const owner = new DraftSaveOwner();
    owner.observeDraft('original');
    const read = owner.beginReload();
    owner.observeDraft('new edit');
    expect(owner.canAdoptReload(read)).toBe(false);
  });

  it('rejects older reads and retired document lifetimes', () => {
    const owner = new DraftSaveOwner();
    const older = owner.beginReload();
    const newer = owner.beginReload();
    expect(owner.canAdoptReload(older)).toBe(false);
    expect(owner.canAdoptReload(newer)).toBe(true);
    owner.retire();
    expect(owner.canAdoptReload(newer)).toBe(false);
  });

  it('rejects a read crossing a save even when the draft text is unchanged', () => {
    const owner = new DraftSaveOwner();
    owner.observeDraft('draft');
    const read = owner.beginReload();
    const save = owner.begin()!;
    expect(owner.canAdoptReload(read)).toBe(false);
    expect(owner.finish(save)).toBe('saved');
    expect(owner.canAdoptReload(read)).toBe(false);
  });
});
