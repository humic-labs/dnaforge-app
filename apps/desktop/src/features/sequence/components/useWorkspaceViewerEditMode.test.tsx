import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceViewerEditMode } from './useWorkspaceViewerEditMode';

describe('initial sequence edit intent', () => {
  it('enters after the owning project finishes checking and permits an empty sequence', () => {
    const hook = renderHook(
      ({ initial, readOnly }) => useWorkspaceViewerEditMode('document-a', initial, readOnly),
      {
        initialProps: { initial: false, readOnly: true },
      }
    );
    expect(hook.result.current[0]).toBe(false);
    hook.rerender({ initial: true, readOnly: false });
    expect(hook.result.current[0]).toBe(true);
  });

  it('never enters while read-only and consumes initial intent only once', () => {
    const hook = renderHook(
      ({ readOnly }) => useWorkspaceViewerEditMode('document-a', true, readOnly),
      {
        initialProps: { readOnly: true },
      }
    );
    expect(hook.result.current[0]).toBe(false);
    act(() => hook.result.current[1](true));
    expect(hook.result.current[0]).toBe(false);
    hook.rerender({ readOnly: false });
    expect(hook.result.current[0]).toBe(true);
    const writableSet = hook.result.current[1];
    hook.rerender({ readOnly: true });
    const staleUpdate = vi.fn(() => true);
    act(() => writableSet(staleUpdate));
    expect(staleUpdate).not.toHaveBeenCalled();
    expect(hook.result.current[0]).toBe(false);
    hook.rerender({ readOnly: false });
    expect(hook.result.current[0]).toBe(false);
  });

  it('does not reenter after the user leaves and permissions change', () => {
    const hook = renderHook(
      ({ readOnly }) => useWorkspaceViewerEditMode('document-a', true, readOnly),
      {
        initialProps: { readOnly: false },
      }
    );
    act(() => hook.result.current[1](false));
    hook.rerender({ readOnly: true });
    hook.rerender({ readOnly: false });
    expect(hook.result.current[0]).toBe(false);
  });

  it('keeps initial intent and stale setters scoped to their document owner', () => {
    const hook = renderHook(
      ({ owner, initial, readOnly }) => useWorkspaceViewerEditMode(owner, initial, readOnly),
      {
        initialProps: { owner: 'document-a', initial: true, readOnly: false },
      }
    );
    const oldSet = hook.result.current[1];
    hook.rerender({ owner: 'document-b', initial: false, readOnly: false });
    expect(hook.result.current[0]).toBe(false);
    act(() => oldSet(true));
    expect(hook.result.current[0]).toBe(false);
    hook.rerender({ owner: 'document-c', initial: false, readOnly: true });
    hook.rerender({ owner: 'document-c', initial: true, readOnly: false });
    expect(hook.result.current[0]).toBe(true);
  });

  it('suspends an active empty-sequence editor during reload and restores its intent afterward', () => {
    const hook = renderHook(
      ({ pending }) => useWorkspaceViewerEditMode('document-a', true, false, pending),
      { initialProps: { pending: false } }
    );
    expect(hook.result.current[0]).toBe(true);
    const setEditing = hook.result.current[1];
    hook.rerender({ pending: true });
    expect(hook.result.current[0]).toBe(false);
    const staleUpdate = vi.fn(() => false);
    act(() => setEditing(staleUpdate));
    expect(staleUpdate).not.toHaveBeenCalled();
    hook.rerender({ pending: false });
    expect(hook.result.current[0]).toBe(true);
  });

  it('does not restore a user-dismissed editor when a reload settles', () => {
    const hook = renderHook(
      ({ pending }) => useWorkspaceViewerEditMode('document-a', true, false, pending),
      { initialProps: { pending: false } }
    );
    act(() => hook.result.current[1](false));
    hook.rerender({ pending: true });
    hook.rerender({ pending: false });
    expect(hook.result.current[0]).toBe(false);
  });

  it('keeps an open editor visible but not editable while its Save is in flight', () => {
    const hook = renderHook(
      ({ pending, saving }) =>
        useWorkspaceViewerEditMode('document-a', false, false, pending, saving),
      { initialProps: { pending: false, saving: false } }
    );
    act(() => hook.result.current[1](true));
    expect(hook.result.current[0]).toBe(true);
    expect(hook.result.current[2]).toBe(true);
    hook.rerender({ pending: false, saving: true });
    expect(hook.result.current[0]).toBe(true);
    expect(hook.result.current[2]).toBe(false);
    hook.rerender({ pending: true, saving: true });
    expect(hook.result.current[0]).toBe(true);
    expect(hook.result.current[2]).toBe(false);
    act(() => hook.result.current[1](false));
    hook.rerender({ pending: false, saving: false });
    expect(hook.result.current[0]).toBe(false);
    expect(hook.result.current[2]).toBe(false);
  });

  it('retains an open editor through a failed Save in flight', () => {
    const hook = renderHook(
      ({ pending, saving }) =>
        useWorkspaceViewerEditMode('document-a', false, false, pending, saving),
      { initialProps: { pending: false, saving: false } }
    );
    act(() => hook.result.current[1](true));
    hook.rerender({ pending: true, saving: true });
    hook.rerender({ pending: false, saving: false });
    expect(hook.result.current[0]).toBe(true);
    expect(hook.result.current[2]).toBe(true);
  });

  it('preserves ordinary manual entry, save and discard after initialization', () => {
    const hook = renderHook(() => useWorkspaceViewerEditMode('document-a', false, false));
    expect(hook.result.current[0]).toBe(false);
    act(() => hook.result.current[1](true));
    expect(hook.result.current[0]).toBe(true);
    act(() => hook.result.current[1](false));
    expect(hook.result.current[0]).toBe(false);
  });
});
