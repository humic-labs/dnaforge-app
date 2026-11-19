import { useCallback, type ReactNode } from 'react';
import type { FolderGitState } from '../hooks/useFolderGitState';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';
import { formatShortcutHint, type ShortcutDefinition } from './menuShortcuts';
import { shortcutChord } from '../keyboard/shortcutRegistry';

interface FileContextMenuProps {
  position: { x: number; y: number };
  displayName: string;
  onCopyPath: () => void;
  onCopyRelativePath?: () => void;
  onRevealInFinder: () => void;
  onOpenInTerminal?: () => void;
  isDirectory: boolean;
  isRootFolder: boolean;

  gitState?: FolderGitState;

  onInitGit?: () => void;

  gitInitInProgress?: boolean;
  onClose: () => void;
  onOpen?: () => void;
  checkBeforeOpen?: boolean;
  onOpenInNewPanel?: () => void;
  onRename?: () => void;

  onDuplicate?: () => void;

  onMoveTo?: () => void;

  pinnedRoot?: boolean;
  onRemoveFromWorkspace?: () => void;

  onRenameProject?: () => void;

  onArchiveProject?: () => void;

  onTrashProject?: () => void;

  onProjectHistory?: () => void;
  onDelete?: () => void;
  onNewNotebook?: () => void;
  onNewAssembly?: () => void;
  onNewTextFile?: () => void;
  onNewFolder?: () => void;

  newMenuEntries?: readonly ActionMenuEntry[];
  newMenuHeader?: ReactNode;
  newMenuLabel?: string;
  newMenuDataAttributes?: Record<`data-${string}`, string | undefined>;
  onFindInFolder?: () => void;
  onCollapseOthers?: () => void;
}

interface BaseMenuItem {
  id: string;
  label: string;
  shortcut?: ShortcutDefinition;
  isDestructive?: boolean;
  disabled?: boolean;
  show?: boolean;
}

interface ActionMenuItem extends BaseMenuItem {
  action: () => void;
}

interface CascadeMenuItem extends BaseMenuItem {
  opensCascade: true;
}

interface SubmenuItem extends BaseMenuItem {
  submenu: ActionMenuItem[];
}

type MenuItem = ActionMenuItem | CascadeMenuItem | SubmenuItem;
type MenuEntry = MenuItem | 'separator';

function isCascadeItem(item: MenuItem): item is CascadeMenuItem {
  return 'opensCascade' in item;
}

function isSubmenuItem(item: MenuItem): item is SubmenuItem {
  return 'submenu' in item;
}

