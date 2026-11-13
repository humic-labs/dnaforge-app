import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readChatHistoryPinned,
  useChatHistoryPinned,
  writeChatHistoryPinned,
} from './chat-history-pinning';

describe('chat history pin preference', () => {
  beforeEach(() => localStorage.removeItem('waypoint:ai-history-pinned'));
  afterEach(() => localStorage.removeItem('waypoint:ai-history-pinned'));

  it('persists the preference and synchronizes every mounted chat in the same window', () => {
    const first = renderHook(() => useChatHistoryPinned());
    const second = renderHook(() => useChatHistoryPinned());
    expect(first.result.current[0]).toBe(false);
    expect(second.result.current[0]).toBe(false);

    act(() => first.result.current[1](true));
    expect(readChatHistoryPinned()).toBe(true);
    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(true);

    act(() => writeChatHistoryPinned(false));
    expect(first.result.current[0]).toBe(false);
    expect(second.result.current[0]).toBe(false);
  });

  it('accepts a cross-window storage update', () => {
    const hook = renderHook(() => useChatHistoryPinned());
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'waypoint:ai-history-pinned',
          newValue: 'true',
        })
      );
    });
    expect(hook.result.current[0]).toBe(true);
  });
});
