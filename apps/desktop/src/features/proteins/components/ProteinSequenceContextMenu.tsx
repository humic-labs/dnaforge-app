import { usePresentationListener } from '../../../presentation/PresentationSurface';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clampFixedMenuPosition } from '@waypoint/ui-components';

export interface ProteinSequenceContextMenuProps {
  x: number;
  y: number;
  isOpen: boolean;
  onClose: () => void;
  hasSelection: boolean;
  readOnly?: boolean;
  onCopySequence: () => void;
  onBacktranslate: () => void;
  onAskAI: () => void;
  onViewStructure: () => void;
  onPredictStructure: () => void;
}

export function ProteinSequenceContextMenu({
  x,
  y,
  isOpen,
  onClose,
  hasSelection,
  readOnly = false,
  onCopySequence,
  onBacktranslate,
  onAskAI,
  onViewStructure,
  onPredictStructure,
}: ProteinSequenceContextMenuProps) {
  const presentationEvents = usePresentationListener();

  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside, true);
    presentationEvents.add(document, 'keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
      presentationEvents.remove(document, 'keydown', handleEscape, true);
    };
  }, [isOpen, onClose, presentationEvents]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const rect = menuRef.current?.getBoundingClientRect();
    setAdjustedPosition(
      clampFixedMenuPosition({
        x,
        y,
        menuWidth: rect?.width ?? 200,
        menuHeight: rect?.height ?? 180,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        padding: 10,
      })
    );
  }, [x, y, isOpen]);

  const handleItemClick = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  if (!isOpen) return null;
  const menuHost = typeof document === 'undefined' ? null : document.body;

  const scopeLabel = hasSelection ? 'selection' : 'sequence';

  const menu = (
    <div
      ref={menuRef}
      data-testid="protein-sequence-context-menu"
      style={{
        position: 'fixed',
        left: adjustedPosition.x,
        top: adjustedPosition.y,
        zIndex: 10000,
      }}
      className="min-w-[200px] rounded-md border border-border bg-bg-subtle py-1 shadow-xl"
    >
      <button
        type="button"
        data-testid="protein-menu-copy-sequence"
        onClick={() => handleItemClick(onCopySequence)}
        className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-muted"
      >
        Copy {scopeLabel === 'selection' ? 'Selection' : 'Sequence'}
      </button>
      {!readOnly && (
        <>
          <button
            type="button"
            data-testid="protein-menu-backtranslate"
            onClick={() => handleItemClick(onBacktranslate)}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-muted"
          >
            Backtranslate {scopeLabel === 'selection' ? 'selection' : ''}…
          </button>
          <button
            type="button"
            data-testid="protein-menu-view-structure"
            onClick={() => handleItemClick(onViewStructure)}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-muted"
          >
            View Structure
          </button>
          <button
            type="button"
            data-testid="protein-menu-predict-structure"
            onClick={() => handleItemClick(onPredictStructure)}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-muted"
          >
            Predict Structure…
          </button>
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            data-testid="protein-menu-ask-ai"
            onClick={() => handleItemClick(onAskAI)}
            className="flex w-full items-center px-3 py-1.5 text-left text-sm font-medium text-[hsl(38,92%,48%)] hover:bg-bg-muted"
          >
            Ask AI about this protein
          </button>
        </>
      )}
    </div>
  );

  return menuHost ? createPortal(menu, menuHost) : menu;
}