export function FileContextMenu({
  position,
  displayName,
  onCopyPath,
  onCopyRelativePath,
  onRevealInFinder,
  onOpenInTerminal,
  isDirectory,
  isRootFolder,
  gitState,
  onInitGit,
  gitInitInProgress,
  onClose,
  onOpen,
  checkBeforeOpen,
  onOpenInNewPanel,
  onRename,
  onDuplicate,
  onMoveTo,
  pinnedRoot,
  onRemoveFromWorkspace,
  onRenameProject,
  onArchiveProject,
  onTrashProject,
  onProjectHistory,
  onDelete,
  onNewNotebook,
  onNewAssembly,
  onNewTextFile,
  onNewFolder,
  newMenuEntries,
  newMenuHeader,
  newMenuLabel,
  newMenuDataAttributes,
  onFindInFolder,
  onCollapseOthers,
}: FileContextMenuProps) {
  const getMenuItems = useCallback((): MenuEntry[] => {
    const items: MenuEntry[] = [];

    if (onOpen) {
      items.push({
        id: 'open',
        label: checkBeforeOpen ? 'Check and Open' : 'Open',
        shortcut: shortcutChord('files.open'),
        action: onOpen,
      });
    }

    if (!isDirectory && !checkBeforeOpen && onOpenInNewPanel) {
      items.push({
        id: 'open-panel',
        label: 'Open in New Panel',
        shortcut: shortcutChord('files.open-in-new-panel'),
        action: onOpenInNewPanel,
      });
    }

    if (items.length > 0) items.push('separator');

    if (onNewFolder) {
      items.push({
        id: 'new-folder',
        label: 'New Folder',
        shortcut: shortcutChord('files.new-folder'),
        action: onNewFolder,
      });
    }

    const newFileItems: ActionMenuItem[] = [];
    if (onNewNotebook && !newMenuEntries) {
      newFileItems.push({
        id: 'new-notebook',
        label: 'Notebook Entry',
        action: onNewNotebook,
      });
    }
    if (onNewAssembly && !newMenuEntries) {
      newFileItems.push({
        id: 'new-assembly',
        label: 'Assembly',
        action: onNewAssembly,
      });
    }
    if (onNewTextFile) {
      newFileItems.push({
        id: 'new-text',
        label: 'Text File',
        action: onNewTextFile,
      });
    }

    if (newMenuEntries) {
      items.push({
        id: 'new-entity',
        label: 'New…',
        opensCascade: true,
      });
      items.push(...newFileItems);
    } else if (newFileItems.length > 0) {
      items.push({
        id: 'new-files',
        label: 'New File(s)...',
        submenu: newFileItems,
      });
    }

    if (isDirectory && onFindInFolder) {
      items.push({
        id: 'find-folder',
        label: 'Find in Folder...',
        action: onFindInFolder,
      });
    }

    if (isDirectory && onCollapseOthers) {
      items.push({
        id: 'collapse-others',
        label: isRootFolder ? 'Collapse Other Projects' : 'Collapse Other Folders',
        action: onCollapseOthers,
      });
    }

    if (
      onNewFolder ||
      newMenuEntries ||
      newFileItems.length > 0 ||
      (isDirectory && (onFindInFolder || onCollapseOthers))
    ) {
      items.push('separator');
    }

    if (onOpenInTerminal)
      items.push({
        id: 'open-terminal',
        label: 'Open in Integrated Terminal',
        action: onOpenInTerminal,
      });
    items.push({
      id: 'copy-path',
      label: 'Copy Path',
      shortcut: shortcutChord('files.copy-path'),
      action: onCopyPath,
    });

    if (onCopyRelativePath) {
      items.push({
        id: 'copy-relative-path',
        label: 'Copy Relative Path',
        shortcut: shortcutChord('files.copy-relative-path'),
        action: onCopyRelativePath,
      });
    }

    items.push({
      id: 'reveal',
      label: 'Show in folder',
      shortcut: shortcutChord('files.reveal'),
      action: onRevealInFinder,
    });

    if (onDuplicate || onRename || onMoveTo || onDelete) {
      items.push('separator');
      if (onDuplicate && !isRootFolder) {
        items.push({
          id: 'duplicate',
          label: 'Duplicate',
          action: onDuplicate,
        });
      }
      if (onRename) {
        items.push({
          id: 'rename',
          label: 'Rename',
          shortcut: shortcutChord('files.rename'),
          action: onRename,
        });
      }

      if (onMoveTo && !isRootFolder) {
        items.push({
          id: 'move',
          label: 'Move to…',
          action: onMoveTo,
        });
      }
      if (onDelete && !isRootFolder) {
        items.push({
          id: 'delete',
          label: 'Delete',
          shortcut: shortcutChord('files.move-to-trash'),
          action: onDelete,
          isDestructive: true,
        });
      }
    }

    if (isRootFolder && gitState && gitState !== 'loading' && gitState !== 'tracked') {
      items.push('separator');
      if (gitState === 'not-initialized' && onInitGit) {
        items.push({
          id: 'git-init',
          label: gitInitInProgress ? 'Initializing git repo…' : 'Initialize git repo',
          action: onInitGit,
          disabled: gitInitInProgress,
        });
      } else if (gitState === 'no-git') {
        items.push({
          id: 'git-missing',
          label: 'Git not installed (install to enable tracking)',
          action: () => {},
          disabled: true,
        });
      } else if (gitState === 'no-commits') {
        items.push({
          id: 'git-no-commits',
          label: 'No commits yet — open Source Control to commit',
          action: () => {},
          disabled: true,
        });
      }
    }

    if (isRootFolder) {
      if (pinnedRoot && onRemoveFromWorkspace) {
        items.push('separator');
        items.push({
          id: 'hide-project',
          label: 'Hide project from Files',
          shortcut: ['delete'],
          action: onRemoveFromWorkspace,
          isDestructive: true,
        });
      } else if (
        !pinnedRoot &&
        (onProjectHistory || onRenameProject || onArchiveProject || onTrashProject)
      ) {
        items.push('separator');
        if (onRenameProject) {
          items.push({ id: 'rename-project', label: 'Rename project…', action: onRenameProject });
        }
        if (onProjectHistory) {
          items.push({
            id: 'project-history',
            label: 'Project history…',
            action: onProjectHistory,
          });
        }
        if (onArchiveProject) {
          items.push({
            id: 'archive-project',
            label: 'Archive project…',
            action: onArchiveProject,
          });
        }
        if (onTrashProject) {
          items.push({
            id: 'trash-project',
            label: 'Move to Trash…',
            action: onTrashProject,
            isDestructive: true,
          });
        }
      }
    }

    return items;
  }, [
    isDirectory,
    isRootFolder,
    onOpen,
    checkBeforeOpen,
    onOpenInNewPanel,
    onCopyPath,
    onCopyRelativePath,
    onRevealInFinder,
    onOpenInTerminal,
    onRename,
    onDuplicate,
    onMoveTo,
    pinnedRoot,
    onRemoveFromWorkspace,
    onRenameProject,
    onArchiveProject,
    onTrashProject,
    onProjectHistory,
    onDelete,
    onNewNotebook,
    onNewAssembly,
    onNewTextFile,
    onNewFolder,
    newMenuEntries,
    onFindInFolder,
    onCollapseOthers,
    gitState,
    onInitGit,
    gitInitInProgress,
  ]);

  const actionEntry = (item: MenuItem): ActionMenuEntry => {
    const shortcut = formatShortcutHint(item.shortcut);
    const common = {
      id: item.id,
      label: item.label,
      disabled: item.disabled,
      tone: item.isDestructive ? ('danger' as const) : ('default' as const),
      shortcut: shortcut ? <span data-testid="context-menu-shortcut">{shortcut}</span> : undefined,
    };
    if (isSubmenuItem(item))
      return {
        ...common,
        children: item.submenu.map(actionEntry),
        submenuLabel: `${item.label} options`,
      };
    if (isCascadeItem(item))
      return {
        ...common,
        children: newMenuEntries ?? [],
        submenuHeader: newMenuHeader,
        submenuLabel: newMenuLabel ?? 'Add to project',
        submenuTestId: 'explorer-add-picker',
        submenuDataAttributes: newMenuDataAttributes,
      };
    return {
      ...common,
      closeReason:
        item.id === 'copy-path' || item.id === 'copy-relative-path' ? 'selection' : 'handoff',
      onSelect: item.action,
    };
  };
  const entries = getMenuItems().map(
    (item, index): ActionMenuEntry =>
      item === 'separator' ? { id: `separator-${index}`, separator: true } : actionEntry(item)
  );
  return (
    <ActionMenu
      open
      label={`File actions for ${displayName}`}
      entries={entries}
      anchorPoint={position}
      onClose={onClose}
    />
  );
}
