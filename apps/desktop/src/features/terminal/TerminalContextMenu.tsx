import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../presentation/PresentationSurface';
import { safeFocus } from '../../shared/utils/safeFocus';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface TerminalMenuAction {
  label: string;
  disabled?: boolean;
  run(): void;
}
export function TerminalContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: TerminalMenuAction[];
  onClose(): void;
}) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const bounds = menu.current?.getBoundingClientRect();
    if (bounds)
      setPosition({
        x: Math.max(0, Math.min(x, window.innerWidth - bounds.width)),
        y: Math.max(0, Math.min(y, window.innerHeight - bounds.height)),
      });
    safeFocus(menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'));
  }, [x, y]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = Array.from(
          menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
        );
        const index = buttons.findIndex((button) => button === document.activeElement);
        safeFocus(
          buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]
        );
      }
    };
    document.addEventListener('pointerdown', close);
    presentationEvents.add(document, 'keydown', keyboard);
    return () => {
      document.removeEventListener('pointerdown', close);
      presentationEvents.remove(document, 'keydown', keyboard);
    };
  }, [onClose, presentationEvents]);
  return createPortal(
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        ref={presentationOverlay.bindRef(menu, '0')}
        role="menu"
        aria-label="Terminal actions"
        className="dnaforge-terminal-context-menu bg-bg text-fg"
        style={{ left: position.x, top: position.y }}
      >
        {actions.map((action) => (
          <button
            key={action.label}
            role="menuitem"
            disabled={action.disabled}
            onClick={() => {
              onClose();
              action.run();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </PresentationScopeContext.Provider>,
    document.body
  );
}
