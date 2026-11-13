import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { FileContextMenu } from './FileContextMenu';
import { fileMenuPathActions } from './file-menu-path-actions';

const mockWriteText = vi.fn(() => Promise.resolve());
const platformMocks = vi.hoisted(() => ({
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../platform', () => ({
  platform: vi.fn(() => ({
    shell: {
      revealItemInDir: platformMocks.revealItemInDir,
    },
  })),
}));

function mockNavigatorPlatform(platform: string) {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  platformMocks.revealItemInDir.mockResolvedValue(undefined);
});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: mockWriteText },
    writable: true,
    configurable: true,
  });
});

describe('FileContextMenu', () => {
  const defaultProps = {
    position: { x: 100, y: 200 },
    ...fileMenuPathActions('/path/to/file.txt'),
    displayName: 'file.txt',
    isDirectory: false,
    isRootFolder: false,
    onClose: vi.fn(),
    onOpen: vi.fn(),
    onOpenInNewPanel: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onRemoveFromWorkspace: vi.fn(),
  };

  describe('visibility and positioning', () => {
    it('renders at the specified position', () => {
      render(<FileContextMenu {...defaultProps} />);

      const menu = screen.getByRole('menu');
      expect(menu).toHaveStyle({ left: '100px', top: '200px' });
    });

    it('closes when clicking outside', () => {
      const onClose = vi.fn();
      render(<FileContextMenu {...defaultProps} onClose={onClose} />);

      fireEvent.mouseDown(document.body);

      expect(onClose).toHaveBeenCalled();
    });

    it('closes on Escape key', () => {
      const onClose = vi.fn();
      render(<FileContextMenu {...defaultProps} onClose={onClose} />);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('file menu items', () => {
    it('keeps a missing Open capability out of keyboard navigation and separators', () => {
      const onNewFolder = vi.fn();
      const onClose = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory
          onOpen={undefined}
          onOpenInNewPanel={undefined}
          onNewFolder={onNewFolder}
          onClose={onClose}
        />
      );
      const menu = screen.getByRole('menu');
      const actions = screen.getAllByRole('menuitem');
      expect(screen.queryByRole('menuitem', { name: /^Open$/ })).not.toBeInTheDocument();
      expect(actions[0]).toHaveTextContent('New Folder');
      expect(actions[0]).toHaveAttribute('tabindex', '0');
      const children = Array.from(menu.children);
      expect(children[0]).not.toHaveAttribute('role', 'separator');
      expect(children.at(-1)).not.toHaveAttribute('role', 'separator');
      for (let i = 1; i < children.length; i++)
        if (children[i].getAttribute('role') === 'separator')
          expect(children[i - 1]).not.toHaveAttribute('role', 'separator');
      actions[0].focus();
      fireEvent.keyDown(actions[0], { key: 'ArrowDown' });
      expect(actions[1]).toHaveFocus();
      fireEvent.keyDown(actions[1], { key: 'ArrowUp' });
      expect(actions[0]).toHaveFocus();
      fireEvent.keyDown(actions[0], { key: 'Enter' });
      expect(onNewFolder).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledOnce();
    });
    it('starts with a real common action when Open and creation are unavailable', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory
          onOpen={undefined}
          onOpenInNewPanel={undefined}
        />
      );
      expect(screen.getByRole('menu').firstElementChild).not.toHaveAttribute('role', 'separator');
      expect(screen.getAllByRole('menuitem')[0]).toHaveAttribute('tabindex', '0');
    });

    it('shows "Open" option for files', () => {
      render(<FileContextMenu {...defaultProps} />);

      expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('shows "Open in New Panel" option for files', () => {
      render(<FileContextMenu {...defaultProps} />);

      expect(screen.getByText('Open in New Panel')).toBeInTheDocument();
    });

    it('shows "Copy Path" option', () => {
      render(<FileContextMenu {...defaultProps} />);

      expect(screen.getByText('Copy Path')).toBeInTheDocument();
    });

    it('shows "Copy Relative Path" only when a workspace relative path is provided', () => {
      const { rerender } = render(<FileContextMenu {...defaultProps} />);

      expect(screen.queryByText('Copy Relative Path')).not.toBeInTheDocument();

      rerender(
        <FileContextMenu
          {...defaultProps}
          {...fileMenuPathActions('/path/to/file.txt', 'nested/file.txt')}
        />
      );

      expect(screen.getByText('Copy Relative Path')).toBeInTheDocument();
    });

    it('shows "Show in folder" option', () => {
      render(<FileContextMenu {...defaultProps} />);

      expect(screen.getByText('Show in folder')).toBeInTheDocument();
    });

    it('uses OS-sensitive Delete shortcut hints', () => {
      mockNavigatorPlatform('MacIntel');
      const { rerender } = render(<FileContextMenu {...defaultProps} />);
      expect(
        within(screen.getByRole('menuitem', { name: 'Delete' })).getByTestId(
          'context-menu-shortcut'
        )
      ).toHaveTextContent('⌘⌫');

      mockNavigatorPlatform('Win32');
      rerender(<FileContextMenu {...defaultProps} />);
      expect(
        within(screen.getByRole('menuitem', { name: 'Delete' })).getByTestId(
          'context-menu-shortcut'
        )
      ).toHaveTextContent('Del');
    });

    it('shows separator between action groups', () => {
      render(<FileContextMenu {...defaultProps} />);

      const separators = screen.getAllByRole('separator');
      expect(separators.length).toBeGreaterThan(0);
    });
  });

  describe('directory menu items', () => {
    it.each([
      { isDirectory: false, isRootFolder: false },
      { isDirectory: true, isRootFolder: false },
      { isDirectory: true, isRootFolder: true },
    ])('keeps Notebook and Assembly inside the shared picker for %j', (context) => {
      const onOpenAddPicker = vi.fn();
      const onNewTextFile = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          {...context}
          onNewNotebook={vi.fn()}
          onNewAssembly={vi.fn()}
          onNewTextFile={onNewTextFile}
          onOpenAddPicker={onOpenAddPicker}
        />
      );

      expect(screen.queryByRole('menuitem', { name: 'Notebook Entry' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Assembly' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'New…' }));
      expect(onOpenAddPicker).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Text File' }));
      expect(onNewTextFile).toHaveBeenCalledOnce();
    });

    it('does not show "Open in New Panel" for directories', () => {
      render(<FileContextMenu {...defaultProps} isDirectory={true} />);

      expect(screen.queryByText('Open in New Panel')).not.toBeInTheDocument();
    });

    it('shows New Folder and a nested New File submenu for directories', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          onNewNotebook={vi.fn()}
          onNewAssembly={vi.fn()}
          onNewTextFile={vi.fn()}
          onNewFolder={vi.fn()}
        />
      );

      expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeInTheDocument();
      const newFileItem = screen.getByRole('menuitem', { name: 'New File(s)...' });
      expect(newFileItem).toHaveAttribute('aria-haspopup', 'menu');

      fireEvent.click(newFileItem);

      expect(screen.getByRole('menuitem', { name: 'Notebook Entry' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Assembly' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Text File' })).toBeInTheDocument();
      expect(
        within(screen.getByRole('menuitem', { name: 'Text File' })).queryByTestId(
          'context-menu-shortcut'
        )
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Folder' })).not.toBeInTheDocument();
    });

    it('also exposes New Folder and New File for files so new items can be created beside a file', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          onNewNotebook={vi.fn()}
          onNewAssembly={vi.fn()}
          onNewTextFile={vi.fn()}
          onNewFolder={vi.fn()}
        />
      );

      expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeInTheDocument();
      const newFileItem = screen.getByRole('menuitem', { name: 'New File(s)...' });
      fireEvent.click(newFileItem);

      expect(screen.getByRole('menuitem', { name: 'Notebook Entry' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Assembly' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Text File' })).toBeInTheDocument();
    });

    it('shows Find in Folder... only for directories when the callback is provided', () => {
      const { rerender } = render(
        <FileContextMenu {...defaultProps} onFindInFolder={vi.fn()} isDirectory={false} />
      );

      expect(screen.queryByRole('menuitem', { name: 'Find in Folder...' })).not.toBeInTheDocument();

      rerender(<FileContextMenu {...defaultProps} onFindInFolder={vi.fn()} isDirectory={true} />);

      expect(screen.getByRole('menuitem', { name: 'Find in Folder...' })).toBeInTheDocument();
    });
  });

  describe('rename project item', () => {
    it('shows "Rename project…" for a managed root and routes the click', () => {
      const onRenameProject = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onRenameProject={onRenameProject}
        />
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename project…' }));
      expect(onRenameProject).toHaveBeenCalledTimes(1);
    });

    it('hides "Rename project…" without a handler or on a pinned reference root', () => {
      const { rerender } = render(
        <FileContextMenu {...defaultProps} isDirectory={true} isRootFolder={true} />
      );
      expect(screen.queryByText('Rename project…')).not.toBeInTheDocument();

      rerender(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          pinnedRoot={true}
          onRenameProject={vi.fn()}
        />
      );
      expect(screen.queryByText('Rename project…')).not.toBeInTheDocument();
    });
  });

  describe('root folder menu items', () => {
    it('shows "Archive project…" for a managed workspace root, NOT "Remove"', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onArchiveProject={vi.fn()}
        />
      );

      expect(screen.getByText('Archive project…')).toBeInTheDocument();

      expect(screen.queryByText('Hide project from Files')).not.toBeInTheDocument();
    });

    it('shows the shared project actions (history / archive / trash) for a managed root', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onProjectHistory={vi.fn()}
          onArchiveProject={vi.fn()}
          onTrashProject={vi.fn()}
        />
      );

      expect(screen.getByText('Project history…')).toBeInTheDocument();
      expect(screen.getByText('Archive project…')).toBeInTheDocument();
      expect(screen.getByText('Move to Trash…')).toBeInTheDocument();
    });

    it('shows "Hide project from Files" for a protected reference project, NOT "Archive"', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          pinnedRoot={true}
          onArchiveProject={vi.fn()}
        />
      );

      expect(screen.getByText('Hide project from Files')).toBeInTheDocument();
      expect(screen.queryByText('Archive project…')).not.toBeInTheDocument();
    });

    it('shows neither Archive nor Remove for non-root items', () => {
      render(<FileContextMenu {...defaultProps} isRootFolder={false} onArchiveProject={vi.fn()} />);

      expect(screen.queryByText('Hide project from Files')).not.toBeInTheDocument();
      expect(screen.queryByText('Archive project…')).not.toBeInTheDocument();
    });

    it('does not offer filesystem Delete for root folders', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onArchiveProject={vi.fn()}
        />
      );

      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
      expect(screen.getByText('Archive project…')).toBeInTheDocument();
    });

    it('"Move to Trash…" is destructive (red); "Archive project…" is not', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onArchiveProject={vi.fn()}
          onTrashProject={vi.fn()}
        />
      );

      expect(screen.getByText('Archive project…').closest('button')).not.toHaveClass('text-error');
      expect(screen.getByText('Move to Trash…').closest('button')).toHaveClass('text-error');
    });
  });

  describe('menu actions', () => {
    it('calls onOpen when "Open" is clicked', () => {
      const onOpen = vi.fn();
      render(<FileContextMenu {...defaultProps} onOpen={onOpen} />);

      fireEvent.click(screen.getByText('Open'));

      expect(onOpen).toHaveBeenCalled();
    });

    it('calls onOpenInNewPanel when "Open in New Panel" is clicked', () => {
      const onOpenInNewPanel = vi.fn();
      render(<FileContextMenu {...defaultProps} onOpenInNewPanel={onOpenInNewPanel} />);

      fireEvent.click(screen.getByText('Open in New Panel'));

      expect(onOpenInNewPanel).toHaveBeenCalled();
    });

    it('copies path to clipboard when "Copy Path" is clicked', () => {
      render(<FileContextMenu {...defaultProps} />);

      fireEvent.click(screen.getByText('Copy Path'));

      expect(mockWriteText).toHaveBeenCalledWith('/path/to/file.txt');
    });

    it('copies the workspace relative path to clipboard', () => {
      render(
        <FileContextMenu
          {...defaultProps}
          {...fileMenuPathActions('/path/to/file.txt', 'nested/file.txt')}
        />
      );

      fireEvent.click(screen.getByText('Copy Relative Path'));

      expect(mockWriteText).toHaveBeenCalledWith('nested/file.txt');
    });

    it('reveals the item in the OS file manager', async () => {
      render(<FileContextMenu {...defaultProps} />);

      fireEvent.click(screen.getByText('Show in folder'));

      await waitFor(() => {
        expect(platformMocks.revealItemInDir).toHaveBeenCalledWith('/path/to/file.txt');
      });
    });

    it('calls onRename when "Rename" is clicked', () => {
      const onRename = vi.fn();
      render(<FileContextMenu {...defaultProps} onRename={onRename} />);

      fireEvent.click(screen.getByText('Rename'));

      expect(onRename).toHaveBeenCalled();
    });

    it('offers Duplicate for a supported non-root item and calls its handler', () => {
      const onDuplicate = vi.fn();
      const { rerender } = render(<FileContextMenu {...defaultProps} onDuplicate={onDuplicate} />);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
      expect(onDuplicate).toHaveBeenCalledOnce();

      rerender(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={false}
          onDuplicate={vi.fn()}
        />
      );
      expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
      rerender(<FileContextMenu {...defaultProps} isRootFolder={true} onDuplicate={vi.fn()} />);
      expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).not.toBeInTheDocument();
    });

    it('calls onDelete when "Delete" is clicked', () => {
      const onDelete = vi.fn();
      render(<FileContextMenu {...defaultProps} onDelete={onDelete} />);

      fireEvent.click(screen.getByText('Delete'));

      expect(onDelete).toHaveBeenCalled();
    });

    it('shows "Move to…" only when onMoveTo is provided and the item is not a root folder', () => {
      const { rerender } = render(<FileContextMenu {...defaultProps} />);

      expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument();

      rerender(<FileContextMenu {...defaultProps} onMoveTo={vi.fn()} />);
      expect(screen.getByRole('menuitem', { name: 'Move to…' })).toBeInTheDocument();

      rerender(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onMoveTo={vi.fn()}
          onArchiveProject={vi.fn()}
        />
      );
      expect(screen.queryByRole('menuitem', { name: 'Move to…' })).not.toBeInTheDocument();
    });

    it('calls onMoveTo when "Move to…" is clicked', () => {
      const onMoveTo = vi.fn();
      render(<FileContextMenu {...defaultProps} onMoveTo={onMoveTo} />);

      fireEvent.click(screen.getByRole('menuitem', { name: 'Move to…' }));

      expect(onMoveTo).toHaveBeenCalled();
    });

    it('calls onRemoveFromWorkspace when a reference project is hidden', () => {
      const onRemoveFromWorkspace = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          pinnedRoot={true}
          onRemoveFromWorkspace={onRemoveFromWorkspace}
        />
      );

      fireEvent.click(screen.getByText('Hide project from Files'));

      expect(onRemoveFromWorkspace).toHaveBeenCalled();
    });

    it('calls onArchiveProject when "Archive project…" is clicked (managed root)', () => {
      const onArchiveProject = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          isRootFolder={true}
          onArchiveProject={onArchiveProject}
        />
      );

      fireEvent.click(screen.getByText('Archive project…'));

      expect(onArchiveProject).toHaveBeenCalled();
    });

    it('calls submenu actions from the "New File(s)..." submenu', () => {
      const onNewTextFile = vi.fn();
      render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          onNewTextFile={onNewTextFile}
          onNewFolder={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole('menuitem', { name: 'New File(s)...' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Text File' }));

      expect(onNewTextFile).toHaveBeenCalled();
    });

    it('calls direct New Folder and Find in Folder... actions', () => {
      const onNewFolder = vi.fn();
      const onFindInFolder = vi.fn();
      const { rerender } = render(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          onNewFolder={onNewFolder}
          onFindInFolder={onFindInFolder}
        />
      );

      fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));
      expect(onNewFolder).toHaveBeenCalled();

      rerender(
        <FileContextMenu
          {...defaultProps}
          isDirectory={true}
          onNewFolder={onNewFolder}
          onFindInFolder={onFindInFolder}
        />
      );
      fireEvent.click(screen.getByRole('menuitem', { name: 'Find in Folder...' }));
      expect(onFindInFolder).toHaveBeenCalled();
    });

    it('closes menu after action is executed', () => {
      const onClose = vi.fn();
      render(<FileContextMenu {...defaultProps} onClose={onClose} />);

      fireEvent.click(screen.getByText('Open'));

      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('keyboard navigation', () => {
    it('can navigate with arrow keys', () => {
      render(<FileContextMenu {...defaultProps} />);

      const firstItem = screen.getByRole('menuitem', { name: 'Open' });
      firstItem.focus();

      fireEvent.keyDown(firstItem, { key: 'ArrowDown' });

      expect(screen.getByRole('menuitem', { name: 'Open in New Panel' })).toHaveFocus();
    });

    it('keeps arrow-key navigation on top-level items when the New File submenu is open', () => {
      render(<FileContextMenu {...defaultProps} onNewTextFile={vi.fn()} onNewFolder={vi.fn()} />);

      const newItem = screen.getByRole('menuitem', { name: 'New File(s)...' });
      fireEvent.click(newItem);
      newItem.focus();

      fireEvent.keyDown(newItem, { key: 'ArrowDown' });

      expect(screen.getByRole('menuitem', { name: 'Copy Path' })).toHaveFocus();
    });

    it('can select with Enter key', () => {
      const onOpen = vi.fn();
      render(<FileContextMenu {...defaultProps} onOpen={onOpen} />);

      const openItem = screen.getByText('Open');
      openItem.focus();
      fireEvent.keyDown(openItem, { key: 'Enter' });

      expect(onOpen).toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('has role="menu"', () => {
      render(<FileContextMenu {...defaultProps} />);

      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('menu items have role="menuitem"', () => {
      render(<FileContextMenu {...defaultProps} />);

      const menuItems = screen.getAllByRole('menuitem');
      expect(menuItems.length).toBeGreaterThan(0);
    });

    it('normalizes top-level and submenu row rhythm for compact context menus', () => {
      render(<FileContextMenu {...defaultProps} onNewTextFile={vi.fn()} onNewFolder={vi.fn()} />);

      fireEvent.click(screen.getByRole('menuitem', { name: 'New File(s)...' }));

      for (const item of screen.getAllByRole('menuitem')) {
        expect(item).toHaveClass('flex');
        expect(item).toHaveClass('min-h-7');
        expect(item).toHaveClass('items-center');
        expect(item).toHaveClass('py-1');
        expect(item).toHaveClass('leading-5');
        expect(item).toHaveClass('whitespace-nowrap');
        expect(item).toHaveClass('focus-visible:outline-none');
      }

      for (const separator of screen.getAllByRole('separator')) {
        expect(separator).toHaveClass('my-1');
        expect(separator).toHaveClass('h-px');
        expect(separator).toHaveClass('bg-border');
      }
    });

    it('renders OS-native shortcut hints in faint right-aligned text without changing accessible names', () => {
      mockNavigatorPlatform('MacIntel');

      render(
        <FileContextMenu
          {...defaultProps}
          {...fileMenuPathActions('/path/to/file.txt', 'nested/file.txt')}
          isDirectory={true}
          onNewTextFile={vi.fn()}
          onNewFolder={vi.fn()}
          onFindInFolder={vi.fn()}
        />
      );

      expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Find in Folder...' })).toBeInTheDocument();
      expect(screen.getByText('⌘⇧N')).toHaveClass('text-fg-muted/45');
      expect(screen.getByText('⌘⌥⇧C')).toHaveClass('text-fg-muted/45');
      expect(screen.queryByText('Shift+Cmd+N')).not.toBeInTheDocument();
    });

    it('does not advertise Cmd+Shift+F for Find in Folder because global search owns it', () => {
      mockNavigatorPlatform('MacIntel');

      render(<FileContextMenu {...defaultProps} isDirectory={true} onFindInFolder={vi.fn()} />);

      const findInFolderItem = screen.getByRole('menuitem', { name: 'Find in Folder...' });
      expect(
        within(findInFolderItem).queryByTestId('context-menu-shortcut')
      ).not.toBeInTheDocument();
    });

    it('does not show a generic shortcut on New File because the child file type owns it', () => {
      mockNavigatorPlatform('MacIntel');

      render(
        <FileContextMenu
          {...defaultProps}
          onNewNotebook={vi.fn()}
          onNewAssembly={vi.fn()}
          onNewTextFile={vi.fn()}
          onNewFolder={vi.fn()}
        />
      );

      const newFileItem = screen.getByRole('menuitem', { name: 'New File(s)...' });
      expect(within(newFileItem).queryByTestId('context-menu-shortcut')).not.toBeInTheDocument();

      fireEvent.click(newFileItem);

      expect(
        within(screen.getByRole('menuitem', { name: 'Notebook Entry' })).queryByTestId(
          'context-menu-shortcut'
        )
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('menuitem', { name: 'Assembly' })).queryByTestId(
          'context-menu-shortcut'
        )
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('menuitem', { name: 'Text File' })).queryByTestId(
          'context-menu-shortcut'
        )
      ).not.toBeInTheDocument();
    });

    it('has aria-label describing the context', () => {
      render(<FileContextMenu {...defaultProps} />);

      const menu = screen.getByRole('menu');
      expect(menu).toHaveAttribute('aria-label', 'File actions for file.txt');
    });
  });
});
