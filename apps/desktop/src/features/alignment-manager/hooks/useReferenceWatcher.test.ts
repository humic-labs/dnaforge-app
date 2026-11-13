// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let fileChangedListeners: Array<(...args: unknown[]) => void> = [];

const mockPlatform = {
  fs: {
    watchFile: vi.fn().mockResolvedValue(undefined),
    unwatchFile: vi.fn().mockResolvedValue(undefined),
  },
  on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'file-changed') {
      fileChangedListeners.push(listener);
    }
    return () => {
      fileChangedListeners = fileChangedListeners.filter((l) => l !== listener);
    };
  }),
};

vi.mock('../../../platform', () => ({
  platform: () => mockPlatform,
}));

import { useReferenceWatcher } from './useReferenceWatcher';
import { platform } from '../../../platform';

describe('useReferenceWatcher', () => {
  beforeEach(() => {
    fileChangedListeners = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls watchFile on mount and unwatchFile on unmount', () => {
    const onChanged = vi.fn();
    const { unmount } = renderHook(() => useReferenceWatcher('/path/ref.gb', onChanged));
    expect(platform().fs.watchFile).toHaveBeenCalledWith('/path/ref.gb');
    unmount();
    expect(platform().fs.unwatchFile).toHaveBeenCalledWith('/path/ref.gb');
  });

  it('fires callback when file-changed event matches path', () => {
    const onChanged = vi.fn();
    renderHook(() => useReferenceWatcher('/path/ref.gb', onChanged));

    for (const listener of fileChangedListeners) {
      listener('/path/ref.gb');
    }

    expect(onChanged).toHaveBeenCalled();
  });

  it('does NOT fire callback for different file path', () => {
    const onChanged = vi.fn();
    renderHook(() => useReferenceWatcher('/path/ref.gb', onChanged));

    for (const listener of fileChangedListeners) {
      listener('/path/other.gb');
    }

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('unsubscribes from file-changed events on unmount', () => {
    const onChanged = vi.fn();
    const { unmount } = renderHook(() => useReferenceWatcher('/path/ref.gb', onChanged));

    expect(fileChangedListeners.length).toBe(1);
    unmount();
    expect(fileChangedListeners.length).toBe(0);
  });

  it('does not watch when referencePath is empty', () => {
    const onChanged = vi.fn();
    renderHook(() => useReferenceWatcher('', onChanged));
    expect(platform().fs.watchFile).not.toHaveBeenCalled();
    expect(fileChangedListeners.length).toBe(0);
  });

  it('uses latest callback via ref (no stale closure)', () => {
    let callCount = 0;
    const callback1 = vi.fn(() => callCount++);
    const callback2 = vi.fn(() => callCount++);

    const { rerender } = renderHook(({ cb }) => useReferenceWatcher('/path/ref.gb', cb), {
      initialProps: { cb: callback1 },
    });

    rerender({ cb: callback2 });

    for (const listener of fileChangedListeners) {
      listener('/path/ref.gb');
    }

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalled();
  });
});
