import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import { useCanvasStore } from '../store';
import {
  useCommandRegistry,
  useCommandScope,
  COMMAND_IDS,
  COMMAND_SCOPES,
} from '../../../commands';
import { resolveTabWorkspacePath, useTabMenuPanels } from '../tab-menu-presentation';
import { useMenuAim } from '@waypoint/ui-components';
import { requestTabsClose } from '../artifact-document-lifecycle';
import { useTabRegistryNavigation } from '../tab-registry-navigation';

interface TabContextMenuProps {
  position: { x: number; y: number };
  tabId: string;
  panelId: string;
  onClose: () => void;
  onSelectTab?: (tabId: string) => void;
  onStartRename?: (tabId: string) => void;

  onRenameManagedSequence?: (tabId: string) => void;
}

export function TabContextMenu({
  position,
  tabId,
  panelId,
  onClose,
  onSelectTab,
  onStartRename,
  onRenameManagedSequence,
}: TabContextMenuProps) {
  useCommandScope(COMMAND_SCOPES.menuContext, { claimOnMount: true });
  const menuRef = useRef<HTMLDivElement>(null);
  const mergeSubmenuRef = useRef<HTMLDivElement>(null);
  const [showMergeSubmenu, setShowMergeSubmenu] = useState(false);
  const menuAim = useMenuAim();
  const registry = useTabRegistryNavigation(panelId, tabId);

  const panels = useTabMenuPanels();
  const joinAllPanels = useCanvasStore((s) => s.joinAllPanels);
  const mergePanels = useCanvasStore((s) => s.mergePanels);
  const splitAndMoveTab = useCanvasStore((s) => s.splitAndMoveTab);

  const { dispatchCommand } = useCommandRegistry();

  const panel = panels[panelId];
  const tabs = panel?.tabs ?? [];
  const tabIndex = tabs.findIndex((t) => t.id === tabId);
  const tab = tabs[tabIndex];
  const panelCount = Object.keys(panels).length;

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

  if (!tab) return null;

  const hasOtherTabs = tabs.length > 1;
  const hasTabsToRight = tabIndex < tabs.length - 1;
  const hasSavedTabs = tabs.some((t) => !t.isDirty);
  const canShowInWorkspace = tab.canRevealInWorkspace;

  const getPanelLabel = (p: (typeof panels)[string]): string => {
    if (p.tabs.length === 0) return 'Empty pane';
    if (p.tabs.length === 1) return p.tabs[0].label;
    return `${p.tabs[0].label} (+${p.tabs.length - 1})`;
  };

  const handleMerge = (targetPanelId: string) => {
    mergePanels(panelId, targetPanelId);
    onClose();
  };

  const canRenameInline = tab.type === 'page' && !!onStartRename;
  const canRenameInMetadata = tab.canRenameManagedSequence && !!onRenameManagedSequence;
  const canRename = canRenameInline || canRenameInMetadata;

  const actions = [
    {
      id: 'close',
      label: 'Close',
      onClick: () => {
        requestTabsClose(panelId, [tabId]);
        onClose();
      },
      disabled: false,
    },
    {
      id: 'rename',
      label: 'Rename',
      onClick: () => {
        if (canRenameInMetadata) {
          onSelectTab?.(tabId);
          onRenameManagedSequence?.(tabId);
        } else {
          onStartRename?.(tabId);
        }
        onClose();
      },
      disabled: !canRename,
    },
    {
      id: 'reveal-in-sidebar',
      label: 'Show in Project',
      onClick: () => {
        void resolveTabWorkspacePath(panelId, tabId)
          .then((path) => {
            if (!path) return;
            dispatchCommand(COMMAND_IDS.workspaceRevealPath, { payload: { path } });
          })
          .catch((err) => {
            console.warn('[TabContextMenu] Failed to reveal document:', err);
          })
          .finally(onClose);
      },
      disabled: !canShowInWorkspace,
    },
    ...(registry.canReveal || registry.error
      ? [
          {
            id: 'show-in-registry',
            label: 'Show in Registry',
            disabled: !registry.canReveal || registry.opening,
            onClick: () => {
              void registry.reveal().then((opened) => {
                if (opened) onClose();
              });
            },
          },
        ]
      : []),
    ...(registry.canOpenMetadata && !registry.usesEmbeddedMetadata
      ? [
          {
            id: 'metadata',
            label: 'Metadata',
            disabled: registry.opening,
            onClick: () => {
              registry.openMetadata();
              onClose();
            },
          },
        ]
      : []),
    {
      id: 'close-others',
      label: 'Close other tabs in this pane',
      onClick: () => {
        requestTabsClose(
          panelId,
          tabs.filter((candidate) => candidate.id !== tabId).map((candidate) => candidate.id)
        );
        onClose();
      },
      disabled: !hasOtherTabs,
    },
    {
      id: 'close-right',
      label: 'Close to the right',
      onClick: () => {
        requestTabsClose(
          panelId,
          tabs.slice(tabIndex + 1).map((candidate) => candidate.id)
        );
        onClose();
      },
      disabled: !hasTabsToRight,
    },
    {
      id: 'divider-1',
      divider: true,
    },
    {
      id: 'split-right',
      label: 'Split Right',
      onClick: () => {
        splitAndMoveTab(panelId, 'right', panelId, tabId);
        onClose();
      },
      disabled: tabs.length <= 1,
    },
    {
      id: 'split-down',
      label: 'Split Down',
      onClick: () => {
        splitAndMoveTab(panelId, 'down', panelId, tabId);
        onClose();
      },
      disabled: tabs.length <= 1,
    },
    {
      id: 'divider-2',
      divider: true,
    },
    {
      id: 'close-saved',
      label: 'Close Saved',
      onClick: () => {
        requestTabsClose(
          panelId,
          tabs.filter((candidate) => !candidate.isDirty).map((candidate) => candidate.id)
        );
        onClose();
      },
      disabled: !hasSavedTabs,
    },
    {
      id: 'close-all',
      label: 'Close All',
      onClick: () => {
        requestTabsClose(
          panelId,
          tabs.map((candidate) => candidate.id)
        );
        onClose();
      },
      disabled: false,
    },
    {
      id: 'divider-3',
      divider: true,
    },
    {
      id: 'join-all-panels',
      label: 'Join All Panes',
      onClick: () => {
        joinAllPanels();
        onClose();
      },
      disabled: panelCount <= 1,
    },
    {
      id: 'merge-pane',
      label: 'Merge pane with...',
      hasSubmenu: true,
      disabled: !hasOtherPanels,
    },
  ] as const;

  const menuWidth = 220;
  const menuHeight = 200;
  const adjustedX = Math.min(position.x, window.innerWidth - menuWidth - 8);
  const adjustedY = Math.min(position.y, window.innerHeight - menuHeight - 8);

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[200px] py-1 bg-bg border border-border rounded-md shadow-lg"
      style={{
        left: adjustedX,
        top: adjustedY,
      }}
      data-testid="tab-context-menu"
      onPointerLeave={() => menuAim.activateImmediately(() => setShowMergeSubmenu(false))}
    >
      {registry.error ? (
        <p role="alert" className="max-w-[220px] px-3 py-1.5 text-xs text-error">
          {toUserMessage(registry.error, 'operation.failed')}
        </p>
      ) : null}
      {actions.map((action) =>
        'divider' in action ? (
          <div key={action.id} className="my-1 border-t border-border" />
        ) : 'hasSubmenu' in action ? (
          <div
            key={action.id}
            className="relative group"
            onPointerEnter={(event) =>
              menuAim.requestActivation({
                pointer: event,
                submenuElement: mergeSubmenuRef.current,
                activate: () => setShowMergeSubmenu(true),
              })
            }
          >
            <button
              disabled={action.disabled}
              aria-haspopup="menu"
              aria-expanded={showMergeSubmenu && hasOtherPanels}
              onFocus={() => menuAim.activateImmediately(() => setShowMergeSubmenu(true))}
              className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
                action.disabled
                  ? 'text-fg-subtle cursor-not-allowed'
                  : showMergeSubmenu
                    ? 'bg-bg-subtle text-fg'
                    : 'text-fg hover:bg-bg-subtle'
              }`}
            >
              <span>{action.label}</span>
              <svg className="w-3 h-3 ml-4 opacity-50" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {showMergeSubmenu && hasOtherPanels && (
              <div
                ref={mergeSubmenuRef}
                role="menu"
                onPointerEnter={menuAim.cancelPendingActivation}
                className="absolute top-0 left-full -ml-px min-w-[160px] py-1 bg-bg border border-border rounded-md shadow-lg"
              >
                {otherPanels.map(([id, p]) => (
                  <button
                    key={id}
                    onClick={() => handleMerge(id)}
                    className="w-full flex items-center px-3 py-1.5 text-xs text-left text-fg hover:bg-bg-subtle transition-colors"
                  >
                    <span className="truncate">{getPanelLabel(p)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={action.id}
            onClick={action.onClick}
            disabled={action.disabled}
            onPointerEnter={(event) => {
              if (!showMergeSubmenu) return;
              menuAim.requestActivation({
                pointer: event,
                submenuElement: mergeSubmenuRef.current,
                activate: () => setShowMergeSubmenu(false),
              });
            }}
            className={`w-full flex items-center justify-between px-3 py-1.5 text-xs text-left transition-colors ${
              action.disabled ? 'text-fg-subtle cursor-not-allowed' : 'text-fg hover:bg-bg-subtle'
            }`}
          >
            <span>{action.label}</span>
          </button>
        )
      )}
    </div>
  );
}
