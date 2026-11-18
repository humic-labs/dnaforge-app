import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useState } from 'react';
import { WorkspaceFolderPicker } from './WorkspaceFolderPicker';
import { FolderIcon, ProjectRootIcon } from './icons';
import { buildSequencePackageDocument } from '../db/sequence-package';
import { useToastStore } from '../stores/toast-store';
import {
  clearManagedSequenceRenameRequest,
  peekManagedSequenceRename,
} from '../features/sequence/public/managed-sequence-rename';

const fsMock = vi.hoisted(() => ({
  readDir: vi.fn(async () => []),
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  readTextFile: vi.fn(),
}));
const documentOpen = vi.hoisted(() => vi.fn());
vi.mock('../features/document-opening/open-document', () => ({
  openDocument: documentOpen,
}));
vi.mock('../platform', () => ({
  platform: () => ({
    fs: fsMock,
    shell: { revealItemInDir: vi.fn(async () => {}) },
  }),
}));
vi.mock('../db/workspace-catalog', () => ({ registerWorkspaceFile: vi.fn(async () => {}) }));

const safeFocusMocks = vi.hoisted(() => ({
  scrollIntoNearestScrollContainer: vi.fn(() => true),
}));
vi.mock('../shared/utils/safeFocus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/safeFocus')>();
  return {
    ...actual,
    scrollIntoNearestScrollContainer: safeFocusMocks.scrollIntoNearestScrollContainer,
  };
});

beforeEach(() => {
  clearManagedSequenceRenameRequest();
  useToastStore.getState().clearToasts();
  documentOpen.mockReset();
  documentOpen.mockResolvedValue({ status: 'presented' });
  fsMock.readTextFile.mockReset();
  fsMock.exists.mockResolvedValue(false);
  fsMock.readDir.mockReset();
  fsMock.readDir.mockImplementation(async () => []);
});

const base = {
  roots: [
    { path: '/w/proj', name: 'proj' },
    { path: '/w/fixtures', name: 'fixtures' },
  ],
  initialDir: '/w/proj/sequences',
  selectedDir: '/w/proj/sequences',
  onSelectFolder: vi.fn(),
};

const rightClickRoot = (path: string) =>
  fireEvent.contextMenu(screen.getByTestId(`workspace-folder-picker-folder-${path}`));

