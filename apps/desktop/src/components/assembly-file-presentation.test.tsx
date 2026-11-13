import { render, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileTreeItem } from './FileTreeItem';
import { getTabIcon } from '../features/canvas/components/Tab';
import { FileTypeIcon } from './icons';
import { getFileIconCategory, getTabTypeForFile } from '../utils/fileTypes';
import type { FileEntry } from '../hooks/useFileBrowser';

vi.mock('../hooks/useFileDrag', () => ({ startFileDrag: vi.fn() }));

function glyph(container: HTMLElement): string[] {
  const svg = container.querySelector('svg');
  expect(svg).not.toBeNull();
  return [...svg!.querySelectorAll('path, rect, circle, line, polyline, polygon')].map(
    (element) => element.getAttribute('d') ?? element.outerHTML
  );
}

describe('draft assembly file presentation', () => {
  it.each(['Untitled.wpdesign.json', 'pBR322.v2.WPDESIGN.JSON'])(
    'uses the tab glyph and plain hover text for %s before opening and after selection',
    (name) => {
      const title = name.replace(/\.wpdesign\.json$/i, '');
      const path = `C:\\Users\\example\\project\\${name}`;
      const entry: FileEntry = {
        kind: 'filesystem',
        entryId: `filesystem:${path}`,
        path,
        name,
        extension: 'json',
        isDirectory: false,
        isBiologyFile: false,
      };
      const onOpen = vi.fn();
      const props = {
        entry,
        depth: 0,
        expandedPaths: new Set<string>(),
        selectedEntryId: null,
        selectedEntryIds: new Set<string>(),
        focusableEntryId: null,
        revealRequestId: 0,
        revealTargetPath: null,
        renamingPath: null,
        onToggle: vi.fn(),
        onSelect: vi.fn(),
        onOpen,
        onKeyNavigate: vi.fn(),
        onRenameComplete: vi.fn(),
        onRenameCancel: vi.fn(),
        onDelete: vi.fn(),
      };
      const tree = render(<FileTreeItem {...props} />);
      const tab = render(<>{getTabIcon(getTabTypeForFile(name))}</>);
      expect(glyph(tree.container)).toEqual(glyph(tab.container));
      const row = tree.getByTestId('file-tree-item');
      expect(row).toHaveAttribute('title', title);
      expect(tree.getByText(title)).toHaveAttribute('title', title);
      expect(row.textContent).toBe(title);
      tree.rerender(<FileTreeItem {...props} selectedEntryId={entry.entryId} />);
      expect(glyph(tree.container)).toEqual(glyph(tab.container));
      expect(row).toHaveAttribute('title', title);
      fireEvent.doubleClick(row);
      expect(onOpen).toHaveBeenCalledWith(entry);
    }
  );

  it('resolves every assembly file icon through the same glyph as its tab', () => {
    const name = '/lab/Native draft.wpdesign.json';
    expect(getFileIconCategory(name)).toBe('design');
    const file = render(<FileTypeIcon category={getFileIconCategory(name)} />);
    const tab = render(<>{getTabIcon(getTabTypeForFile(name))}</>);
    expect(glyph(file.container)).toEqual(glyph(tab.container));
    expect(getFileIconCategory('/lab/config.json')).toBe('code');
  });
});
