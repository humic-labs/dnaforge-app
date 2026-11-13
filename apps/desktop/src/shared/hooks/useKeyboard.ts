import { usePresentationListener } from '../../presentation/PresentationSurface';
import { useEffect, useRef } from 'react';

interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  cmd?: boolean;
  shift?: boolean;
  alt?: boolean;
  handler: () => void;
  preventDefault?: boolean;
  allowInInput?: boolean;
}

export function useKeyboard(shortcuts: KeyboardShortcut[]) {
  const presentationEvents = usePresentationListener();

  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.defaultPrevented ||
        (target instanceof Element && target.closest('[data-terminal-surface]'))
      )
        return;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      for (const shortcut of shortcutsRef.current) {
        if (isInInput && !shortcut.allowInInput && event.key !== 'Escape') {
          continue;
        }
        const keyFromCode = event.code.replace('Key', '').toLowerCase();
        const keyMatches =
          event.key.toLowerCase() === shortcut.key.toLowerCase() ||
          (shortcut.alt && keyFromCode === shortcut.key.toLowerCase());

        const ctrlMatches = !shortcut.ctrl || event.ctrlKey;
        const metaMatches = !shortcut.meta || event.metaKey;
        const cmdMatches = !shortcut.cmd || event.metaKey || event.ctrlKey;
        const shiftMatches = !shortcut.shift || event.shiftKey;
        const altMatches = !shortcut.alt || event.altKey;

        if (keyMatches && ctrlMatches && metaMatches && cmdMatches && shiftMatches && altMatches) {
          if (shortcut.preventDefault !== false) {
            event.preventDefault();
          }
          shortcut.handler();
          return;
        }
      }
    };

    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [presentationEvents]);
}