describe('WorkspaceFolderPicker (shared folder chooser)', () => {
  it('retains real directory Open to expand and select a destination', async () => {
    const onSelectFolder = vi.fn();
    render(
      <WorkspaceFolderPicker
        {...base}
        initialDir=""
        selectedDir=""
        onSelectFolder={onSelectFolder}
      />
    );
    const root = screen.getByTestId('workspace-folder-picker-folder-/w/proj');
    expect(root.querySelector('svg')).not.toHaveClass('rotate-90');
    fireEvent.contextMenu(root);
    expect(onSelectFolder).not.toHaveBeenCalled();
    expect(root.querySelector('svg')).not.toHaveClass('rotate-90');
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open$/ }));
    expect(onSelectFolder).toHaveBeenCalledExactlyOnceWith('/w/proj');
    await waitFor(() => expect(root.querySelector('svg')).toHaveClass('rotate-90'));
    expect(fsMock.readDir).toHaveBeenCalledWith('/w/proj');
    expect(documentOpen).not.toHaveBeenCalled();
  });
  it('allows folder selection in read-only mode without exposing filesystem management', () => {
    const onSelectFolder = vi.fn();
    render(<WorkspaceFolderPicker {...base} readOnly onSelectFolder={onSelectFolder} />);
    fireEvent.click(screen.getByTestId('workspace-folder-picker-folder-/w/proj'));
    expect(onSelectFolder).toHaveBeenCalledWith('/w/proj');
    rightClickRoot('/w/proj');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  });

  it('uses the sequence name in its menu and routes Rename to metadata', async () => {
    const packageRoot = '/w/proj/physical-package__seq_123';
    fsMock.exists.mockImplementation(async (path: string) => path === `${packageRoot}/.forge`);
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') return [{ name: 'physical-package__seq_123', isDirectory: true }];
      if (dir === `${packageRoot}/.forge`)
        return [{ name: 'plasmid.json', isDirectory: false, isFile: true }];
      return [];
    });
    fsMock.readTextFile.mockResolvedValue(
      JSON.stringify(
        buildSequencePackageDocument({
          id: 'sequence-picker',
          name: 'Friendly sequence.v2',
          product: { file: 'raw-product.gb' },
        })
      )
    );
    render(<WorkspaceFolderPicker {...base} initialDir="/w/proj" selectedDir="/w/proj" />);
    const row = await screen.findByText('Friendly sequence.v2');
    fireEvent.contextMenu(row);
    expect(screen.getByRole('menu')).toHaveAccessibleName('File actions for Friendly sequence.v2');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename', exact: true }));
    await waitFor(() => {
      expect(documentOpen).toHaveBeenCalledWith({
        target: {
          kind: 'sequence-document',
          document: { kind: 'managed-sequence', packageId: 'sequence-picker', packageRoot },
        },
        label: 'Friendly sequence.v2',
      });
      expect(peekManagedSequenceRename('sequence-picker')).not.toBeNull();
    });
    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('reports a failed coordinated Rename without moving the sequence package', async () => {
    const packageRoot = '/w/proj/physical-package__seq_123';
    fsMock.exists.mockImplementation(async (path: string) => path === `${packageRoot}/.forge`);
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') return [{ name: 'physical-package__seq_123', isDirectory: true }];
      if (dir === `${packageRoot}/.forge`)
        return [{ name: 'plasmid.json', isDirectory: false, isFile: true }];
      return [];
    });
    fsMock.readTextFile.mockResolvedValue(
      JSON.stringify(
        buildSequencePackageDocument({
          id: 'sequence-picker',
          name: 'Friendly sequence.v2',
          product: { file: 'raw-product.gb' },
        })
      )
    );
    documentOpen.mockResolvedValue({ status: 'failed', message: 'Could not read the package.' });
    render(<WorkspaceFolderPicker {...base} initialDir="/w/proj" selectedDir="/w/proj" />);
    fireEvent.contextMenu(await screen.findByText('Friendly sequence.v2'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename', exact: true }));
    await waitFor(() => {
      expect(documentOpen).toHaveBeenCalledOnce();
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({ message: 'Could not open this sequence for renaming.' })
      );
    });
    expect(peekManagedSequenceRename('sequence-picker')).toBeNull();
    expect(fsMock.rename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
  });

  it('uses the shared project icon for roots, keeping folder icons for subfolders', async () => {
    fsMock.readDir.mockImplementation(async (dir: string) =>
      dir === '/w/proj' ? [{ name: 'sequences', isDirectory: true }] : []
    );
    render(<WorkspaceFolderPicker {...base} initialDir="/w/proj" selectedDir="/w/proj" />);
    const root = screen.getByTestId('workspace-folder-picker-folder-/w/proj');
    const projectIcon = renderToStaticMarkup(<ProjectRootIcon />);
    expect(root.innerHTML).toContain(projectIcon);
    const folder = (await screen.findByText('sequences')).closest('[data-entry-path]');
    expect(folder).not.toBeNull();
    const expectedFolder = render(<FolderIcon expanded={false} />).container.querySelector('svg');
    expect(folder?.querySelector('svg[data-entity-color-family="neutral"]')?.innerHTML).toBe(
      expectedFolder?.innerHTML
    );
    fireEvent.click(root);
    expect(root.innerHTML).toContain(projectIcon);
  });

  it('renders every mounted workspace as a root, with a default container testid', () => {
    render(<WorkspaceFolderPicker {...base} />);
    expect(screen.getByTestId('workspace-folder-picker')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-folder-picker-folder-/w/proj')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-folder-picker-folder-/w/fixtures')).toBeInTheDocument();
  });

  it('honors idPrefix + containerTestId (host-stable selectors)', () => {
    render(
      <WorkspaceFolderPicker
        {...base}
        idPrefix="primer-picker"
        containerTestId="primer-save-location-picker"
      />
    );
    expect(screen.getByTestId('primer-save-location-picker')).toBeInTheDocument();
    expect(screen.getByTestId('primer-picker-folder-/w/proj')).toBeInTheDocument();
  });

  it('keeps a bare embedded picker bounded by the height supplied by its host', () => {
    render(<WorkspaceFolderPicker {...base} surface="bare" className="h-full" />);

    expect(screen.getByTestId('workspace-folder-picker').parentElement).toHaveClass(
      'h-full',
      'min-h-0'
    );
  });

  it.each(['panel', 'bare'] as const)(
    'opens only the assigned project in the %s picker',
    async (surface) => {
      fsMock.readDir.mockImplementation(async (dir: string) => {
        if (dir === '/w/proj') return [{ name: 'unrelated-child', isDirectory: true }];
        if (dir === '/w/fixtures') return [{ name: 'selected-child', isDirectory: true }];
        return [];
      });

      render(
        <WorkspaceFolderPicker
          {...base}
          surface={surface}
          initialDir="/w/fixtures"
          selectedDir="/w/fixtures"
        />
      );

      await waitFor(() => expect(screen.getByText('selected-child')).toBeTruthy());
      expect(screen.queryByText('unrelated-child')).toBeNull();
    }
  );

  it('expands the assigned ancestry, keeps siblings collapsed and preserves manual browsing', async () => {
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') return [{ name: 'other-project-child', isDirectory: true }];
      if (dir === '/w/fixtures')
        return [
          { name: 'assemblies', isDirectory: true },
          { name: 'unrelated', isDirectory: true },
        ];
      if (dir === '/w/fixtures/assemblies') return [{ name: 'destination', isDirectory: true }];
      if (dir === '/w/fixtures/unrelated') return [{ name: 'unrelated-child', isDirectory: true }];
      return [];
    });
    const props = {
      ...base,
      initialDir: '/w/fixtures/assemblies/destination',
      selectedDir: '/w/fixtures/assemblies/destination',
      onSelectFolder: vi.fn(),
    };
    const { rerender } = render(<WorkspaceFolderPicker {...props} />);

    const destination = await screen.findByText('destination');
    expect(destination.closest('[data-entry-path]')).toHaveClass('bg-accent/15');
    expect(screen.queryByText('other-project-child')).toBeNull();
    expect(screen.queryByText('unrelated-child')).toBeNull();
    expect(props.onSelectFolder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('workspace-folder-picker-folder-/w/proj'));
    expect(await screen.findByText('other-project-child')).toBeInTheDocument();
    fireEvent.click(screen.getByText('unrelated'));
    expect(await screen.findByText('unrelated-child')).toBeInTheDocument();
    rerender(<WorkspaceFolderPicker {...props} />);
    expect(screen.getByText('other-project-child')).toBeInTheDocument();
    expect(screen.getByText('unrelated-child')).toBeInTheDocument();
  });

  it.each(['click', 'keyboard'] as const)(
    'collapses unrelated projects when selecting a destination by %s',
    async (gesture) => {
      fsMock.readDir.mockImplementation(async (dir: string) => {
        if (dir === '/w/proj') return [{ name: 'project-child', isDirectory: true }];
        if (dir === '/w/fixtures') return [{ name: 'fixtures-child', isDirectory: true }];
        return [];
      });
      function Picker() {
        const [selectedDir, setSelectedDir] = useState('/w/proj');
        return (
          <WorkspaceFolderPicker
            {...base}
            initialDir="/w/proj"
            selectedDir={selectedDir}
            onSelectFolder={setSelectedDir}
          />
        );
      }
      render(<Picker />);
      expect(await screen.findByText('project-child')).toBeInTheDocument();
      const selectRoot = (path: string) => {
        const row = screen.getByTestId(`workspace-folder-picker-folder-${path}`);
        if (gesture === 'click') fireEvent.click(row);
        else fireEvent.keyDown(row, { key: 'Enter' });
      };
      selectRoot('/w/fixtures');
      expect(await screen.findByText('fixtures-child')).toBeInTheDocument();
      expect(screen.queryByText('project-child')).toBeNull();
      expect(screen.getByTestId('workspace-folder-picker-folder-/w/fixtures')).toHaveClass(
        'bg-accent/15'
      );
      selectRoot('/w/proj');
      expect(await screen.findByText('project-child')).toBeInTheDocument();
      expect(screen.queryByText('fixtures-child')).toBeNull();
      selectRoot('/w/proj');
      expect(screen.queryByText('project-child')).toBeNull();
    }
  );

  it('reveals a reassigned nested destination and closes the previously selected project without remounting', async () => {
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') return [{ name: 'project-child', isDirectory: true }];
      if (dir === '/w/fixtures') return [{ name: 'assemblies', isDirectory: true }];
      if (dir === '/w/fixtures/assemblies') return [{ name: 'destination', isDirectory: true }];
      return [];
    });
    const { rerender } = render(
      <WorkspaceFolderPicker {...base} initialDir="/w/proj" selectedDir="/w/proj" />
    );
    expect(await screen.findByText('project-child')).toBeInTheDocument();
    rerender(
      <WorkspaceFolderPicker
        {...base}
        initialDir="/w/proj"
        selectedDir="/w/fixtures/assemblies/destination"
      />
    );
    expect(await screen.findByText('destination')).toBeInTheDocument();
    expect(screen.getByText('destination').closest('[data-entry-path]')).toHaveClass(
      'bg-accent/15'
    );
    expect(screen.queryByText('project-child')).toBeNull();
  });

  it('keeps every project collapsed when no destination is assigned', async () => {
    fsMock.readDir.mockImplementation(async () => [{ name: 'child', isDirectory: true }]);
    const onSelectFolder = vi.fn();
    render(
      <WorkspaceFolderPicker
        {...base}
        initialDir=""
        selectedDir=""
        onSelectFolder={onSelectFolder}
      />
    );

    await waitFor(() => expect(fsMock.readDir).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByText('child')).toHaveLength(0);
    expect(onSelectFolder).not.toHaveBeenCalled();
  });

  it('opens only the owning project when mounted project paths are nested', async () => {
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') return [{ name: 'outer-child', isDirectory: true }];
      if (dir === '/w/proj/nested') return [{ name: 'destination', isDirectory: true }];
      return [];
    });
    render(
      <WorkspaceFolderPicker
        {...base}
        roots={[...base.roots, { path: '/w/proj/nested', name: 'Nested project' }]}
        initialDir="/w/proj/nested/destination"
        selectedDir="/w/proj/nested/destination"
      />
    );
    expect(await screen.findByText('destination')).toBeInTheDocument();
    expect(screen.queryByText('outer-child')).toBeNull();
  });

  it('reveals the inline new-folder editor in a collapsed project', async () => {
    render(<WorkspaceFolderPicker {...base} surface="bare" />);
    rightClickRoot('/w/fixtures');
    fireEvent.click(screen.getByText('New Folder'));
    expect(await screen.findByDisplayValue('New Folder')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByDisplayValue('New Folder'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByDisplayValue('New Folder')).toBeNull());
  });

  it('a single click on a root SELECTS it (shifts focus/selection), not only expands', () => {
    const onSelectFolder = vi.fn();
    render(<WorkspaceFolderPicker {...base} onSelectFolder={onSelectFolder} />);
    fireEvent.click(screen.getByTestId('workspace-folder-picker-folder-/w/proj'));
    expect(onSelectFolder).toHaveBeenCalledWith('/w/proj');
  });

  it('applies the selected highlight to the selected root', () => {
    render(<WorkspaceFolderPicker {...base} selectedDir="/w/proj" />);
    expect(screen.getByTestId('workspace-folder-picker-folder-/w/proj').className).toContain(
      'text-accent'
    );
  });

  it('has NO standalone New folder button — folders are created via the menu', () => {
    render(<WorkspaceFolderPicker {...base} />);
    expect(screen.queryByTestId('workspace-folder-picker-new-folder')).toBeNull();
    expect(screen.queryByTestId('workspace-folder-picker-new-folder-input')).toBeNull();
  });

  it('right-click menu offers Open / New Folder / Copy Path / Reveal — and gates OFF Delete + Move', () => {
    render(<WorkspaceFolderPicker {...base} />);
    rightClickRoot('/w/proj');

    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('New Folder')).toBeInTheDocument();
    expect(screen.getByText('Copy Path')).toBeInTheDocument();
    expect(screen.getByText('Show in folder')).toBeInTheDocument();

    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.queryByText('Move to…')).toBeNull();

    expect(screen.queryByText('Rename')).toBeNull();
  });

  it('New Folder creates an INLINE editable ghost row (no pop-up form)', async () => {
    render(<WorkspaceFolderPicker {...base} />);
    rightClickRoot('/w/proj');
    fireEvent.click(screen.getByText('New Folder'));
    const input = (await screen.findByDisplayValue('New Folder')) as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
  });

  it('committing a new folder runs the create path and selects the composed path', async () => {
    const onSelectFolder = vi.fn();
    render(<WorkspaceFolderPicker {...base} onSelectFolder={onSelectFolder} />);
    rightClickRoot('/w/proj');
    fireEvent.click(screen.getByText('New Folder'));
    const input = await screen.findByDisplayValue('New Folder');
    fireEvent.change(input, { target: { value: 'primers' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSelectFolder).toHaveBeenCalledWith('/w/proj/primers'));
  });

  it('cancelling the ghost row (Escape) removes it without creating anything', async () => {
    render(<WorkspaceFolderPicker {...base} />);
    rightClickRoot('/w/proj');
    fireEvent.click(screen.getByText('New Folder'));
    const input = await screen.findByDisplayValue('New Folder');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByDisplayValue('New Folder')).toBeNull());
  });

  describe('auto-reveal to initialDir  follow-up)', () => {
    afterEach(() => {
      fsMock.readDir.mockReset();
      fsMock.readDir.mockImplementation(async () => []);
      safeFocusMocks.scrollIntoNearestScrollContainer.mockClear();
    });

    it('scrolls the default/suggested folder into view once its row mounts', async () => {
      fsMock.readDir.mockImplementation(async (dirPath: string) => {
        if (dirPath === '/w/proj') return [{ name: 'sequences', isDirectory: true }];
        return [];
      });

      render(
        <WorkspaceFolderPicker
          {...base}
          initialDir="/w/proj/sequences"
          selectedDir="/w/proj/sequences"
        />
      );

      let targetRow: Element | null = null;
      await waitFor(() => {
        targetRow = document.querySelector('[data-entry-path="/w/proj/sequences"]');
        expect(targetRow).not.toBeNull();
      });
      await waitFor(() =>
        expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledWith(targetRow, {
          block: 'center',
        })
      );
    });

    it('does not scroll again on an unrelated re-render (only once per new initialDir)', async () => {
      fsMock.readDir.mockImplementation(async (dirPath: string) => {
        if (dirPath === '/w/proj') return [{ name: 'sequences', isDirectory: true }];
        return [];
      });

      const { rerender } = render(
        <WorkspaceFolderPicker
          {...base}
          initialDir="/w/proj/sequences"
          selectedDir="/w/proj/sequences"
        />
      );
      await waitFor(() =>
        expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledTimes(1)
      );

      rerender(
        <WorkspaceFolderPicker
          {...base}
          initialDir="/w/proj/sequences"
          selectedDir="/w/proj/sequences"
        />
      );
      expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledTimes(1);
    });
  });
});

