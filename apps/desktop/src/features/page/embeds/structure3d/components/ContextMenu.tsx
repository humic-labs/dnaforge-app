import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../../../../../presentation/PresentationSurface';
('use client');

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { safeFocus } from '@/shared/utils/safeFocus';
import type { ResidueLocation } from '../types';

export interface ContextMenuAction {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

interface ContextMenuProps {
  position: { x: number; y: number } | null;
  onClose: () => void;
  targetResidue: ResidueLocation | null;
  selectedResidues: ResidueLocation[];
  onCenterSelection: () => void;
  onAskAI?: () => void;
}

export function ContextMenu({
  position,
  onClose,
  targetResidue,
  selectedResidues,
  onCenterSelection,
  onAskAI,
}: ContextMenuProps) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState({ x: 8, y: 8 });
  const isOpen = Boolean(position);
  const returnFocus = useMemo(
    () => (isOpen && document.activeElement instanceof HTMLElement ? document.activeElement : null),
    [isOpen]
  );
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!position || !menu) return;
    const place = () =>
      setPlacement({
        x: Math.max(8, Math.min(position.x, window.innerWidth - menu.offsetWidth - 8)),
        y: Math.max(8, Math.min(position.y, window.innerHeight - menu.offsetHeight - 8)),
      });
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [position]);
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      const menu = menuRef.current;
      safeFocus(menu?.querySelector<HTMLElement>('button:not(:disabled)') ?? menu);
    });
    return () => {
      cancelAnimationFrame(frame);
      queueMicrotask(() => safeFocus(returnFocus, { preventScroll: true }));
    };
  }, [isOpen, returnFocus]);

  useEffect(() => {
    if (!position) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      presentationEvents.add(document, 'keydown', handleEscape);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      presentationEvents.remove(document, 'keydown', handleEscape);
    };
  }, [position, onClose, presentationEvents]);

  if (!position) return null;

  const hasSelection = selectedResidues.length > 0;
  const askLabel = askAiSelectionLabel(selectedResidues);

  const actions: ContextMenuAction[] = [
    {
      id: 'center',
      label: hasSelection ? 'Center on selection' : 'Center on residue',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"
          />
        </svg>
      ),
      onClick: () => {
        onCenterSelection();
        onClose();
      },
      disabled: !hasSelection && !targetResidue,
    },
    {
      id: 'ask-ai',
      label: askLabel,
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
      ),
      onClick: () => {
        onAskAI?.();
        onClose();
      },
      disabled: !hasSelection || !onAskAI,
    },
  ];

  return createPortal(
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        ref={presentationOverlay.bindRef(menuRef, '0')}
        role="menu"
        aria-label="Structure actions"
        tabIndex={-1}
        className="fixed z-[10050] min-w-[160px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-auto py-1 bg-bg text-fg border border-border rounded-lg shadow-lg"
        style={{
          left: placement.x,
          top: placement.y,
        }}
        data-testid="structure-context-menu"
        onKeyDown={(event) => {
          const controls = Array.from(
            menuRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []
          );
          const index = controls.indexOf(document.activeElement as HTMLElement);
          let next: number;
          switch (event.key) {
            case 'ArrowDown':
              next = (index + 1) % controls.length;
              break;
            case 'ArrowUp':
              next = (index - 1 + controls.length) % controls.length;
              break;
            case 'Home':
              next = 0;
              break;
            case 'End':
              next = controls.length - 1;
              break;
            case 'Escape':
              event.preventDefault();
              event.stopPropagation();
              onClose();
              return;
            case 'Tab':
              onClose();
              return;
            default:
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          safeFocus(controls[next]);
        }}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            onClick={action.onClick}
            disabled={action.disabled}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors focus-visible:outline-none focus-visible:bg-bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
              action.disabled ? 'text-fg-subtle cursor-not-allowed' : 'text-fg hover:bg-bg-subtle'
            }`}
          >
            {action.icon && <span className="text-fg-muted">{action.icon}</span>}
            {action.label}
          </button>
        ))}
      </div>
    </PresentationScopeContext.Provider>,
    document.body
  );
}

function askAiSelectionLabel(selectedResidues: ReadonlyArray<ResidueLocation>): string {
  if (selectedResidues.length === 0) return 'Select residues to ask AI';
  if (selectedResidues.length > 1) {
    return `Ask AI about ${selectedResidues.length} selected residues`;
  }

  const residue = selectedResidues[0];
  const identity = residue.labelCompId ?? residue.compId;
  const coordinate = identity
    ? `${residue.chain}:${identity} ${residue.position}`
    : `${residue.chain}:${residue.position}`;
  return `Ask AI about selected residue ${coordinate}`;
}
