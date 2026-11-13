import 'fake-indexeddb/auto';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  deleteAllUnsavedDrafts,
  offerUnsavedNewDrafts,
  readUnsavedDraft,
  useUnsavedDraftRecovery,
} from './unsaved-draft-recovery';
import { useToastStore } from '../stores/toast-store';

async function seed(key: string, payload: unknown) {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('dnaforge-unsaved-drafts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'key' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put({
        key,
        payload,
        baseline: 'saved',
        version: 1,
        sessionId: 'previous-window',
        savedAt: Date.now(),
        name: key,
      });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

beforeEach(() => useToastStore.getState().clearToasts());
afterEach(async () => {
  cleanup();
  await deleteAllUnsavedDrafts();
  useToastStore.getState().clearToasts();
});

async function offered(definition: string) {
  return vi.waitFor(() => {
    const toast = useToastStore.getState().toasts.find((value) => value.definition === definition);
    expect(toast?.actions).toBeDefined();
    return toast!;
  });
}

it('a recovery offer cannot restore the previous document into a replacement view', async () => {
  await seed('text:a', 'draft A');
  const restore = vi.fn();
  const hook = renderHook(
    ({ key }) =>
      useUnsavedDraftRecovery({
        key,
        name: key,
        baseline: 'saved',
        dirty: false,
        onRestore: restore,
      }),
    { initialProps: { key: 'text:a' } }
  );
  const toast = await offered('unsaved-draft-recovery-available');
  hook.rerender({ key: 'text:b' });
  await act(async () => toast.actions![0].onClick());
  expect(restore).not.toHaveBeenCalled();
  expect(await readUnsavedDraft('text:a')).toMatchObject({ payload: 'draft A' });
});

it('a recovery offer is retired when its editing view unmounts', async () => {
  await seed('text:a', 'draft A');
  const restore = vi.fn();
  const hook = renderHook(() =>
    useUnsavedDraftRecovery({
      key: 'text:a',
      name: 'A',
      baseline: 'saved',
      dirty: false,
      onRestore: restore,
    })
  );
  const toast = await offered('unsaved-draft-recovery-available');
  hook.unmount();
  await act(async () => toast.actions![0].onClick());
  expect(restore).not.toHaveBeenCalled();
});

it('discarding an old recovery offer cannot delete a newer draft at the same identity', async () => {
  await seed('text:a', 'draft A');
  renderHook(() =>
    useUnsavedDraftRecovery({
      key: 'text:a',
      name: 'A',
      baseline: 'saved',
      dirty: false,
      onRestore: vi.fn(),
    })
  );
  const toast = await offered('unsaved-draft-recovery-available');
  await seed('text:a', 'newer draft');
  await act(async () => toast.actions![1].onClick());
  expect(await readUnsavedDraft('text:a')).toMatchObject({ payload: 'newer draft' });
});

it('discarding a new-document offer cannot erase a replacement recovery draft', async () => {
  await seed('new:protein:one', {
    tabType: 'protein',
    label: 'old',
    fields: { sequence: 'MPEPTIDE' },
  });
  await offerUnsavedNewDrafts(vi.fn());
  const toast = await offered('unsaved-new-draft-recovery-available');
  await seed('new:protein:one', {
    tabType: 'protein',
    label: 'newer',
    fields: { sequence: 'MPEPTIDEAC' },
  });
  await act(async () => toast.actions![1].onClick());
  expect(await readUnsavedDraft('new:protein:one')).toMatchObject({ payload: { label: 'newer' } });
});

it('moving a dirty view to a clean document preserves that document recovery copy', async () => {
  await seed('text:b', 'recoverable B');
  const hook = renderHook(
    ({ key, dirty }) =>
      useUnsavedDraftRecovery({
        key,
        name: key,
        baseline: 'saved',
        dirty,
        payload: 'editing A',
        onRestore: vi.fn(),
      }),
    { initialProps: { key: 'text:a', dirty: true } }
  );
  hook.rerender({ key: 'text:b', dirty: false });
  await offered('unsaved-draft-recovery-available');
  expect(await readUnsavedDraft('text:b')).toMatchObject({ payload: 'recoverable B' });
});
