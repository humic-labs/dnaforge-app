import 'fake-indexeddb/auto';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteAllUnsavedDrafts,
  flushPendingUnsavedDraftWrites,
  readUnsavedDraft,
  useUnsavedDraftRecovery,
} from './unsaved-draft-recovery';
afterEach(async () => {
  await deleteAllUnsavedDrafts();
});
describe('legacy recovery pending-write fence', () => {
  it('flushes the current keyed recovery before capture without waiting for its timer', async () => {
    const key = 'new:current-primer';
    const hook = renderHook(() =>
      useUnsavedDraftRecovery({
        key,
        name: 'Current primer',
        baseline: 'new',
        dirty: true,
        payload: { sequence: 'ACGT' },
        onRestore: vi.fn(),
      })
    );
    try {
      await flushPendingUnsavedDraftWrites([key]);
      expect(await readUnsavedDraft(key)).toMatchObject({ payload: { sequence: 'ACGT' } });
    } finally {
      hook.unmount();
    }
  });
  it('does not resurrect a pending copy after the document becomes clean', async () => {
    const key = 'text:/admitted/clean.txt';
    const hook = renderHook(
      ({ dirty }) =>
        useUnsavedDraftRecovery({
          key,
          name: 'Clean',
          baseline: 'saved',
          dirty,
          payload: 'draft',
          onRestore: vi.fn(),
        }),
      { initialProps: { dirty: true } }
    );
    try {
      hook.rerender({ dirty: false });
      await flushPendingUnsavedDraftWrites([key]);
      expect(await readUnsavedDraft(key)).toBeUndefined();
    } finally {
      hook.unmount();
    }
  });
});
