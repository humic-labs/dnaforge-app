import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { FileTreeItem } from './FileTreeItem';
import { OligoIcon } from './icons';
import { startFileDrag } from '../hooks/useFileDrag';
import type { FileEntry } from '../hooks/useFileBrowser';

vi.mock('../hooks/useFileDrag', () => ({ startFileDrag: vi.fn() }));

const treeItemProps = {
  depth: 0,
  expandedPaths: new Set<string>(),
  selectedEntryId: null,
  selectedEntryIds: new Set<string>(),
  focusableEntryId: null,
  revealRequestId: 0,
  revealTargetPath: null,
  renamingPath: null,
  onToggle: () => {},
  onSelect: () => {},
  onOpen: () => {},
  onKeyNavigate: () => {},
  onContextMenu: () => {},
  onRenameComplete: () => {},
  onRenameCancel: () => {},
  onDelete: () => {},
};

const makeDir = (name: string, children: FileEntry[] = []): FileEntry => ({
  kind: 'filesystem',
  entryId: `filesystem:/ws/${name}`,
  name,
  path: `/ws/${name}`,
  isDirectory: true,
  isBiologyFile: false,
  extension: null,
  children,
});

function makeEntry(name: string, extension: string | null): FileEntry {
  return {
    kind: 'filesystem',
    entryId: `filesystem:/ws/${name}`,
    name,
    path: `/ws/${name}`,
    isDirectory: false,
    isBiologyFile: false,
    extension,
  };
}

function makeSequenceEntry(name: string, physicalName: string, extension = 'gb'): FileEntry {
  return {
    ...makeEntry(name, extension),
    path: `/ws/${physicalName}`,
    entryId: `filesystem:/ws/${physicalName}`,
    isBiologyFile: true,
  };
}

function renderItem(entry: FileEntry) {
  return render(
    <FileTreeItem
      entry={entry}
      depth={0}
      expandedPaths={new Set()}
      selectedEntryId={null}
      selectedEntryIds={new Set()}
      focusableEntryId={null}
      revealRequestId={0}
      revealTargetPath={null}
      renamingPath={null}
      onToggle={() => {}}
      onSelect={() => {}}
      onOpen={() => {}}
      onKeyNavigate={() => {}}
      onRenameComplete={() => {}}
      onRenameCancel={() => {}}
      onDelete={() => {}}
    />
  );
}

