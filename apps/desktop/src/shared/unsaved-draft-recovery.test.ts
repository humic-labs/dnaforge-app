import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const KEY = 'text:/project/notes.txt';

async function newWindow() {
  vi.resetModules();
  const recovery = await import('./unsaved-draft-recovery');
  const { useToastStore } = await import('../stores/toast-store');
  return { recovery, useToastStore };
}

afterEach(async () => {
  const { deleteAllUnsavedDrafts } = await import('./unsaved-draft-recovery');
  await deleteAllUnsavedDrafts();
});

async function leaveUnsavedEdit(baselineText: string, draft: string) {
  const { recovery } = await newWindow();
  const baseline = recovery.fingerprintText(baselineText);
  const hook = renderHook(() =>
    recovery.useUnsavedDraftRecovery({
      key: KEY,
      name: 'notes.txt',
      baseline,
      dirty: true,
      payload: draft,
      onRestore: vi.fn(),
    })
  );
  await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(KEY)).toBeDefined());
  hook.unmount();
}

describe('useUnsavedDraftRecovery ', { timeout: 20_000 }, () => {
  it('discards a page recovery copy only for its matching page target', async () => {
    const { recovery } = await newWindow();
    const key = 'page:synthetic-page';
    const hook = renderHook(() =>
      recovery.useUnsavedDraftRecovery({
        key,
        name: 'Synthetic page',
        baseline: recovery.fingerprintText('{}'),
        dirty: true,
        payload: { text: 'unsaved' },
        onRestore: vi.fn(),
        discardTarget: { kind: 'page', pageId: 'synthetic-page' },
      })
    );
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(key)).toBeDefined());
    act(() =>
      window.dispatchEvent(
        new CustomEvent('document-discarded', {
          detail: { kind: 'file', filePath: 'synthetic-page' },
        })
      )
    );
    expect(await recovery.readUnsavedDraft(key)).toBeDefined();
    act(() =>
      window.dispatchEvent(
        new CustomEvent('document-discarded', {
          detail: { kind: 'page', pageId: 'synthetic-page' },
        })
      )
    );
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(key)).toBeUndefined());
    hook.unmount();
  });

  it('offers the previous window’s unsaved draft and restores it', async () => {
    await leaveUnsavedEdit('saved text', 'saved text plus unsaved edit');
    const { recovery, useToastStore } = await newWindow();
    const onRestore = vi.fn();
    renderHook(() =>
      recovery.useUnsavedDraftRecovery({
        key: KEY,
        name: 'notes.txt',
        baseline: recovery.fingerprintText('saved text'),
        dirty: false,
        payload: 'saved text',
        onRestore,
      })
    );
    const toast = await vi.waitFor(() => {
      const found = useToastStore
        .getState()
        .toasts.find((t) => t.definition === 'unsaved-draft-recovery-available');
      expect(found?.message).toContain('notes.txt has unsaved changes');
      return found!;
    });
    act(() => useToastStore.getState().invokeToastAction(toast.id, 0));
    expect(onRestore).toHaveBeenCalledWith('saved text plus unsaved edit');
  });

  it('does not offer a draft made against a file that changed since', async () => {
    await leaveUnsavedEdit('saved text', 'edit');
    const { recovery, useToastStore } = await newWindow();
    const onRestore = vi.fn();
    renderHook(() =>
      recovery.useUnsavedDraftRecovery({
        key: KEY,
        name: 'notes.txt',
        baseline: recovery.fingerprintText('someone else changed this'),
        dirty: false,
        payload: '',
        onRestore,
      })
    );
    await vi.waitFor(() =>
      expect(
        useToastStore
          .getState()
          .toasts.some((t) => t.definition === 'unsaved-draft-recovery-outdated')
      ).toBe(true)
    );
    expect(onRestore).not.toHaveBeenCalled();
    expect(await recovery.readUnsavedDraft(KEY)).toBeUndefined();
  });

  it('drops the copy when the edit is saved, and on Don’t Save', async () => {
    const { recovery } = await newWindow();
    const baseline = recovery.fingerprintText('a');
    const hook = renderHook(
      ({ dirty }) =>
        recovery.useUnsavedDraftRecovery({
          key: KEY,
          name: 'notes.txt',
          baseline,
          dirty,
          payload: dirty ? 'ab' : 'a',
          onRestore: vi.fn(),
          discardTarget: { kind: 'file', filePath: '/project/notes.txt' },
        }),
      { initialProps: { dirty: true } }
    );
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(KEY)).toBeDefined());
    hook.rerender({ dirty: false });
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(KEY)).toBeUndefined());

    hook.rerender({ dirty: true });
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(KEY)).toBeDefined());
    window.dispatchEvent(
      new CustomEvent('document-discarded', {
        detail: { kind: 'file', filePath: '/project/notes.txt' },
      })
    );
    await vi.waitFor(async () => expect(await recovery.readUnsavedDraft(KEY)).toBeUndefined());
  });

  it('records drafts handed over directly by editors that do not re-render per edit', async () => {
    const { recovery } = await newWindow();
    const hook = renderHook(() =>
      recovery.useUnsavedDraftRecovery<{ text: string }>({
        key: 'page:p1',
        name: 'Notes',
        baseline: recovery.fingerprintText('{}'),
        dirty: true,
        onRestore: vi.fn(),
      })
    );
    hook.result.current.recordDraft({ text: 'typed just before the crash' });
    await vi.waitFor(async () =>
      expect((await recovery.readUnsavedDraft<{ text: string }>('page:p1'))?.payload).toEqual({
        text: 'typed just before the crash',
      })
    );
  });

  it('offers to reopen a new-artifact form left by an earlier window', async () => {
    const first = await newWindow();
    const payload = {
      tabType: 'protein' as const,
      label: 'Crash protein',
      artifactDocument: {
        kind: 'protein' as const,
        persistence: 'draft' as const,
        workspaceRoot: '/w',
        destinationPath: '/w',
      },
      fields: { name: 'Crash protein', sequence: 'MPEPTIDE' },
    };
    const hook = renderHook(() =>
      first.recovery.useUnsavedDraftRecovery({
        key: 'new:tab-1',
        name: 'Crash protein',
        baseline: first.recovery.NEW_DOCUMENT_BASELINE,
        dirty: true,
        payload,
        onRestore: vi.fn(),
      })
    );
    await vi.waitFor(async () =>
      expect(await first.recovery.readUnsavedDraft('new:tab-1')).toBeDefined()
    );
    hook.unmount();

    const second = await newWindow();
    const reopen = vi.fn();
    await second.recovery.offerUnsavedNewDrafts(reopen);
    const toast = second.useToastStore
      .getState()
      .toasts.find((t) => t.definition === 'unsaved-new-draft-recovery-available')!;
    expect(toast.message).toBe(
      'Unsaved new protein "Crash protein" from a window that closed unexpectedly.'
    );
    act(() => second.useToastStore.getState().invokeToastAction(toast.id, 0));
    expect(reopen).toHaveBeenCalledWith(payload);
    await vi.waitFor(async () =>
      expect(await second.recovery.readUnsavedDraft('new:tab-1')).toBeUndefined()
    );
  });
});
