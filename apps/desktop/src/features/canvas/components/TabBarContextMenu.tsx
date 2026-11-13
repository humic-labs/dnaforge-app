import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../store';
import { useTabMenuPanels } from '../tab-menu-presentation';
import { useMenuAim } from '@waypoint/ui-components';

interface TabBarContextMenuProps {
  position: { x: number; y: number };
  panelId: string;
  onClose: () => void;
}

export function TabBarContextMenu({ position, panelId, onClose }: TabBarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const [showSubmenu, setShowSubmenu] = useState(false);
  const menuAim = useMenuAim();

  const panels = useTabMenuPanels();
  const mergePanels = useCanvasStore((s) => s.mergePanels);

  const otherPanels = Object.entries(panels).filter(([id]) => id !== panelId);
  const hasOtherPanels = otherPanels.length > 0;

  useEffect(() => {
    let listenersAdded = false;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
      listenersAdded = true;
    }, 0);

    return () => {
      clearTimeout(timer);
      if (listenersAdded) {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleEscape);
      }
    };
  }, [onClose]);

  const handleMerge = (targetPanelId: string) => {
    mergePanels(panelId, targetPanelId);
    onClose();
  };

  const getPanelLabel = (panel: (typeof panels)[string]): string => {
    if (panel.tabs.length === 0) return 'Empty pane';
    if (panel.tabs.length === 1) return panel.tabs[0].label;
    return `${panel.tabs[0].label} (+${panel.tabs.length - 1})`;
  };

  const menuWidth = 200;
  const submenuWidth = 180;
  const menuHeight = 40;
  const adjustedX = Math.min(position.x, window.innerWidth - menuWidth - submenuWidth - 16);
  const adjustedY = Math.min(position.y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] py-1 bg-bg border border-border rounded-md shadow-lg"
      style={{
        left: adjustedX,
        top: adjustedY,
      }}
      data-testid="tabbar-context-menu"
      onPointerLeave={() => menuAim.activateImmediately(() => setShowSubmenu(false))}
    >
      <div
        className="relative"
        onPointerEnter={(event) =>
          menuAim.requestActivation({
            pointer: event,
            submenuElement: submenuRef.current,
            activate: () => setShowSubmenu(true),
          })
        }
      >
        <button
          disabled={!hasOtherPanels}
          aria-haspopup="menu"
          aria-expanded={showSubmenu && hasOtherPanels}
          onFocus={() => menuAim.activateImmediately(() => setShowSubmenu(true))}
          className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
            !hasOtherPanels
              ? 'text-fg-subtle cursor-not-allowed'
              : showSubmenu
                ? 'bg-bg-subtle text-fg'
                : 'text-fg hover:bg-bg-subtle'
          }`}
        >
          <span>Merge tabs with...</span>
          <svg className="w-3 h-3 ml-4 opacity-50" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
              clipRule="evenodd"
            />
          </svg>
        </button>

        {showSubmenu && hasOtherPanels && (
          <div
            ref={submenuRef}
            role="menu"
            onPointerEnter={menuAim.cancelPendingActivation}
            className="absolute top-0 left-full -ml-px min-w-[160px] py-1 bg-bg border border-border rounded-md shadow-lg"
          >
            {otherPanels.map(([id, panel]) => (
              <button
                key={id}
                onClick={() => handleMerge(id)}
                className="w-full flex items-center px-3 py-1.5 text-xs text-left text-fg hover:bg-bg-subtle transition-colors"
              >
                <span className="truncate">{getPanelLabel(panel)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
