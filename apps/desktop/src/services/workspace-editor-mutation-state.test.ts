// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  assertWorkspaceEditorsSettled,
  beginWorkspaceEditorWrite,
  freezeWorkspaceEditorWrites,
  getWorkspaceEditorBlockers,
  registerWorkspaceEditorBlocker,
} from './workspace-editor-mutation-state';

const scope = { workspaceRoot: '/managed/a', affectedEntityIds: ['note-a', 'record-a'] };
describe('workspace editor mutation settlement', () => {
  it.each(['dirty', 'saving'] as const)(
    'refuses %s local drafts until their owner clears or unregisters them',
    (state) => {
      let current: 'clean' | 'dirty' | 'saving' = state;
      const unregister = registerWorkspaceEditorBlocker(() => ({
        entityId: 'record-a',
        state: current,
      }));
      try {
        expect(() => assertWorkspaceEditorsSettled(scope)).toThrow(/unsaved|saving/);
        current = 'clean';
        expect(() => assertWorkspaceEditorsSettled(scope)).not.toThrow();
        current = state;
        unregister();
        expect(() => assertWorkspaceEditorsSettled(scope)).not.toThrow();
      } finally {
        unregister();
      }
    }
  );
  it('keeps an in-flight write registered independently of editor unmount', () => {
    const unregister = registerWorkspaceEditorBlocker(() => ({
      entityId: 'note-a',
      state: 'clean',
    }));
    const finishWrite = beginWorkspaceEditorWrite({ entityId: 'note-a' });
    unregister();
    try {
      expect(() => assertWorkspaceEditorsSettled(scope)).toThrow(/saving/);
    } finally {
      finishWrite();
    }
    expect(() => assertWorkspaceEditorsSettled(scope)).not.toThrow();
  });
  it('refuses new writes during a freeze, then releases only its own freeze', () => {
    const release = freezeWorkspaceEditorWrites(scope);
    const releaseOther = freezeWorkspaceEditorWrites({
      workspaceRoot: '/managed/b',
      affectedEntityIds: ['note-b'],
    });
    try {
      expect(() => beginWorkspaceEditorWrite({ entityId: 'note-a' })).toThrow(/project update/);
      release();
      const finish = beginWorkspaceEditorWrite({ entityId: 'note-a', path: '/managed/a/Notes.md' });
      finish();
      expect(() => beginWorkspaceEditorWrite({ entityId: 'note-b' })).toThrow(/project update/);
    } finally {
      release();
      releaseOther();
    }
  });
  it('uses physical scope for opaque sequence IDs and does not block a known unrelated workspace', () => {
    const unregister = registerWorkspaceEditorBlocker(() => ({
      entityId: 'opaque-sequence',
      path: '/managed/a/DNA.gb',
      state: 'dirty',
    }));
    const unrelated = registerWorkspaceEditorBlocker(() => ({
      entityId: 'other-record',
      path: '/managed/b/record',
      state: 'dirty',
    }));
    try {
      expect(() => assertWorkspaceEditorsSettled(scope)).toThrow(/unsaved/);
      unregister();
      expect(() => assertWorkspaceEditorsSettled(scope)).not.toThrow();
    } finally {
      unregister();
      unrelated();
    }
  });
  it('does not silently exempt a draft whose workspace is unknown', () => {
    const unregister = registerWorkspaceEditorBlocker(() => ({
      entityId: 'unscoped-record',
      state: 'dirty',
    }));
    try {
      expect(() => assertWorkspaceEditorsSettled(scope)).toThrow(/unsaved/);
    } finally {
      unregister();
    }
  });
  it('exposes current target editor states without mistaking a dirty sequence for Metadata', () => {
    let metadataState: 'clean' | 'dirty' = 'clean';
    const leaveSequence = registerWorkspaceEditorBlocker(() => ({
      entityId: 'record-a',
      path: '/managed/a/sequence.gb',
      state: 'dirty',
    }));
    const leaveMetadata = registerWorkspaceEditorBlocker(() => ({
      entityId: 'record-a',
      path: '/managed/a',
      state: metadataState,
    }));
    try {
      const metadata = () =>
        getWorkspaceEditorBlockers(scope).find(
          (editor) => editor.entityId === 'record-a' && editor.path === '/managed/a'
        );
      expect(metadata()?.state).toBe('clean');
      metadataState = 'dirty';
      expect(metadata()?.state).toBe('dirty');
      expect(
        getWorkspaceEditorBlockers({ workspaceRoot: '/managed/b', affectedEntityIds: [] })
      ).toEqual([]);
    } finally {
      leaveSequence();
      leaveMetadata();
    }
  });
});
