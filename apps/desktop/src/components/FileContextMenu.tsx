import {
  usePresentationOverlay,
  PresentationScopeContext,
  usePresentationListener,
} from '../presentation/PresentationSurface';
import { useEffect, useRef, useCallback, useState } from 'react';
import type { FolderGitState } from '../hooks/useFolderGitState';
import { ChevronRightIcon } from './icons';
import { formatShortcutHint, type ShortcutDefinition } from './menuShortcuts';
import { shortcutChord } from '../keyboard/shortcutRegistry';
import { useMenuAim } from '@waypoint/ui-components';

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

  onOpenAddPicker?: (position: { x: number; y: number }) => void;

  onCloseAddPicker?: () => void;
  onFindInFolder?: () => void;
  onCollapseOthers?: () => void;
}

interface BaseMenuItem {
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

const MENU_ROW_CLASS =
  'flex min-h-7 w-full items-center justify-between gap-3 whitespace-nowrap px-3 py-1 text-left text-sm leading-5';
const MENU_ROW_INTERACTIVE_CLASS =
  'text-fg hover:bg-bg-muted focus:bg-bg-muted focus:outline-none focus-visible:outline-none';
const MENU_ROW_DISABLED_CLASS = 'cursor-default text-fg-muted';
const MENU_ROW_DESTRUCTIVE_CLASS = 'text-error hover:bg-error/10 focus:bg-error/10';
const MENU_SEPARATOR_CLASS = 'my-1 h-px bg-border';
const MENU_SHORTCUT_CLASS = 'ml-auto pl-6 text-xs tabular-nums text-fg-muted/45';

function isActionItem(item: MenuItem): item is ActionMenuItem {
  return 'action' in item;
}

function isCascadeItem(item: MenuItem): item is CascadeMenuItem {
  return 'opensCascade' in item;
}

function isSubmenuItem(item: MenuItem): item is SubmenuItem {
  return 'submenu' in item;
}

function MenuItemContents({
  label,
  shortcut,
  hasSubmenu,
}: {
  label: string;
  shortcut?: ShortcutDefinition;
  hasSubmenu?: boolean;
}) {
  const shortcutHint = formatShortcutHint(shortcut);

  return (
    <>
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-2" aria-hidden="true">
        {shortcutHint && (
          <span data-testid="context-menu-shortcut" className={MENU_SHORTCUT_CLASS}>
            {shortcutHint}
          </span>
        )}
        {hasSubmenu && <ChevronRightIcon className="w-3 h-3 text-fg-muted" />}
      </span>
    </>
  );
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
  onOpenAddPicker,
  onCloseAddPicker,
  onFindInFolder,
  onCollapseOthers,
}: FileContextMenuProps) {
  const presentationOverlay = usePresentationOverlay('keyboard');
  const presentationEvents = usePresentationListener(presentationOverlay.scope);

  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [openSubmenuLabel, setOpenSubmenuLabel] = useState<string | null>(null);
  const menuAim = useMenuAim();

  const executeAction = useCallback(
    (action: () => void) => {
      action();
      onClose();
    },
    [onClose]
  );

  const getMenuItems = useCallback((): MenuEntry[] => {
    const items: MenuEntry[] = [];

    if (onOpen) {
      items.push({
        label: 'Open',
        shortcut: shortcutChord('files.open'),
        action: onOpen,
      });
    }

    if (!isDirectory && onOpenInNewPanel) {
      items.push({
        label: 'Open in New Panel',
        shortcut: shortcutChord('files.open-in-new-panel'),
        action: onOpenInNewPanel,
      });
    }

    if (items.length > 0) items.push('separator');

    if (onNewFolder) {
      items.push({
        label: 'New Folder',
        shortcut: shortcutChord('files.new-folder'),
        action: onNewFolder,
      });
    }

    const newFileItems: ActionMenuItem[] = [];
    if (onNewNotebook && !onOpenAddPicker) {
      newFileItems.push({
        label: 'Notebook Entry',
        action: onNewNotebook,
      });
    }
    if (onNewAssembly && !onOpenAddPicker) {
      newFileItems.push({
        label: 'Assembly',
        action: onNewAssembly,
      });
    }
    if (onNewTextFile) {
      newFileItems.push({
        label: 'Text File',
        action: onNewTextFile,
      });
    }

    if (onOpenAddPicker) {
      items.push({
        label: 'New…',
        opensCascade: true,
      });
      items.push(...newFileItems);
    } else if (newFileItems.length > 0) {
      items.push({
        label: 'New File(s)...',
        submenu: newFileItems,
      });
    }

    if (isDirectory && onFindInFolder) {
      items.push({
        label: 'Find in Folder...',
        action: onFindInFolder,
      });
    }

    if (isDirectory && onCollapseOthers) {
      items.push({
        label: isRootFolder ? 'Collapse Other Projects' : 'Collapse Other Folders',
        action: onCollapseOthers,
      });
    }

    if (
      onNewFolder ||
      onOpenAddPicker ||
      newFileItems.length > 0 ||
      (isDirectory && (onFindInFolder || onCollapseOthers))
    ) {
      items.push('separator');
    }

    if (onOpenInTerminal)
      items.push({ label: 'Open in Integrated Terminal', action: onOpenInTerminal });
    items.push({
      label: 'Copy Path',
      shortcut: shortcutChord('files.copy-path'),
      action: onCopyPath,
    });

    if (onCopyRelativePath) {
      items.push({
        label: 'Copy Relative Path',
        shortcut: shortcutChord('files.copy-relative-path'),
        action: onCopyRelativePath,
      });
    }

    items.push({
      label: 'Show in folder',
      shortcut: shortcutChord('files.reveal'),
      action: onRevealInFinder,
    });

    if (onDuplicate || onRename || onMoveTo || onDelete) {
      items.push('separator');
      if (onDuplicate && !isRootFolder) {
        items.push({
          label: 'Duplicate',
          action: onDuplicate,
        });
      }
      if (onRename) {
        items.push({
          label: 'Rename',
          shortcut: shortcutChord('files.rename'),
          action: onRename,
        });
      }

      if (onMoveTo && !isRootFolder) {
        items.push({
          label: 'Move to…',
          action: onMoveTo,
        });
      }
      if (onDelete && !isRootFolder) {
        items.push({
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
          label: gitInitInProgress ? 'Initializing git repo…' : 'Initialize git repo',
          action: onInitGit,
          disabled: gitInitInProgress,
        });
      } else if (gitState === 'no-git') {
        items.push({
          label: 'Git not installed (install to enable tracking)',
          action: () => {},
          disabled: true,
        });
      } else if (gitState === 'no-commits') {
        items.push({
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
          items.push({ label: 'Rename project…', action: onRenameProject });
        }
        if (onProjectHistory) {
          items.push({ label: 'Project history…', action: onProjectHistory });
        }
        if (onArchiveProject) {
          items.push({ label: 'Archive project…', action: onArchiveProject });
        }
        if (onTrashProject) {
          items.push({ label: 'Move to Trash…', action: onTrashProject, isDestructive: true });
        }
      }
    }

    return items;
  }, [
    isDirectory,
    isRootFolder,
    onOpen,
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
    onOpenAddPicker,
    onFindInFolder,
    onCollapseOthers,
    gitState,
    onInitGit,
    gitInitInProgress,
  ]);

  const menuItems = getMenuItems();
  const actionItems = menuItems.filter((item): item is MenuItem => item !== 'separator');

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target;
      if (
        target instanceof Element &&
        target.closest('[data-file-context-linked-cascade="true"]')
      ) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const openLinkedCascade = useCallback(
    (element: HTMLElement) => {
      if (!onOpenAddPicker) return;
      const rect = element.getBoundingClientRect();
      onOpenAddPicker({ x: rect.right - 1, y: rect.top });
    },
    [onOpenAddPicker]
  );

  const getOpenSubmenuElement = useCallback((): HTMLElement | null => {
    const linkedCascade = document.querySelector<HTMLElement>(
      '[data-file-context-linked-cascade="true"]'
    );
    if (linkedCascade) return linkedCascade;
    return menuRef.current?.querySelector<HTMLElement>('[data-menu-aim-submenu="true"]') ?? null;
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    presentationEvents.add(document, 'keydown', handleKeyDown);
    return () => presentationEvents.remove(document, 'keydown', handleKeyDown);
  }, [onClose, presentationEvents]);

  const handleMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, item: MenuItem, index: number) => {
      if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && isCascadeItem(item)) {
        e.preventDefault();
        menuAim.cancelPendingActivation();
        setOpenSubmenuLabel(item.label);
        openLinkedCascade(e.currentTarget);
      } else if ((e.key === 'Enter' || e.key === ' ') && isActionItem(item)) {
        e.preventDefault();
        menuAim.cancelPendingActivation();
        executeAction(item.action);
      } else if (
        (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') &&
        isSubmenuItem(item)
      ) {
        e.preventDefault();
        menuAim.cancelPendingActivation();
        setOpenSubmenuLabel(item.label);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIndex = (index + 1) % actionItems.length;
        setFocusedIndex(nextIndex);

        const buttons = menuRef.current?.querySelectorAll('[data-context-menu-root-item="true"]');
        if (buttons && buttons[nextIndex]) {
          (buttons[nextIndex] as HTMLElement).focus();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIndex = (index - 1 + actionItems.length) % actionItems.length;
        setFocusedIndex(prevIndex);
        const buttons = menuRef.current?.querySelectorAll('[data-context-menu-root-item="true"]');
        if (buttons && buttons[prevIndex]) {
          (buttons[prevIndex] as HTMLElement).focus();
        }
      }
    },
    [actionItems.length, executeAction, menuAim, openLinkedCascade]
  );

  let actionIndex = 0;

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        ref={presentationOverlay.bindRef(menuRef, '0')}
        role="menu"
        aria-label={`File actions for ${displayName}`}
        className="fixed z-50 min-w-[280px] bg-bg-subtle border border-border rounded-md shadow-lg py-1"
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
      >
        {menuItems.map((item, index) => {
          if (item === 'separator') {
            return (
              <div key={`separator-${index}`} role="separator" className={MENU_SEPARATOR_CLASS} />
            );
          }

          const currentActionIndex = actionIndex;
          actionIndex++;

          return (
            <div
              key={item.label}
              className="relative"
              onPointerEnter={(event) => {
                if (openSubmenuLabel === item.label) return;
                const row = event.currentTarget;
                menuAim.requestActivation({
                  pointer: event,
                  submenuElement: getOpenSubmenuElement(),
                  activate: () => {
                    if (isCascadeItem(item)) {
                      setOpenSubmenuLabel(item.label);
                      openLinkedCascade(row);
                      return;
                    }
                    setOpenSubmenuLabel(isSubmenuItem(item) ? item.label : null);
                    onCloseAddPicker?.();
                  },
                });
              }}
            >
              <button
                role="menuitem"
                data-context-menu-root-item="true"
                data-menu-label={item.label}
                tabIndex={currentActionIndex === focusedIndex ? 0 : -1}
                disabled={item.disabled}
                aria-haspopup={isSubmenuItem(item) || isCascadeItem(item) ? 'menu' : undefined}
                aria-expanded={
                  isSubmenuItem(item) || isCascadeItem(item)
                    ? openSubmenuLabel === item.label
                    : undefined
                }
                onClick={(event) => {
                  if (item.disabled) return;
                  menuAim.cancelPendingActivation();
                  if (isCascadeItem(item)) {
                    setOpenSubmenuLabel(item.label);
                    openLinkedCascade(event.currentTarget);
                  } else if (isActionItem(item)) {
                    executeAction(item.action);
                  } else {
                    setOpenSubmenuLabel((current) => (current === item.label ? null : item.label));
                  }
                }}
                onKeyDown={(e) => !item.disabled && handleMenuKeyDown(e, item, currentActionIndex)}
                className={[
                  MENU_ROW_CLASS,
                  item.disabled ? MENU_ROW_DISABLED_CLASS : MENU_ROW_INTERACTIVE_CLASS,
                  item.isDestructive && !item.disabled ? MENU_ROW_DESTRUCTIVE_CLASS : '',
                ].join(' ')}
              >
                <MenuItemContents
                  label={item.label}
                  shortcut={item.shortcut}
                  hasSubmenu={isSubmenuItem(item) || isCascadeItem(item)}
                />
              </button>
              {isSubmenuItem(item) && openSubmenuLabel === item.label && (
                <PresentationScopeContext.Provider value={presentationOverlay.scope}>
                  <div
                    role="menu"
                    aria-label={`${item.label} options`}
                    data-menu-aim-submenu="true"
                    onPointerEnter={menuAim.cancelPendingActivation}
                    className="absolute left-full top-0 z-50 min-w-[240px] bg-bg-subtle border border-border rounded-md shadow-lg py-1"
                    ref={presentationOverlay.bindRef(undefined, '1')}
                  >
                    {item.submenu.map((submenuItem) => (
                      <button
                        key={submenuItem.label}
                        role="menuitem"
                        data-menu-label={submenuItem.label}
                        disabled={submenuItem.disabled}
                        onClick={() => !submenuItem.disabled && executeAction(submenuItem.action)}
                        className={[
                          MENU_ROW_CLASS,
                          submenuItem.disabled
                            ? MENU_ROW_DISABLED_CLASS
                            : MENU_ROW_INTERACTIVE_CLASS,
                        ].join(' ')}
                      >
                        <MenuItemContents
                          label={submenuItem.label}
                          shortcut={submenuItem.shortcut}
                        />
                      </button>
                    ))}
                  </div>
                </PresentationScopeContext.Provider>
              )}
            </div>
          );
        })}
      </div>
    </PresentationScopeContext.Provider>
  );
}