describe('FileTreeItem icon ', () => {
  it.each(['NoGitIdentity.primer.json', 'NoGitIdentity.PRIMER.JSON'])(
    'shows the oligo glyph for %s in a Windows project',
    (name) => {
      const entry = { ...makeEntry(name, 'json'), path: `C:\\Users\\example\\project\\${name}` };
      const { container } = renderItem(entry);
      const expected = render(<OligoIcon />);
      expect(container.querySelector('svg')?.innerHTML).toBe(
        expected.container.querySelector('svg')?.innerHTML
      );
      expect(container.querySelector('[data-file-type-icon="code"]')).toBeNull();
    }
  );

  it('shows a structure glyph and hides only the displayed coordinate suffix', () => {
    const entry = makeEntry('1FS0.mmcif', 'mmcif');
    const { container, getByText } = renderItem(entry);

    expect(container.querySelector('svg[data-file-type-icon="structure"]')).toBeInTheDocument();
    expect(getByText('1FS0')).toBeInTheDocument();
    expect(getByText('1FS0.mmcif')).toHaveClass('sr-only');
    expect(getByText('1FS0.mmcif')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-entry-name="1FS0.mmcif"]')).toHaveAttribute(
      'title',
      '/ws/1FS0.mmcif'
    );
  });

  it('shows the image glyph for a long-named .jpg (the reported bug)', () => {
    const { container } = renderItem(
      makeEntry('2026-06-microscopy-capture-plate-A1-channel-GFP.jpg', 'jpg')
    );
    expect(container.querySelector('svg[data-file-type-icon="image"]')).toBeInTheDocument();

    expect(container.querySelector('svg[data-file-type-icon="text"]')).toBeNull();
  });

  it('shows the web glyph for .html  cross-link)', () => {
    const { container } = renderItem(makeEntry('report.html', 'html'));
    expect(container.querySelector('svg[data-file-type-icon="web"]')).toBeInTheDocument();
  });

  it('shows the code glyph for source files', () => {
    const { container } = renderItem(makeEntry('analysis.py', 'py'));
    expect(container.querySelector('svg[data-file-type-icon="code"]')).toBeInTheDocument();
  });

  it('shows a saved genome view with its plain name and reference genome icon', () => {
    const { container, getByText } = renderItem(
      makeEntry('My locus.dnaforge-track-view.json', 'json')
    );
    expect(getByText('My locus')).toBeInTheDocument();
    expect(container.querySelector('svg[data-icon="genome-assembly"]')).toBeInTheDocument();
  });

  it('shows the spreadsheet glyph for .csv', () => {
    const { container } = renderItem(makeEntry('qpcr-results.csv', 'csv'));
    expect(container.querySelector('svg[data-file-type-icon="spreadsheet"]')).toBeInTheDocument();
  });

  it('falls back to a generic glyph (no type marker) for unknown extensions', () => {
    const { container } = renderItem(makeEntry('mystery.xyz', 'xyz'));
    expect(container.querySelector('[data-file-type-icon]')).toBeNull();
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('uses the sequence display name in text, tooltips and accessibility without a hidden filename', () => {
    const { getByText, getByTestId, queryByText } = renderItem(
      makeSequenceEntry('pUC19.v2', 'unrelated-physical-product.gb')
    );
    expect(getByText('pUC19.v2')).toHaveAttribute('title', 'pUC19.v2');
    expect(getByTestId('file-tree-item')).toHaveAttribute('title', 'pUC19.v2');
    expect(getByTestId('file-tree-item')).toHaveAttribute('data-entry-name', 'pUC19.v2');
    expect(queryByText('unrelated-physical-product.gb')).toBeNull();
    expect(getByTestId('file-tree-item').querySelector('.sr-only')).toBeNull();
  });

  it('hides a compound artifact extension in the displayed name', () => {
    const { getByText } = renderItem(makeEntry('EGFP subclone.wpdesign.json', 'json'));
    expect(getByText('EGFP subclone')).toBeInTheDocument();
  });

  it('hides the .primer.json suffix in the displayed name (registry file SSOT)', () => {
    const { getByText } = renderItem(makeEntry('IDT-oPC-0001.primer.json', 'json'));

    expect(getByText('IDT-oPC-0001')).toBeInTheDocument();
  });

  it('hides the .wpselection.json suffix in the displayed name', () => {
    const { getByText } = renderItem(makeEntry('active-site.abc123.wpselection.json', 'json'));
    expect(getByText('active-site.abc123')).toBeInTheDocument();
  });

  it('retains existing filename locator behavior for coordinate files', () => {
    const { getByTestId } = renderItem(makeEntry('1FS0.mmcif', 'mmcif'));
    expect(getByTestId('file-tree-item').textContent).toContain('1FS0.mmcif');
  });

  it('keeps the full filename as the VISIBLE label tooltip when the extension is hidden', () => {
    const { getByText } = renderItem(makeEntry('browser-structure.pdb', 'pdb'));
    const visibleLabel = getByText('browser-structure');
    expect(visibleLabel).not.toHaveClass('sr-only');
    expect(visibleLabel).toHaveAttribute('title', 'browser-structure.pdb');
  });

  it('does NOT add a redundant hidden name node when nothing is hidden', () => {
    const { getByTestId } = render(
      <FileTreeItem {...treeItemProps} entry={makeDir('notebooks')} />
    );
    expect(getByTestId('file-tree-item').querySelector('.sr-only')).toBeNull();
  });
});

describe('FileTreeItem drag-to-move gate ', () => {
  beforeEach(() => vi.clearAllMocks());

  it('default: a folder row is a drop target AND starts a drag on mousedown', () => {
    const { getByTestId } = render(<FileTreeItem {...treeItemProps} entry={makeDir('primers')} />);
    const row = getByTestId('file-tree-item');
    expect(row).toHaveAttribute('data-file-drop-target', 'true');
    fireEvent.mouseDown(row, { button: 0 });
    expect(startFileDrag).toHaveBeenCalledTimes(1);
  });

  it('dragToMoveEnabled=false: NOT a drop target and does NOT start a drag', () => {
    const { getByTestId } = render(
      <FileTreeItem {...treeItemProps} entry={makeDir('primers')} dragToMoveEnabled={false} />
    );
    const row = getByTestId('file-tree-item');
    expect(row).not.toHaveAttribute('data-file-drop-target');
    fireEvent.mouseDown(row, { button: 0 });
    expect(startFileDrag).not.toHaveBeenCalled();
  });

  it('forwards the gate to nested children — no nested row is draggable/droppable', () => {
    const parent = makeDir('parent', [makeDir('child')]);
    const { getAllByTestId } = render(
      <FileTreeItem
        {...treeItemProps}
        entry={parent}
        expandedPaths={new Set(['/ws/parent'])}
        dragToMoveEnabled={false}
      />
    );
    const rows = getAllByTestId('file-tree-item');
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row).not.toHaveAttribute('data-file-drop-target');
      fireEvent.mouseDown(row, { button: 0 });
    }
    expect(startFileDrag).not.toHaveBeenCalled();
  });

  describe('rename box hides app-internal container suffixes  D5)', () => {
    function renderRenaming(entry: FileEntry, onRenameComplete = vi.fn()) {
      const onRenameCancel = vi.fn();
      const utils = render(
        <FileTreeItem
          {...treeItemProps}
          entry={entry}
          renamingPath={entry.path}
          onRenameComplete={onRenameComplete}
          onRenameCancel={onRenameCancel}
        />
      );
      const input = utils.container.querySelector('input') as HTMLInputElement;
      return { ...utils, input, onRenameComplete, onRenameCancel };
    }

    it('seeds the box with the stem only for a design artifact', () => {
      const { input } = renderRenaming(makeEntry('Untitled.wpdesign.json', 'json'));
      expect(input.value).toBe('Untitled');
    });

    it('re-attaches the hidden suffix on submit, so the file on disk keeps it', () => {
      const { input, onRenameComplete } = renderRenaming(
        makeEntry('Untitled.wpdesign.json', 'json')
      );
      fireEvent.change(input, { target: { value: 'pMyConstruct' } });
      fireEvent.blur(input);
      expect(onRenameComplete).toHaveBeenCalledWith(
        '/ws/Untitled.wpdesign.json',
        'pMyConstruct.wpdesign.json'
      );
    });

    it('commits a pending artifact only once when Enter is followed by blur', () => {
      const pendingNotebook = {
        ...makeEntry('Untitled.wpnote.json', 'json'),
        isPending: true,
      };
      const { input, onRenameComplete } = renderRenaming(pendingNotebook);

      fireEvent.change(input, { target: { value: 'Experiment notes' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);

      expect(onRenameComplete).toHaveBeenCalledOnce();
      expect(onRenameComplete).toHaveBeenCalledWith(
        '/ws/Untitled.wpnote.json',
        'Experiment notes.wpnote.json'
      );
    });

    it('allows an unchanged pending creation retry after asynchronous failure while suppressing the in-flight Enter/blur pair', async () => {
      const failed = Promise.reject(new Error('delivery blocked'));
      void failed.catch(() => undefined);
      const onRenameComplete = vi.fn().mockReturnValueOnce(failed).mockResolvedValueOnce(undefined);
      const { input } = renderRenaming(
        { ...makeEntry('Untitled DNA sequence', null), isPending: true },
        onRenameComplete
      );
      fireEvent.change(input, { target: { value: 'Named sequence' } });
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
        fireEvent.blur(input);
      });
      expect(onRenameComplete).toHaveBeenCalledOnce();
      expect(input.value).toBe('Named sequence');
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' });
      });
      expect(onRenameComplete).toHaveBeenCalledTimes(2);
    });

    it('preserves typed text when the parent rebuilds an equivalent entry object', () => {
      const onRenameComplete = vi.fn();
      const entry = makeEntry('Untitled.wpdesign.json', 'json');
      const { container, rerender } = render(
        <FileTreeItem
          {...treeItemProps}
          entry={entry}
          renamingPath={entry.path}
          onRenameComplete={onRenameComplete}
        />
      );
      const input = container.querySelector('input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'pMyConstruct' } });
      input.setSelectionRange(3, 3);

      rerender(
        <FileTreeItem
          {...treeItemProps}
          entry={{ ...entry }}
          renamingPath={entry.path}
          onRenameComplete={onRenameComplete}
        />
      );

      expect(input.value).toBe('pMyConstruct');
      expect(input.selectionStart).toBe(3);
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onRenameComplete).toHaveBeenCalledWith(
        '/ws/Untitled.wpdesign.json',
        'pMyConstruct.wpdesign.json'
      );
    });

    it('does not double-suffix when the user types the suffix themselves', () => {
      const { input, onRenameComplete } = renderRenaming(
        makeEntry('Untitled.wpdesign.json', 'json')
      );
      fireEvent.change(input, { target: { value: 'pMyConstruct.wpdesign.json' } });
      fireEvent.blur(input);
      expect(onRenameComplete).toHaveBeenCalledWith(
        '/ws/Untitled.wpdesign.json',
        'pMyConstruct.wpdesign.json'
      );
    });

    it('cancels when the user retypes the unchanged full compound name', () => {
      const { input, onRenameComplete, onRenameCancel } = renderRenaming(
        makeEntry('Untitled.wpdesign.json', 'json')
      );
      fireEvent.change(input, { target: { value: 'Untitled.wpdesign.json' } });
      fireEvent.blur(input);
      expect(onRenameComplete).not.toHaveBeenCalled();
      expect(onRenameCancel).toHaveBeenCalledOnce();
    });

    it('applies to every registry container suffix, not just design', () => {
      expect(renderRenaming(makeEntry('Notes.wpnote.json', 'json')).input.value).toBe('Notes');
      expect(renderRenaming(makeEntry('sel.wpselection.json', 'json')).input.value).toBe('sel');
      expect(renderRenaming(makeEntry('oligo.primer.json', 'json')).input.value).toBe('oligo');
    });

    it('leaves a non-sequence file extension visible and editable', () => {
      const { input, onRenameComplete } = renderRenaming(makeEntry('data.txt', 'txt'));
      expect(input.value).toBe('data.txt');

      fireEvent.change(input, { target: { value: 'data.csv' } });
      fireEvent.blur(input);
      expect(onRenameComplete).toHaveBeenCalledWith('/ws/data.txt', 'data.csv');
    });

    it('keeps a loose sequence source suffix outside the name editor and preserves it on rename', () => {
      const { input, onRenameComplete } = renderRenaming(
        makeSequenceEntry('pUC19.v2', 'raw-import.fasta.gz', 'gz')
      );
      expect(input.value).toBe('pUC19.v2');
      fireEvent.change(input, { target: { value: 'pUC19.v3' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onRenameComplete).toHaveBeenCalledWith('/ws/raw-import.fasta.gz', 'pUC19.v3.fasta.gz');
    });

    it('accepts an explicitly entered sequence filename without duplicating its suffix', () => {
      const { input, onRenameComplete } = renderRenaming(makeSequenceEntry('pUC19', 'pUC19.gb'));
      fireEvent.change(input, { target: { value: 'pUC19.fasta' } });
      fireEvent.blur(input);
      expect(onRenameComplete).toHaveBeenCalledWith('/ws/pUC19.gb', 'pUC19.fasta');
    });

    it('leaves a directory name untouched', () => {
      const { input } = renderRenaming(makeDir('primers'));
      expect(input.value).toBe('primers');
    });

    it('keeps arrow keys inside the name editor instead of navigating the file tree', () => {
      const onKeyNavigate = vi.fn();
      const entry = makeEntry('My locus.dnaforge-track-view.json', 'json');
      const { getByTestId } = render(
        <FileTreeItem
          {...treeItemProps}
          entry={entry}
          renamingPath={entry.path}
          onKeyNavigate={onKeyNavigate}
        />
      );
      const input = getByTestId('file-tree-rename-input');

      fireEvent.keyDown(input, { key: 'ArrowLeft' });
      fireEvent.keyDown(input, { key: 'ArrowRight' });

      expect(onKeyNavigate).not.toHaveBeenCalled();
      expect(input).toHaveFocus();
    });
  });
});

