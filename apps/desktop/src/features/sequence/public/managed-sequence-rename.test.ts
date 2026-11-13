import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  acknowledgeManagedSequenceRename,
  clearManagedSequenceRenameRequest,
  peekManagedSequenceRename,
  requestManagedSequenceRename,
  useManagedSequenceRenameRequest,
} from './managed-sequence-rename';

describe('requestManagedSequenceRename', () => {
  beforeEach(() => {
    clearManagedSequenceRenameRequest();
  });

  afterEach(() => {
    clearManagedSequenceRenameRequest();
  });

  it('opens metadata when the plasmid tab mounts after the rename request', () => {
    const onRename = vi.fn();
    const request = requestManagedSequenceRename('pkg-plasmid');

    const first = renderHook(() => useManagedSequenceRenameRequest('pkg-plasmid', onRename));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith(request.requestId);
    first.unmount();

    renderHook(() => useManagedSequenceRenameRequest('pkg-plasmid', onRename));
    expect(onRename).toHaveBeenCalledTimes(2);

    acknowledgeManagedSequenceRename('pkg-plasmid', request.requestId);
    expect(peekManagedSequenceRename('pkg-plasmid')).toBeNull();
  });

  it('opens metadata on a plasmid tab that is already showing', () => {
    const onRename = vi.fn();
    renderHook(() => useManagedSequenceRenameRequest('pkg-plasmid', onRename));

    let requestId = 0;
    act(() => {
      requestId = requestManagedSequenceRename('pkg-plasmid').requestId;
    });

    expect(onRename).toHaveBeenCalledWith(requestId);
  });

  it('ignores a rename aimed at a different plasmid', () => {
    const onRename = vi.fn();
    renderHook(() => useManagedSequenceRenameRequest('pkg-plasmid', onRename));

    act(() => {
      requestManagedSequenceRename('other-package');
    });

    expect(onRename).not.toHaveBeenCalled();
    expect(peekManagedSequenceRename('other-package')?.packageId).toBe('other-package');
  });
});
