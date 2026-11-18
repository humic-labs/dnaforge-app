import {
  ActionMenu,
  type ActionMenuEntry,
  type ActionMenuInvocation,
} from '../../../components/ActionMenu';
import { toUserMessage } from '@waypoint/user-messages';
import { useCanvasStore } from '../store';
import { useCommandRegistry, COMMAND_IDS } from '../../../commands';
import { resolveTabWorkspacePath, useTabMenuPanels } from '../tab-menu-presentation';
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

  const canRenameInline = tab.type === 'page' && !!onStartRename;
  const canRenameInMetadata = tab.canRenameManagedSequence && !!onRenameManagedSequence;
  const canRename = canRenameInline || canRenameInMetadata;

  const actions: ActionMenuEntry[] = [
    {
      id: 'close',
      label: 'Close',
      onSelect: () => {
        requestTabsClose(panelId, [tabId]);
      },
      disabled: false,
    },
    {
      id: 'rename',
      label: 'Rename',
      onSelect: () => {
        if (canRenameInMetadata) {
          onSelectTab?.(tabId);
          onRenameManagedSequence?.(tabId);
        } else {
          onStartRename?.(tabId);
        }
      },
      disabled: !canRename,
    },
    {
      id: 'reveal-in-sidebar',
      label: 'Show in Project',
      closeOnSelect: false,
      onSelect: ({ close }: ActionMenuInvocation) => {
        void resolveTabWorkspacePath(panelId, tabId)
          .then((path) => {
            if (!path) return;
            dispatchCommand(COMMAND_IDS.workspaceRevealPath, { payload: { path } });
          })
          .catch((err) => {
            console.warn('[TabContextMenu] Failed to reveal document:', err);
          })
          .finally(() => close());
      },
      disabled: !canShowInWorkspace,
    },
    ...(registry.canReveal || registry.error
      ? [
          {
            id: 'show-in-registry',
            label: 'Show in Registry',
            closeOnSelect: false,
            disabled: !registry.canReveal || registry.opening,
            onSelect: ({ close }: ActionMenuInvocation) => {
              void registry.reveal().then((opened) => {
                if (opened) close();
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
            onSelect: () => {
              registry.openMetadata();
            },
          },
        ]
      : []),
    {
      id: 'close-others',
      label: 'Close other tabs in this pane',
      onSelect: () => {
        requestTabsClose(
          panelId,
          tabs.filter((candidate) => candidate.id !== tabId).map((candidate) => candidate.id)
        );
      },
      disabled: !hasOtherTabs,
    },
    {
      id: 'close-right',
      label: 'Close to the right',
      onSelect: () => {
        requestTabsClose(
          panelId,
          tabs.slice(tabIndex + 1).map((candidate) => candidate.id)
        );
      },
      disabled: !hasTabsToRight,
    },
    {
      id: 'divider-1',
      separator: true,
    },
    {
      id: 'split-right',
      label: 'Split Right',
      onSelect: () => {
        splitAndMoveTab(panelId, 'right', panelId, tabId);
      },
      disabled: tabs.length <= 1,
    },
    {
      id: 'split-down',
      label: 'Split Down',
      onSelect: () => {
        splitAndMoveTab(panelId, 'down', panelId, tabId);
      },
      disabled: tabs.length <= 1,
    },
    {
      id: 'divider-2',
      separator: true,
    },
    {
      id: 'close-saved',
      label: 'Close Saved',
      onSelect: () => {
        requestTabsClose(
          panelId,
          tabs.filter((candidate) => !candidate.isDirty).map((candidate) => candidate.id)
        );
      },
      disabled: !hasSavedTabs,
    },
    {
      id: 'close-all',
      label: 'Close All',
      onSelect: () => {
        requestTabsClose(
          panelId,
          tabs.map((candidate) => candidate.id)
        );
      },
      disabled: false,
    },
    {
      id: 'divider-3',
      separator: true,
    },
    {
      id: 'join-all-panels',
      label: 'Join All Panes',
      onSelect: () => {
        joinAllPanels();
      },
      disabled: panelCount <= 1,
    },
    {
      id: 'merge-pane',
      label: 'Merge pane with...',
      disabled: !hasOtherPanels,
      children: otherPanels.map(([id, panel]) => ({
        id,
        label: getPanelLabel(panel),
        onSelect: () => mergePanels(panelId, id),
      })),
    },
  ];

  return (
    <ActionMenu
      open
      label="Tab actions"
      entries={actions}
      anchorPoint={position}
      onClose={onClose}
      testId="tab-context-menu"
      header={
        registry.error ? (
          <p role="alert" className="max-w-[220px] px-3 py-1.5 text-xs text-error">
            {toUserMessage(registry.error, 'operation.failed')}
          </p>
        ) : undefined
      }
    />
  );
}