describe('FileTreeItem catalog rows', () => {
  const catalogEntry = {
    kind: 'catalog' as const,
    entryId: 'catalog:strain-1',
    workspaceId: 1,
    entityId: 'strain-1',
    sourceRecordId: 'bfi_STRAINAA',
    name: 'Strain A',
    parentRelativePath: 'Strains',
    presentationKind: 'strain' as const,
  };

  it('uses stable identity and never exposes filesystem mutation affordances', () => {
    const onOpen = vi.fn();
    const onDelete = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <FileTreeItem
        {...treeItemProps}
        entry={catalogEntry}
        onOpen={onOpen}
        onDelete={onDelete}
        onContextMenu={onContextMenu}
      />
    );
    const row = getByTestId('file-tree-item');

    expect(row).toHaveAttribute('data-entry-id', 'catalog:strain-1');
    expect(row).toHaveAttribute('data-entry-kind', 'catalog');
    expect(row).not.toHaveAttribute('data-entry-path');
    expect(row).not.toHaveAttribute('data-file-drop-target');

    fireEvent.mouseDown(row, { button: 0 });
    fireEvent.doubleClick(row);
    fireEvent.contextMenu(row);
    fireEvent.keyDown(row, { key: 'Delete' });

    expect(startFileDrag).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(catalogEntry);
    expect(onContextMenu).toHaveBeenCalledWith(expect.anything(), catalogEntry);
  });
});

