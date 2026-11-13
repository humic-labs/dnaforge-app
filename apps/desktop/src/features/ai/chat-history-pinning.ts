import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const AI_HISTORY_PINNED_KEY = 'waypoint:ai-history-pinned';
const AI_HISTORY_PINNED_EVENT = 'waypoint:ai-history-pinned-change';

export function readChatHistoryPinned(): boolean {
  try {
    return localStorage.getItem(AI_HISTORY_PINNED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeChatHistoryPinned(pinned: boolean): void {
  try {
    localStorage.setItem(AI_HISTORY_PINNED_KEY, pinned ? 'true' : 'false');
  } catch {}
  window.dispatchEvent(new CustomEvent<boolean>(AI_HISTORY_PINNED_EVENT, { detail: pinned }));
}

export function useChatHistoryPinned(isOpen = true): [boolean, (pinned: boolean) => void] {
  const [pinned, setPinned] = useState(readChatHistoryPinned);
  const wasOpen = useRef(isOpen);

  useLayoutEffect(() => {
    if (wasOpen.current && !isOpen) {
      setPinned(false);
      writeChatHistoryPinned(false);
    }
    wasOpen.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    const handlePinnedChange = (event: Event): void => {
      setPinned((event as CustomEvent<boolean>).detail);
    };
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === AI_HISTORY_PINNED_KEY) setPinned(event.newValue === 'true');
    };
    window.addEventListener(AI_HISTORY_PINNED_EVENT, handlePinnedChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(AI_HISTORY_PINNED_EVENT, handlePinnedChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updatePinned = useCallback((nextPinned: boolean) => {
    setPinned(nextPinned);
    writeChatHistoryPinned(nextPinned);
  }, []);

  return [pinned, updatePinned];
}