describe('WorkspaceFolderPicker — auto-expand + center on open', () => {
  it('centers an initialDir that is itself a workspace root', async () => {
    safeFocusMocks.scrollIntoNearestScrollContainer.mockClear();

    render(<WorkspaceFolderPicker {...base} initialDir="/w/fixtures" selectedDir="/w/fixtures" />);

    await waitFor(() =>
      expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledWith(
        screen.getByTestId('workspace-folder-picker-folder-/w/fixtures'),
        { block: 'center' }
      )
    );
  });

  it('scrolls the initialDir row into view (centered) once it mounts, not just expands it', async () => {
    safeFocusMocks.scrollIntoNearestScrollContainer.mockClear();
    fsMock.readDir.mockImplementation(async (dir: string) =>
      dir === '/w/proj' ? [{ name: 'sequences', isDirectory: true }] : []
    );

    render(
      <WorkspaceFolderPicker
        {...base}
        initialDir="/w/proj/sequences"
        selectedDir="/w/proj/sequences"
      />
    );

    await waitFor(() => expect(screen.getByText('sequences')).toBeTruthy());
    await waitFor(() =>
      expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledWith(
        expect.anything(),
        { block: 'center' }
      )
    );
  });

  it("reveals a TWO-level-deep initialDir even when the root's own listing resolves AFTER the auto-expand attempt (real disk I/O race)", async () => {
    let resolveRootRead: ((entries: Array<{ name: string; isDirectory: boolean }>) => void) | null =
      null;
    fsMock.readDir.mockImplementation(async (dir: string) => {
      if (dir === '/w/proj') {
        return new Promise((resolve) => {
          resolveRootRead = resolve;
        });
      }
      if (dir === '/w/proj/sequences') return [{ name: 'circular', isDirectory: true }];
      return [];
    });

    render(
      <WorkspaceFolderPicker
        {...base}
        initialDir="/w/proj/sequences/circular"
        selectedDir="/w/proj/sequences/circular"
      />
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('sequences')).toBeNull();

    resolveRootRead!([{ name: 'sequences', isDirectory: true }]);
    await waitFor(() => expect(screen.getByText('sequences')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('circular')).toBeTruthy());
  });
});