describe('FileTreeItem — plasmid package rows ', () => {
  const plasmidPackage: FileEntry = {
    kind: 'filesystem',
    entryId: 'filesystem:/ws/pMyConstruct',
    name: 'pMyConstruct',
    path: '/ws/pMyConstruct',
    isDirectory: false,
    packageKind: 'sequence',
    isBiologyFile: false,
    extension: null,
  };

  it('shows the package name with nothing stripped', () => {
    const { getByTestId } = render(<FileTreeItem {...treeItemProps} entry={plasmidPackage} />);
    expect(getByTestId('file-tree-item')).toHaveTextContent('pMyConstruct');
  });

  it('renames without inventing a suffix', () => {
    const onRenameComplete = vi.fn();
    const { container } = render(
      <FileTreeItem
        {...treeItemProps}
        entry={plasmidPackage}
        renamingPath={plasmidPackage.path}
        onRenameComplete={onRenameComplete}
      />
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('pMyConstruct');
    fireEvent.change(input, { target: { value: 'pRenamed' } });
    fireEvent.blur(input);
    expect(onRenameComplete).toHaveBeenCalledWith('/ws/pMyConstruct', 'pRenamed');
  });

  it('shows modified status rolled up from inside the package', () => {
    const { getByTestId } = render(
      <FileTreeItem
        {...treeItemProps}
        entry={plasmidPackage}
        rootPath="/ws"
        gitStatusMap={new Map([['pMyConstruct/pMyConstruct.gb', 'modified']])}
      />
    );
    expect(getByTestId('file-tree-item')).toHaveAttribute('data-git-status', 'modified');
  });

  it('does not inherit Git status from an unrelated nested directory', () => {
    const { getByTestId } = render(
      <FileTreeItem
        {...treeItemProps}
        entry={plasmidPackage}
        rootPath="/ws"
        gitStatusMap={new Map([['other/file.gb', 'modified']])}
      />
    );
    expect(getByTestId('file-tree-item')).not.toHaveAttribute('data-git-status');
  });

  it('a package whose name contains a dot keeps the whole name', () => {
    const dotted: FileEntry = {
      ...plasmidPackage,
      entryId: 'filesystem:/ws/pUC19.v2',
      name: 'pUC19.v2',
      path: '/ws/pUC19.v2',
    };
    const { container } = render(
      <FileTreeItem {...treeItemProps} entry={dotted} renamingPath={dotted.path} />
    );
    expect((container.querySelector('input') as HTMLInputElement).value).toBe('pUC19.v2');
  });
});
