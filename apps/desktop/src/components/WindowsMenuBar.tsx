import { INTERACTION_CLASS } from '@waypoint/ui-components';
import { usePresentationListener } from '../presentation/PresentationSurface';
import { userMessageWithValues, userMessageValue, toUserMessage } from '@waypoint/user-messages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { platform } from '../platform';
import { WINDOWS_MENU_IDS, type WindowsMenuId } from '../shared/window-menu';
import { safeFocus } from '../shared/utils/safeFocus';

export function WindowsMenuBar() {
  const presentationEvents = usePresentationListener();

  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const altOnly = useRef(false);
  const activeRequest = useRef(0);
  const openMenu = useRef<WindowsMenuId | null>(null);
  const lastClosed = useRef<{ menu: WindowsMenuId; at: number } | null>(null);
  const [focused, setFocused] = useState(0);
  const [open, setOpen] = useState<WindowsMenuId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const focusMenu = useCallback((index: number) => {
    const active = document.activeElement as HTMLElement | null;
    if (active && !buttons.current.includes(active as HTMLButtonElement)) {
      previousFocus.current = active;
    }
    setFocused(index);
    safeFocus(buttons.current[index]);
  }, []);

  const showMenu = useCallback((index: number) => {
    const button = buttons.current[index];
    if (!button) return;
    const menuId = WINDOWS_MENU_IDS[index];
    const rect = button.getBoundingClientRect();
    if (buttons.current.includes(document.activeElement as HTMLButtonElement)) {
      safeFocus(previousFocus.current);
    }
    const request = ++activeRequest.current;
    openMenu.current = openMenu.current === menuId ? null : menuId;
    setOpen(openMenu.current);
    setError(null);
    void platform()
      .window.showMenu(menuId, { x: rect.left, y: rect.bottom })
      .catch(() => {
        if (activeRequest.current === request)
          setError(userMessageWithValues('menu.openFailed', { name: userMessageValue(menuId) }));
      })
      .finally(() => {
        if (activeRequest.current !== request) return;
        lastClosed.current = { menu: menuId, at: performance.now() };
        openMenu.current = null;
        setOpen(null);
      });
  }, []);

  useEffect(() => {
    const toggleFocus = () => {
      if (buttons.current.includes(document.activeElement as HTMLButtonElement)) {
        safeFocus(previousFocus.current);
      } else {
        previousFocus.current = document.activeElement as HTMLElement | null;
        focusMenu(0);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof Element && event.target.closest('[data-terminal-surface]'))
      ) {
        altOnly.current = false;
        return;
      }
      if (event.key === 'Alt' && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        altOnly.current = true;
        event.preventDefault();
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        altOnly.current = false;
        const index = WINDOWS_MENU_IDS.findIndex(
          (id) => id[0].toLowerCase() === event.key.toLowerCase()
        );
        if (index !== -1) {
          event.preventDefault();
          focusMenu(index);
          showMenu(index);
        }
      } else if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        toggleFocus();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-terminal-surface]')) {
        altOnly.current = false;
        return;
      }
      if (event.key === 'Alt' && altOnly.current) {
        event.preventDefault();
        altOnly.current = false;
        toggleFocus();
      }
    };
    presentationEvents.add(window, 'keydown', onKeyDown);
    presentationEvents.add(window, 'keyup', onKeyUp);
    return () => {
      presentationEvents.remove(window, 'keydown', onKeyDown);
      presentationEvents.remove(window, 'keyup', onKeyUp);
    };
  }, [focusMenu, showMenu, presentationEvents]);

  return (
    <nav
      role="menubar"
      aria-label="Application menu"
      data-testid="windows-menu-bar"
      className="flex flex-shrink-0 items-center gap-0.5"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onKeyDown={(event) => {
        if (event.altKey) return;
        const index = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
        if (index < 0) return;
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          focusMenu((index + (event.key === 'ArrowRight' ? 1 : 4)) % WINDOWS_MENU_IDS.length);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          focusMenu(event.key === 'Home' ? 0 : WINDOWS_MENU_IDS.length - 1);
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          showMenu(index);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          safeFocus(previousFocus.current);
        }
      }}
    >
      {WINDOWS_MENU_IDS.map((id, index) => (
        <button
          key={id}
          ref={(button) => {
            buttons.current[index] = button;
          }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === id}
          tabIndex={index === focused ? 0 : -1}
          onFocus={(event) => {
            if (
              event.relatedTarget instanceof HTMLElement &&
              !buttons.current.includes(event.relatedTarget as HTMLButtonElement)
            ) {
              previousFocus.current = event.relatedTarget;
            }
            setFocused(index);
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            if (lastClosed.current?.menu === id && event.timeStamp <= lastClosed.current.at) return;
            if (event.button === 0) showMenu(index);
          }}
          onClick={(event) => {
            if (event.detail === 0) showMenu(index);
          }}
          className={`h-6 rounded px-2 text-xs text-fg ${INTERACTION_CLASS} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${open === id ? 'bg-bg-muted' : ''}`}
          title={`${id} (Alt+${id[0]})`}
        >
          {id}
        </button>
      ))}
      {error && (
        <span role="alert" className="text-xs text-error">
          {toUserMessage(error, 'operation.failed')}
        </span>
      )}
    </nav>
  );
}
