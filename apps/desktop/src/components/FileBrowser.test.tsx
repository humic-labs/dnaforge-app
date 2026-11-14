import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react';
import { FileBrowser } from './FileBrowser';
import * as sequencePackageProduct from '../features/sequence/sequence-package-product';
import type { FileEntry } from '../hooks/useFileBrowser';
import type {
  WorkspaceBrowserCatalogEntry,
  WorkspaceBrowserPartialError,
} from '../shared/workspace-browser-types';
import type {
  WorkspaceFileTrashRequest,
  WorkspaceFileTrashResult,
} from '../shared/workspace-file-trash';
import { useToastStore } from '../stores/toast-store';
import { CommandScopeProviderForTest } from '../commands';
import type { TrackViewsBridge } from '../shared/track-view';

function openExplorerAddPicker(rootPath = '/mock/test/workspace'): HTMLElement {
  fireEvent.contextMenu(rootTreeItemByPath(rootPath));
  fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
  return screen.getByTestId('explorer-add-picker');
}

const platformMocks = vi.hoisted(() => ({
  trackViews: {
    locations: vi.fn<TrackViewsBridge['locations']>(async () => ({
      defaultDirectory: '/tmp/waypoint-mock/Track views',
      homeDirectory: '/tmp',
    })),
    list: vi.fn<TrackViewsBridge['list']>(async () => ({ views: [], errors: [] })),
  },
  exists: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  assertFileDocumentsClean: vi.fn<(path: string) => Promise<void>>(),
  writeWorkspaceBinaryFileAtomic: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  fileTrash: vi.fn(),
  trashItem: vi.fn(),
  validateWorkspacePath: vi.fn(),
  revealItemInDir: vi.fn(),
  relocateEntityFile: vi.fn(),
  viewExternalSource: vi.fn().mockResolvedValue({
    status: 'ready',
    originalPath: '/imports/benchling.zip',
    sourceDisplayName: 'benchling.zip',
    message: 'Verified original source.',
    entryPath: 'registry/strain.csv',
    displayFilename: 'strain.csv',
    mediaType: 'text/csv',
    text: 'name,Strain A',
    sizeBytes: 13,
    truncated: false,
  }),
}));
const fileBrowserMockState = vi.hoisted(() => ({
  createdEntries: new Map<
    string,
    {
      isDirectory: boolean;
      packageKind?: 'notebook' | 'sequence' | 'protocol' | 'protocol-run';
    }
  >(),
  expandedPaths: new Set<string>(['/mock/test/workspace/notes']),
  gitStatusMap: new Map<string, string>(),
  catalogEntriesByParent: new Map<string, readonly WorkspaceBrowserCatalogEntry[]>(),
  partialError: null as WorkspaceBrowserPartialError | null,
  expandDirectory: vi.fn(),
  expandPathChain: vi.fn(),
  collapseDirectory: vi.fn(),
}));

async function runFileTrashMock(
  request: WorkspaceFileTrashRequest
): Promise<WorkspaceFileTrashResult> {
  if (request.kind === 'list') return { kind: 'list', entries: [], errors: [], nextOffset: null };
  if (request.kind !== 'inspect' && request.kind !== 'trash')
    throw new Error(`Unexpected file Trash operation: ${request.kind}`);
  const type = request.path.endsWith('/notes') ? ('directory' as const) : ('file' as const);
  if (request.kind === 'inspect')
    return {
      kind: 'inspect',
      source: {
        path: request.path,
        type,
        size: 10,
        contentHash: null,
        revision: 'inspected-source-revision',
      },
    };
  fileBrowserMockState.createdEntries.delete(request.path);
  return {
    kind: 'trash',
    changed: true,
    warnings: [],
    entry: {
      id: '11111111-1111-4111-8111-111111111111',
      originalPath: request.path.slice(request.workspaceRoot.length + 1),
      type,
      size: 10,
      trashedAt: '2026-10-30T20:00:00.000Z',
      revision: 'recovery-entry-revision',
      deletionStarted: false,
    },
  };
}
vi.mock('../features/workspace-session/public/electron-session', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../features/workspace-session/public/electron-session')
  >()),
  captureWorkspaceSessionIntent: () => () => {},
}));

const safeFocusMocks = vi.hoisted(() => ({
  scrollIntoNearestScrollContainer: vi.fn(() => true),
}));
const catalogMocks = vi.hoisted(() => ({
  getCatalogFileForPath: vi.fn(),
  registerWorkspaceFile: vi.fn().mockResolvedValue({ id: 'catalog-entity-1' }),
  rebindCatalogFilePath: vi.fn().mockResolvedValue({ updated: 1, missingOldPath: false }),
  markCatalogPathMissing: vi.fn().mockResolvedValue({ updated: 1 }),
}));
const notebookRenameMocks = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  renamePageArtifact: vi.fn(),
}));
vi.mock('../features/page/public/store', () => ({
  usePageStore: { getState: () => notebookRenameMocks },
}));
const artifactMocks = vi.hoisted(() => ({
  recordWorkspaceArtifactFileRenameInProjectMemory: vi.fn(),
}));
const mutationMocks = vi.hoisted(() => ({
  withRendererWorkspaceMutation: vi.fn(),
}));
const telemetryMocks = vi.hoisted(() => ({
  beginWorkflowAction: vi.fn(),
  observeWorkflowAction: vi.fn(),
  operations: [] as Array<{
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }>,
}));
const packageCopyMocks = vi.hoisted(() => ({ duplicateHostedSequencePackage: vi.fn() }));
vi.mock('../hosted/duplicate-sequence-package', () => packageCopyMocks);

let mockSharedRole: 'viewer' | 'editor' | null = null;
vi.mock('../features/workspace-loader/public/use-project-edit-folders', () => ({
  useProjectEditFolders: () =>
    mockWorkspaceState.folders.map((folder) => ({
      ...folder,
      sharedEditAccess: { kind: 'ready', role: mockSharedRole },
    })),
}));

let mockWorkspaceState = {
  folders: [] as Array<{ path: string; name: string; addedAt: number; pinned?: boolean }>,
  pendingImports: [] as Array<Record<string, unknown>>,
  activeWorkspaceFile: null as string | null,
  expandedPaths: new Set<string>(),
  selectedPath: null as string | null,
  revealRequestId: 0,
  revealTargetPath: null as string | null,
  revealTargetPaths: [] as string[],
  isLoading: false,
  error: null as string | null,
};

const mockRemoveFolder = vi.fn((path: string) => {
  mockWorkspaceState.folders = mockWorkspaceState.folders.filter((f) => f.path !== path);
});
const mockClearWorkspace = vi.fn(() => {
  mockWorkspaceState.folders = [];
  mockWorkspaceState.activeWorkspaceFile = null;
  mockWorkspaceState.expandedPaths = new Set();
  mockWorkspaceState.selectedPath = null;
});
const mockExpandPath = vi.fn((path: string) => {
  mockWorkspaceState.expandedPaths = new Set([...mockWorkspaceState.expandedPaths, path]);
});
const mockCollapsePath = vi.fn((path: string) => {
  const next = new Set(mockWorkspaceState.expandedPaths);
  next.delete(path);
  mockWorkspaceState.expandedPaths = next;
});
const mockSetSelectedPath = vi.fn((path: string | null) => {
  mockWorkspaceState.selectedPath = path;
});
const mockRevealPath = vi.fn((path: string) => {
  mockWorkspaceState.revealRequestId += 1;
  mockWorkspaceState.revealTargetPath = path;
  mockWorkspaceState.selectedPath = path;
});

vi.mock('../stores/workspaceStore', () => ({
  useWorkspaceStore: vi.fn(() => ({
    ...mockWorkspaceState,
    removeFolder: mockRemoveFolder,
    clearWorkspace: mockClearWorkspace,
    expandPath: mockExpandPath,
    collapsePath: mockCollapsePath,
    setSelectedPath: mockSetSelectedPath,
    revealPath: mockRevealPath,
  })),
}));

vi.mock('../utils/environment', () => ({
  isBrowserOnly: vi.fn(() => false),
  isHostedBrowserRuntime: vi.fn(() => false),
}));

vi.mock('../shared/utils/safeFocus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/safeFocus')>();
  return {
    ...actual,
    scrollIntoNearestScrollContainer: safeFocusMocks.scrollIntoNearestScrollContainer,
  };
});

vi.mock('../platform', () => ({
  platform: vi.fn(() => ({
    scientificObjects: { catalog: vi.fn(async () => ({ head: null, entries: [] })) },
    trackViews: platformMocks.trackViews,
    fs: {
      validateWorkspacePath: platformMocks.validateWorkspacePath,
      exists: platformMocks.exists,
      stat: platformMocks.stat,
      readFile: platformMocks.readFile,
      assertFileDocumentsClean: platformMocks.assertFileDocumentsClean,
      writeWorkspaceBinaryFileAtomic: platformMocks.writeWorkspaceBinaryFileAtomic,
      writeTextFile: platformMocks.writeTextFile,
      mkdir: platformMocks.mkdir,
      rename: platformMocks.rename,
    },
    workspace: {
      relocateEntityFile: platformMocks.relocateEntityFile,
    },
    benchlingMigration: {
      viewExternalSource: platformMocks.viewExternalSource,
    },
    shell: {
      fileTrash: platformMocks.fileTrash,
      trashItem: platformMocks.trashItem,
      revealItemInDir: platformMocks.revealItemInDir,
      execute: vi.fn().mockResolvedValue({ stdout: '', stderr: '', code: 1 }),
    },
  })),
}));

vi.mock('../db/workspace-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/workspace-catalog')>();
  return {
    ...actual,
    resolveWorkspaceScope: async () => 'workspace:1',
    findWorkspaceRootForPath: (folders: Array<{ path: string }>, filePath: string) =>
      folders
        .filter((folder) => filePath === folder.path || filePath.startsWith(`${folder.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null,
    registerWorkspaceFile: catalogMocks.registerWorkspaceFile,
    getCatalogFileForPath: catalogMocks.getCatalogFileForPath,
    rebindCatalogFilePath: catalogMocks.rebindCatalogFilePath,
    markCatalogPathMissing: catalogMocks.markCatalogPathMissing,
    getCatalogEntityForFilePath: async () => null,
  };
});

vi.mock('../db/workspace-artifacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/workspace-artifacts')>();
  return {
    ...actual,
    recordWorkspaceArtifactFileRenameInProjectMemory:
      artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory,
  };
});

vi.mock('../services/workspace-mutation-transaction', () => ({
  withRendererWorkspaceMutation: mutationMocks.withRendererWorkspaceMutation,
}));

vi.mock('../services/workspace-operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/workspace-operations')>();
  return {
    ...actual,
    reconcileWorkspaceAfterFilesChanged: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/workflow-telemetry', () => ({
  beginWorkflowAction: telemetryMocks.beginWorkflowAction,
  observeWorkflowAction: telemetryMocks.observeWorkflowAction,
}));

vi.mock('../hooks/useGitStatus', () => ({
  notifyGitStatusChanged: vi.fn(),
  useGitStatus: () => ({
    statusMap: fileBrowserMockState.gitStatusMap,
    isTracked: fileBrowserMockState.gitStatusMap.size > 0,
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useFolderGitState', () => ({
  useFolderGitState: () => ({
    state: 'tracked',
    refresh: vi.fn(),
  }),
}));

vi.mock('../hooks/useFileBrowser', () => ({
  useFileBrowser: (path: string) => {
    type IdentityLessFileEntry = Omit<FileEntry, 'kind' | 'entryId' | 'children'> & {
      children?: IdentityLessFileEntry[];
    };
    const entriesForParent = (parentPath: string) =>
      Array.from(fileBrowserMockState.createdEntries.entries())
        .filter(([entryPath]) => entryPath.slice(0, entryPath.lastIndexOf('/')) === parentPath)
        .map(([entryPath, entry]) => {
          const name = entryPath.split('/').pop() ?? entryPath;
          const lastDot = name.lastIndexOf('.');
          return {
            name: entry.packageKind === 'sequence' ? 'Sequence' : name,
            path: entryPath,
            isDirectory: entry.isDirectory && !entry.packageKind,
            packageKind: entry.packageKind,
            isBiologyFile: entry.packageKind === 'sequence',
            extension:
              !entry.isDirectory && !entry.packageKind && lastDot >= 0
                ? name.slice(lastDot + 1)
                : null,
            children:
              entry.isDirectory && !entry.packageKind ? entriesForParent(entryPath) : undefined,
          };
        });

    const mockFiles: IdentityLessFileEntry[] =
      path === '/mock/test/workspace'
        ? [
            {
              name: 'sample',
              path: '/mock/test/workspace/sample.fasta',
              isDirectory: false,
              isBiologyFile: true,
              extension: 'fasta',
            },
            {
              name: 'plasmid',
              path: '/mock/test/workspace/plasmid.gb',
              isDirectory: false,
              isBiologyFile: true,
              extension: 'gb',
            },
            {
              name: 'chrIV',
              path: '/mock/test/workspace/chrIV.gbff',
              isDirectory: false,
              isBiologyFile: true,
              extension: 'gbff',
            },
            {
              name: 'notes',
              path: '/mock/test/workspace/notes',
              isDirectory: true,
              isBiologyFile: false,
              children: entriesForParent('/mock/test/workspace/notes'),
            },
            ...entriesForParent('/mock/test/workspace'),
          ]
        : entriesForParent(path);

    const attachIdentity = (entry: IdentityLessFileEntry): FileEntry => ({
      ...entry,
      kind: 'filesystem',
      entryId: `filesystem:${entry.path}`,
      children: entry.children?.map(attachIdentity),
    });

    return {
      entries: mockFiles.map(attachIdentity),
      loading: false,
      error: null,
      catalogEntriesByParent: fileBrowserMockState.catalogEntriesByParent,
      partialError: fileBrowserMockState.partialError,
      refresh: vi.fn(),
      expandDirectory: fileBrowserMockState.expandDirectory.mockImplementation(
        (expandedPath: string) => {
          fileBrowserMockState.expandedPaths.add(expandedPath);
        }
      ),
      expandPathChain: fileBrowserMockState.expandPathChain.mockImplementation(
        async (expandedPaths: string[]) => {
          expandedPaths.forEach((expandedPath) => {
            fileBrowserMockState.expandedPaths.add(expandedPath);
          });
        }
      ),
      collapseDirectory: fileBrowserMockState.collapseDirectory.mockImplementation(
        (collapsedPath: string) => {
          fileBrowserMockState.expandedPaths.delete(collapsedPath);
        }
      ),
      expandedPaths: fileBrowserMockState.expandedPaths,
    };
  },
}));

function setMockWorkspaceState(updates: Partial<typeof mockWorkspaceState>) {
  mockWorkspaceState = { ...mockWorkspaceState, ...updates };
}

function rootTreeItemByPath(path: string): HTMLElement {
  const root = Array.from(document.querySelectorAll('button[role="treeitem"]')).find(
    (element) => element.getAttribute('data-entry-path') === path
  );
  if (!(root instanceof HTMLElement)) {
    throw new Error(`Missing root tree item for ${path}`);
  }
  return root;
}

beforeEach(() => {
  mockSharedRole = null;
  mockWorkspaceState = {
    folders: [],
    pendingImports: [],
    activeWorkspaceFile: null,
    expandedPaths: new Set(),
    selectedPath: null,
    revealRequestId: 0,
    revealTargetPath: null,
    revealTargetPaths: [],
    isLoading: false,
    error: null,
  };
  vi.clearAllMocks();
  platformMocks.assertFileDocumentsClean.mockReset().mockResolvedValue(undefined);
  fileBrowserMockState.createdEntries.clear();
  fileBrowserMockState.expandedPaths = new Set<string>(['/mock/test/workspace/notes']);
  fileBrowserMockState.gitStatusMap = new Map<string, string>();
  fileBrowserMockState.catalogEntriesByParent = new Map();
  fileBrowserMockState.partialError = null;
  fileBrowserMockState.expandDirectory.mockReset();
  fileBrowserMockState.expandPathChain.mockReset();
  fileBrowserMockState.collapseDirectory.mockReset();
  useToastStore.setState({ toasts: [] });
  platformMocks.exists.mockReset();
  platformMocks.exists.mockImplementation(async (path: string) =>
    fileBrowserMockState.createdEntries.has(path)
  );
  platformMocks.stat.mockReset();
  platformMocks.stat.mockImplementation(async (path: string) => {
    const createdEntry = fileBrowserMockState.createdEntries.get(path);
    const isDirectory =
      createdEntry?.isDirectory ??
      (path === '/mock/test/workspace/notes' ||
        mockWorkspaceState.folders.some((folder) => folder.path === path));
    return {
      size: 0,
      isFile: !isDirectory,
      isDirectory,
      mtime: 0,
    };
  });
  platformMocks.writeTextFile.mockReset();
  platformMocks.writeTextFile.mockImplementation(async (path: string) => {
    fileBrowserMockState.createdEntries.set(path, { isDirectory: false });
  });
  platformMocks.readFile.mockReset();
  platformMocks.readFile.mockResolvedValue(new Uint8Array([0, 255, 19, 128]));
  platformMocks.writeWorkspaceBinaryFileAtomic.mockReset();
  platformMocks.writeWorkspaceBinaryFileAtomic.mockImplementation(
    async (input: { path: string; content: Uint8Array }) => {
      if (fileBrowserMockState.createdEntries.has(input.path)) {
        throw new Error('A file artifact already exists at that location.');
      }
      fileBrowserMockState.createdEntries.set(input.path, { isDirectory: false });
      return { path: input.path, contentHash: 'sha256:copy' };
    }
  );
  platformMocks.mkdir.mockReset();
  platformMocks.mkdir.mockImplementation(async (path: string) => {
    if (fileBrowserMockState.createdEntries.has(path)) {
      throw new Error(`EEXIST: ${path}`);
    }
    fileBrowserMockState.createdEntries.set(path, { isDirectory: true });
  });
  platformMocks.rename.mockReset();
  platformMocks.rename.mockResolvedValue(undefined);
  platformMocks.relocateEntityFile.mockReset();
  platformMocks.relocateEntityFile.mockImplementation(
    async (input: { workspaceRoot: string | null; oldPath: string; newPath: string }) => ({
      newPath: input.newPath,
      counts: {
        catalog: { updated: 1 },
        indexed: { indexedFilesMoved: 1, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
        lims: { rebasedEntityIds: [], workspaceIds: [] },
      },
    })
  );
  platformMocks.fileTrash.mockReset().mockImplementation(runFileTrashMock);
  platformMocks.trashItem.mockReset().mockResolvedValue(undefined);
  platformMocks.validateWorkspacePath.mockReset().mockResolvedValue(true);
  platformMocks.revealItemInDir.mockReset();
  platformMocks.revealItemInDir.mockResolvedValue(undefined);
  platformMocks.viewExternalSource.mockReset();
  platformMocks.viewExternalSource.mockResolvedValue({
    status: 'ready',
    originalPath: '/imports/benchling.zip',
    sourceDisplayName: 'benchling.zip',
    message: 'Verified original source.',
    entryPath: 'registry/strain.csv',
    displayFilename: 'strain.csv',
    mediaType: 'text/csv',
    text: 'name,Strain A',
    sizeBytes: 13,
    truncated: false,
  });
  catalogMocks.registerWorkspaceFile.mockReset();
  catalogMocks.getCatalogFileForPath.mockReset().mockResolvedValue(null);
  notebookRenameMocks.fetchPage.mockReset().mockResolvedValue({ id: 'notebook-1' });
  notebookRenameMocks.renamePageArtifact.mockReset().mockResolvedValue({
    path: '/mock/test/workspace/Renamed notebook',
    name: 'Renamed notebook',
    fileKind: 'waypoint-notebook',
    sizeBytes: 10,
  });
  catalogMocks.registerWorkspaceFile.mockResolvedValue({ id: 'catalog-entity-1' });
  catalogMocks.rebindCatalogFilePath.mockReset();
  catalogMocks.rebindCatalogFilePath.mockResolvedValue({ updated: 1, missingOldPath: false });
  catalogMocks.markCatalogPathMissing.mockReset();
  catalogMocks.markCatalogPathMissing.mockResolvedValue({ updated: 1 });
  artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory.mockReset();
  artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory.mockResolvedValue(false);
  mutationMocks.withRendererWorkspaceMutation.mockReset();
  mutationMocks.withRendererWorkspaceMutation.mockImplementation(
    async (
      _workspaceRoot: string | null,
      operation: (mutationToken?: string) => Promise<unknown>
    ) => operation('file-browser-rename-token')
  );
  telemetryMocks.operations.length = 0;
  telemetryMocks.beginWorkflowAction.mockReset();
  telemetryMocks.observeWorkflowAction.mockReset();
  telemetryMocks.beginWorkflowAction.mockImplementation(() => {
    const operation = {
      complete: vi.fn(),
      fail: vi.fn(),
      cancel: vi.fn(),
    };
    telemetryMocks.operations.push(operation);
    return operation;
  });
});

afterEach(cleanup);

describe('FileBrowser', () => {
  it('preserves the actual Files file Open action', async () => {
    setMockWorkspaceState({
      folders: [{ path: '/mock/test/workspace', name: 'Project', addedAt: 1 }],
      expandedPaths: new Set(['/mock/test/workspace']),
    });
    const onFileSelect = vi.fn();
    render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText('sample'));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Open$/ }));
    await waitFor(() =>
      expect(onFileSelect).toHaveBeenCalledExactlyOnceWith(
        '/mock/test/workspace/sample.fasta',
        'sequence'
      )
    );
  });

  it.each(['root', 'nested folder'] as const)(
    'omits inert Open from the actual %s context menu',
    (kind) => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Project', addedAt: 1 }],
        expandedPaths: new Set(['/mock/test/workspace']),
      });
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);
      const target =
        kind === 'root' ? rootTreeItemByPath('/mock/test/workspace') : screen.getByText('notes');
      fireEvent.contextMenu(target);
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /^Open$/ })).not.toBeInTheDocument();
      expect(onFileSelect).not.toHaveBeenCalled();
    }
  );

  describe('empty state', () => {
    it('uses project terminology when no project is mounted', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onImportEntity={vi.fn()} />);

      expect(screen.getByText(/No projects/i)).toBeInTheDocument();
      expect(screen.queryByText(/workspace/i)).not.toBeInTheDocument();
    });

    it('shows add folder prompt when empty', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      expect(screen.getByTestId('file-browser-open-folder')).toBeInTheDocument();
    });
  });

  describe('workspace header', () => {
    it('uses static project chrome instead of impersonating one mounted project', () => {
      setMockWorkspaceState({
        folders: [{ path: '/managed/project-a/repo', name: 'repo', addedAt: Date.now() }],
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Plasmid Project A',
              lastOpenedAt: Date.now(),
              originPath: '/Users/me/plasmid-project-a',
            },
          ]}
        />
      );

      expect(screen.getByText('Projects')).toBeInTheDocument();
      expect(screen.getByText('1 open')).toBeInTheDocument();
      expect(screen.queryByTestId('project-header-switcher')).not.toBeInTheDocument();
      expect(screen.queryByTestId('share-snapshot-button')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Manage projects' })).toHaveTextContent(
        'Manage projects'
      );
      const projectRoot = rootTreeItemByPath('/managed/project-a/repo');
      expect(projectRoot).toHaveTextContent('Plasmid Project A');
      expect(projectRoot).not.toHaveTextContent(/^repo$/);
      expect(projectRoot).not.toHaveAttribute('title');
      expect(projectRoot).toHaveAttribute('data-entry-path', '/managed/project-a/repo');
      const name = within(projectRoot).getByTestId('project-root-name');
      expect(name).toHaveTextContent('Plasmid Project A');
      expect(name.className).toMatch(/group-hover:overflow-visible/);
      expect(name.className).toMatch(/group-focus-within:overflow-visible/);
      expect(name.className).not.toMatch(/z-10/);
      const actions = screen.getByTestId('project-root-actions');
      expect(actions.className).toMatch(/\bz-20\b/);
      expect(
        screen.getByRole('button', { name: 'Create in Plasmid Project A' })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Project actions for Plasmid Project A' })
      ).toBeInTheDocument();
    });

    it('summarizes project count without repeating project names above the tree', () => {
      setMockWorkspaceState({
        folders: [
          { path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() },
          { path: '/managed/project-b/repo', name: 'Project B', addedAt: Date.now() },
        ],
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Project A',
              lastOpenedAt: Date.now(),
              originPath: '/Users/me/project-a',
            },
            {
              entry: null,
              repoPath: '/managed/project-b/repo',
              name: 'Project B',
              lastOpenedAt: Date.now(),
              originPath: '/Users/me/project-b',
            },
          ]}
        />
      );

      expect(screen.getByText('Projects')).toBeInTheDocument();
      expect(screen.getByText('2 open')).toBeInTheDocument();
      expect(screen.queryByText('Project A, Project B')).not.toBeInTheDocument();
    });

    it('has import project button', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      expect(screen.getAllByRole('button', { name: 'Import project' }).length).toBeGreaterThan(0);
    });

    it('shows project actions on each mounted managed project root', () => {
      setMockWorkspaceState({
        folders: [{ path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() }],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Project A',
              lastOpenedAt: Date.now(),
              originPath: '/Users/me/project-a',
            },
          ]}
        />
      );

      expect(
        screen.getByRole('button', { name: 'Project actions for Project A' })
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create in Project A' })).toBeInTheDocument();

      const projectRoot = rootTreeItemByPath('/managed/project-a/repo');
      expect(projectRoot.querySelector('svg[viewBox="0 0 6 10"]')).toBeNull();
      expect(projectRoot.firstElementChild?.querySelector('path[d="M9 5l7 7-7 7"]')).not.toBeNull();
      expect(projectRoot.parentElement).not.toHaveClass('border-l-2');
      expect(projectRoot.parentElement).not.toHaveClass('border-b');
    });

    it('updates Files creation and context actions in place when a shared project role changes', async () => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Shared', addedAt: 1 }],
      });
      const mountedProjects = [
        {
          entry: null,
          repoPath: '/mock/test/workspace',
          name: 'Shared',
          lastOpenedAt: null,
          originPath: null,
        },
      ];
      mockSharedRole = 'viewer';
      const view = render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={mountedProjects}
        />
      );
      expect(screen.queryByRole('button', { name: 'Create in Shared' })).not.toBeInTheDocument();
      fireEvent.contextMenu(rootTreeItemByPath('/mock/test/workspace'));
      expect(screen.queryByRole('menuitem', { name: 'New Folder' })).not.toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      mockSharedRole = 'editor';
      view.rerender(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={mountedProjects}
        />
      );
      expect(screen.getByRole('button', { name: 'Create in Shared' })).toBeInTheDocument();
      fireEvent.contextMenu(rootTreeItemByPath('/mock/test/workspace'));
      expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeInTheDocument();
      mockSharedRole = 'viewer';
      view.rerender(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={mountedProjects}
        />
      );
      expect(screen.queryByRole('menuitem', { name: 'New Folder' })).not.toBeInTheDocument();
      expect(platformMocks.mkdir).not.toHaveBeenCalled();
      expect(platformMocks.rename).not.toHaveBeenCalled();
    });

    it('renders pinned fixture roots as reference projects without write controls', () => {
      fileBrowserMockState.createdEntries.set('/repo/test-fixtures/example.gb', {
        isDirectory: false,
      });
      setMockWorkspaceState({
        folders: [
          {
            path: '/repo/test-fixtures',
            name: 'Test Fixtures',
            addedAt: Date.now(),
            pinned: true,
          },
        ],
        expandedPaths: new Set(['/repo/test-fixtures']),
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/repo/test-fixtures',
              name: 'Test Fixtures',
              lastOpenedAt: null,
              originPath: null,
              access: 'reference',
            },
          ]}
        />
      );

      expect(
        screen.getByRole('button', { name: 'Project actions for Test Fixtures' })
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Create in Test Fixtures' })).toBeNull();
      const fixtureRoot = rootTreeItemByPath('/repo/test-fixtures');
      expect(fixtureRoot.querySelector('[data-project-root-icon="true"]')).not.toBeNull();

      const fixtureFile = screen
        .getByText('example')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;
      fireEvent.contextMenu(fixtureFile);
      for (const writeAction of [
        'Duplicate',
        'Rename',
        'Move to…',
        'Delete',
        'New Folder',
        'New…',
      ]) {
        expect(screen.queryByRole('menuitem', { name: writeAction })).not.toBeInTheDocument();
      }

      fireEvent.keyDown(fixtureFile, { key: 'Delete' });
      fireEvent(
        window,
        new CustomEvent('waypoint-file-move', {
          detail: {
            sourcePath: '/repo/test-fixtures/example.gb',
            destDir: '/repo/test-fixtures/archive',
          },
        })
      );

      expect(platformMocks.fileTrash).not.toHaveBeenCalled();
      expect(platformMocks.relocateEntityFile).not.toHaveBeenCalled();
      expect(useToastStore.getState().toasts).toContainEqual(
        expect.objectContaining({ message: 'Reference projects are read-only.', type: 'warning' })
      );
    });

    it('shows project action tooltips above the buttons and dismisses them on click', () => {
      vi.useFakeTimers();
      setMockWorkspaceState({
        folders: [{ path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() }],
      });

      try {
        render(
          <FileBrowser
            onFileSelect={vi.fn()}
            onAddFolder={vi.fn()}
            mountedProjects={[
              {
                entry: null,
                repoPath: '/managed/project-a/repo',
                name: 'Project A',
                lastOpenedAt: Date.now(),
                originPath: '/Users/me/project-a',
              },
            ]}
          />
        );

        const createButton = screen.getByRole('button', { name: 'Create in Project A' });
        fireEvent.mouseEnter(createButton.parentElement as HTMLElement);
        act(() => {
          vi.advanceTimersByTime(300);
        });

        expect(screen.getByRole('tooltip')).toHaveTextContent('Create in Project A');
        expect(screen.getByRole('tooltip')).toHaveStyle({ top: '-8px' });

        fireEvent.click(createButton);

        const picker = screen.getByTestId('explorer-add-picker');
        expect(picker).toHaveAttribute('data-destination-path', '/managed/project-a/repo');
        expect(within(picker).getByRole('menuitem', { name: 'DNA sequences' })).toBeEnabled();
        expect(screen.queryByTestId('project-create-menu')).not.toBeInTheDocument();
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    it('calls onAddFolder when add button clicked', () => {
      const onAddFolder = vi.fn();
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={onAddFolder} />);

      fireEvent.click(screen.getAllByRole('button', { name: 'Import project' })[0]);

      expect(onAddFolder).toHaveBeenCalled();
    });

    it('opens the DNAForge-styled native cascade from a project-scoped Add menu', () => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onImportFile={vi.fn()}
          onNewNotebook={vi.fn()}
          onNewAssembly={vi.fn()}
        />
      );

      expect(screen.queryByRole('button', { name: 'New…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New text file' })).not.toBeInTheDocument();

      const picker = openExplorerAddPicker();
      expect(picker).toHaveAttribute('data-placement', 'native-cascade');
      expect(picker).toHaveAttribute('data-launch-source', 'context-menu');
      expect(picker).toHaveAttribute('data-destination-path', '/mock/test/workspace');
      expect(within(picker).queryByText('Project-scale actions')).not.toBeInTheDocument();
      for (const type of [
        { label: 'Notebook Entry', id: 'notebook' },
        { label: 'Assembly', id: 'assembly' },
        { label: 'DNA sequences', id: 'dna-sequences' },
        { label: 'DNA oligos', id: 'dna-oligos' },
        { label: 'RNA oligos', id: 'rna-oligos' },
        { label: 'Strains', id: 'strains' },
        { label: 'Proteins', id: 'proteins' },
        { label: 'More Registry types…', id: 'registry-types' },
      ]) {
        const typeItem = within(picker).getByRole('menuitem', { name: type.label });
        expect(typeItem).toBeVisible();
        expect(within(typeItem).getByTestId(`entity-icon-${type.id}`)).toBeInTheDocument();
        if (type.id === 'notebook') {
          expect(typeItem.querySelector('svg[data-tab-type-icon="page"]')).not.toBeNull();
        }
        if (type.id === 'proteins') {
          expect(typeItem.querySelector('svg[data-file-type-icon="structure"]')).not.toBeNull();
        }
        if (type.id === 'dna-oligos' || type.id === 'rna-oligos') {
          expect(typeItem.querySelector('line[x1="2.5"][x2="16"]')).not.toBeNull();
          expect(typeItem.querySelectorAll('line')).toHaveLength(1);
        }
      }
      expect(within(picker).queryByText(/organisms|guide rnas/i)).not.toBeInTheDocument();
      expect(within(picker).queryByText('Files', { exact: true })).not.toBeInTheDocument();
      for (const name of ['Import a project', 'Import with agent', 'Migrate from Benchling']) {
        expect(within(picker).queryByRole('menuitem', { name })).not.toBeInTheDocument();
      }
      expect(within(picker).queryByText(/plasmid|chromosome/i)).not.toBeInTheDocument();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      expect(
        within(within(picker).getByRole('menu', { name: 'DNA sequences actions' })).getByRole(
          'menuitem',
          { name: 'Create' }
        )
      ).toBeDisabled();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Notebook Entry' }));
      const notebookActions = within(picker).getByRole('menu', { name: 'Notebook Entry actions' });
      expect(within(notebookActions).getByRole('menuitem', { name: 'Create' })).toBeEnabled();
      expect(within(notebookActions).queryByRole('menuitem', { name: 'Import' })).toBeNull();
    });

    it('offers blank and schema-backed assemblies as one cohesive New menu branch', () => {
      const onCreateAssembly = vi.fn();
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onCreateAssembly={onCreateAssembly}
        />
      );

      let picker = openExplorerAddPicker();
      expect(within(picker).queryByRole('menuitem', { name: 'Assemblies' })).toBeNull();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Assembly' }));
      let actions = within(picker).getByRole('menu', { name: 'Assembly actions' });
      fireEvent.click(within(actions).getByRole('menuitem', { name: 'Blank assembly' }));
      expect(onCreateAssembly).toHaveBeenLastCalledWith({
        mode: 'blank',
        destinationPath: '/mock/test/workspace',
      });

      picker = openExplorerAddPicker();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Assembly' }));
      actions = within(picker).getByRole('menu', { name: 'Assembly actions' });
      fireEvent.click(within(actions).getByRole('menuitem', { name: 'From schema…' }));
      expect(onCreateAssembly).toHaveBeenLastCalledWith({
        mode: 'schema',
        destinationPath: '/mock/test/workspace',
      });
    });

    it('launches one import flow that accepts one or more records', () => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      const onImportEntity = vi.fn();
      render(
        <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onImportEntity={onImportEntity} />
      );

      const picker = openExplorerAddPicker();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA oligos' }));
      const actions = within(picker).getByRole('menu', { name: 'DNA oligos actions' });
      expect(within(actions).getByRole('menuitem', { name: 'Create' })).toBeDisabled();
      fireEvent.click(within(actions).getByRole('menuitem', { name: 'Import' }));

      expect(onImportEntity).toHaveBeenCalledWith({
        entityType: 'dna-oligos',
        destination: { kind: 'explicit', path: '/mock/test/workspace' },
      });
      expect(screen.queryByTestId('explorer-add-picker')).not.toBeInTheDocument();
      expect(screen.queryByRole('menu', { name: /import options/i })).not.toBeInTheDocument();
    });

    it('keeps project migration out of the folder destination even with an App callback', () => {
      const onMigrateFromBenchling = vi.fn();
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onMigrateFromBenchling={onMigrateFromBenchling}
        />
      );

      const picker = openExplorerAddPicker();
      expect(
        within(picker).queryByRole('menuitem', { name: 'Migrate from Benchling' })
      ).not.toBeInTheDocument();
      expect(onMigrateFromBenchling).not.toHaveBeenCalled();
    });

    it('enables and routes Create for every entity type from a project-scoped Add menu', async () => {
      const onCreateEntity = vi.fn();
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(
        <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onCreateEntity={onCreateEntity} />
      );

      const openProjectScopedPicker = (): HTMLElement => {
        fireEvent.contextMenu(rootTreeItemByPath('/mock/test/workspace'));
        fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
        return screen.getByTestId('explorer-add-picker');
      };

      const picker = openProjectScopedPicker();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      const dnaActions = within(picker).getByRole('menu', { name: 'DNA sequences actions' });
      const create = within(dnaActions).getByRole('menuitem', { name: 'Create' });
      expect(create).toBeEnabled();
      fireEvent.click(create);

      expect(onCreateEntity).not.toHaveBeenCalled();
      expect(screen.queryByTestId('explorer-add-picker')).not.toBeInTheDocument();

      const nameInput = await screen.findByDisplayValue('Untitled DNA sequence');
      fireEvent.change(nameInput, { target: { value: 'Named sequence' } });
      fireEvent.keyDown(nameInput, { key: 'Enter' });

      await waitFor(() => {
        expect(onCreateEntity).toHaveBeenCalledWith({
          entityType: 'dna-sequences',
          destinationPath: '/mock/test/workspace',
          name: 'Named sequence',
          creationId: expect.any(String),
        });
      });

      const remainingTypes = [
        { label: 'DNA oligos', entityType: 'dna-oligos' },
        { label: 'RNA oligos', entityType: 'rna-oligos' },
        { label: 'Strains', entityType: 'strains' },
        { label: 'Proteins', entityType: 'proteins' },
        { label: 'More Registry types…', entityType: 'registry-types' },
      ] as const;
      for (const type of remainingTypes) {
        const reopenedPicker = openProjectScopedPicker();
        fireEvent.click(within(reopenedPicker).getByRole('menuitem', { name: type.label }));
        const createAction = within(
          within(reopenedPicker).getByRole('menu', { name: `${type.label} actions` })
        ).getByRole('menuitem', { name: 'Create' });
        expect(createAction).toBeEnabled();
        fireEvent.click(createAction);

        expect(onCreateEntity).toHaveBeenLastCalledWith({
          entityType: type.entityType,
          destinationPath: '/mock/test/workspace',
        });
        expect(screen.queryByTestId('explorer-add-picker')).not.toBeInTheDocument();
      }
    });

    it('creates a notebook only through the project-scoped picker with its notebook icon', async () => {
      const onNewNotebook = vi.fn();
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onNewNotebook={onNewNotebook}
          onNewAssembly={vi.fn()}
        />
      );

      fireEvent.contextMenu(rootTreeItemByPath('/mock/test/workspace'));
      const contextMenu = screen.getByRole('menu', { name: 'File actions for workspace' });
      expect(within(contextMenu).queryByRole('menuitem', { name: 'Notebook Entry' })).toBeNull();
      expect(within(contextMenu).queryByRole('menuitem', { name: 'Assembly' })).toBeNull();
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
      const picker = screen.getByTestId('explorer-add-picker');
      expect(within(picker).getByRole('menuitem', { name: 'Assembly' })).toBeVisible();
      const notebookItem = within(picker).getByRole('menuitem', { name: 'Notebook Entry' });
      expect(notebookItem.querySelector('svg[data-tab-type-icon="page"]')).not.toBeNull();
      fireEvent.click(notebookItem);
      const notebookActions = within(picker).getByRole('menu', { name: 'Notebook Entry actions' });
      expect(notebookActions.querySelector('svg[data-tab-type-icon="page"]')).not.toBeNull();
      fireEvent.click(within(notebookActions).getByRole('menuitem', { name: 'Create' }));

      const nameInput = await screen.findByDisplayValue('Untitled');
      fireEvent.keyDown(nameInput, { key: 'Enter' });

      await waitFor(() => {
        expect(onNewNotebook).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            workspaceRoot: '/mock/test/workspace',
            parentPath: '/mock/test/workspace',
            artifactFileName: 'Untitled',
          })
        );
      });
    });

    it('Manage projects opens over its own button and a second click closes it ', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);
      const trigger = screen.getByRole('button', { name: 'Manage projects' });
      trigger.getBoundingClientRect = () =>
        ({ left: 200, top: 50, right: 300, bottom: 78, width: 100, height: 28 }) as DOMRect;

      fireEvent.click(trigger);
      const popover = screen.getByTestId('project-switcher-popover');
      expect(popover.style.left).toBe('195px');
      expect(popover.style.top).toBe('45px');
      expect(trigger).toHaveAttribute('aria-expanded', 'true');

      const triggerRow = screen.getByTestId('project-switcher-trigger-row');
      fireEvent.mouseDown(triggerRow);
      fireEvent.click(triggerRow);
      expect(screen.queryByTestId('project-switcher-popover')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('has no header menu that creates entities outside a project', () => {
      const onImportEntity = vi.fn();
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(
        <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onImportEntity={onImportEntity} />
      );

      expect(screen.queryByRole('button', { name: 'New…' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('explorer-add-picker')).not.toBeInTheDocument();

      const picker = openExplorerAddPicker();
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      fireEvent.click(
        within(within(picker).getByRole('menu', { name: 'DNA sequences actions' })).getByRole(
          'menuitem',
          { name: 'Import' }
        )
      );

      expect(onImportEntity).toHaveBeenCalledWith({
        entityType: 'dna-sequences',
        destination: { kind: 'explicit', path: '/mock/test/workspace' },
      });
      expect(screen.queryByTestId('explorer-add-picker')).not.toBeInTheDocument();
    });
  });

  describe('multi-root display', () => {
    beforeEach(() => {
      setMockWorkspaceState({
        folders: [
          { path: '/path/to/project1', name: 'Project 1', addedAt: Date.now() },
          { path: '/path/to/project2', name: 'Project 2', addedAt: Date.now() },
        ],
      });
    });

    it('displays each root folder as a section', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      const tree = screen.getByRole('tree');
      expect(within(tree).getByText('Project 1')).toBeInTheDocument();
      expect(within(tree).getByText('Project 2')).toBeInTheDocument();
    });

    it('root folders are collapsible', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      const project1 = within(rootTreeItemByPath('/path/to/project1')).getByText('Project 1');
      expect(project1.closest('button')).toBe(rootTreeItemByPath('/path/to/project1'));
    });

    it('root folders have distinct styling', () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      const project1 = within(rootTreeItemByPath('/path/to/project1')).getByText('Project 1');
      expect(project1).toHaveClass('font-semibold');
    });

    it('keeps a pinned root collapsed when a selected descendant remains selected', async () => {
      fileBrowserMockState.createdEntries.set('/mock/dev-assets/pUC19.gb', {
        isDirectory: false,
      });
      setMockWorkspaceState({
        folders: [
          { path: '/mock/dev-assets', name: 'Dev Assets', addedAt: Date.now(), pinned: true },
        ],
        expandedPaths: new Set(['/mock/dev-assets']),
        selectedPath: '/mock/dev-assets/pUC19.gb',
        revealRequestId: 0,
      });

      const props = {
        onFileSelect: vi.fn(),
        onAddFolder: vi.fn(),
        selectedPath: '/mock/dev-assets/pUC19.gb',
      };
      const { rerender } = render(<FileBrowser {...props} />);

      await screen.findByText('pUC19');
      fireEvent.click(screen.getByText('Dev Assets').closest('button') as HTMLElement);
      expect(mockCollapsePath).toHaveBeenCalledWith('/mock/dev-assets');

      rerender(<FileBrowser {...props} />);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockExpandPath).not.toHaveBeenCalledWith('/mock/dev-assets');
      expect(screen.queryByText('pUC19')).not.toBeInTheDocument();
    });
  });

  describe('project menu', () => {
    it('opens project-specific root menu without legacy Save/Open/Close actions', () => {
      setMockWorkspaceState({
        folders: [{ path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() }],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onOpenProjectHome={vi.fn()}
          onTrashProject={vi.fn()}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Project A',
              lastOpenedAt: Date.now(),
              originPath: null,
            },
          ]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Project actions for Project A' }));

      expect(screen.getByText('Show in folder')).toBeInTheDocument();
      expect(screen.getByText('Project history…')).toBeInTheDocument();
      expect(screen.getByText('Archive project…')).toBeInTheDocument();
      expect(screen.getByText('Move to Trash…')).toBeInTheDocument();
      expect(screen.queryByText('Save Workspace')).not.toBeInTheDocument();
      expect(screen.queryByText('Open Workspace')).not.toBeInTheDocument();
      expect(screen.queryByText('Close Workspace')).not.toBeInTheDocument();
    });

    it('routes root menu actions to the clicked project root', () => {
      const onOpenProjectHome = vi.fn();
      setMockWorkspaceState({
        folders: [
          { path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() },
          { path: '/managed/project-b/repo', name: 'Project B', addedAt: Date.now() },
        ],
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onOpenProjectHome={onOpenProjectHome}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Project A',
              lastOpenedAt: Date.now(),
              originPath: null,
            },
            {
              entry: null,
              repoPath: '/managed/project-b/repo',
              name: 'Project B',
              lastOpenedAt: Date.now(),
              originPath: null,
            },
          ]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Project actions for Project B' }));
      fireEvent.click(screen.getByText('Project history…'));

      expect(onOpenProjectHome).toHaveBeenCalledWith('/managed/project-b/repo');
      expect(onOpenProjectHome).not.toHaveBeenCalledWith('/managed/project-a/repo');
    });

    it('opens the shared entity picker for the clicked project root, not the selected project', () => {
      const onCreateEntity = vi.fn();
      setMockWorkspaceState({
        folders: [
          { path: '/managed/project-a/repo', name: 'Project A', addedAt: Date.now() },
          { path: '/managed/project-b/repo', name: 'Project B', addedAt: Date.now() + 1 },
        ],
        expandedPaths: new Set(['/managed/project-a/repo', '/managed/project-b/repo']),
        selectedPath: '/managed/project-a/repo/selected.txt',
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          selectedPath="/managed/project-a/repo/selected.txt"
          onCreateEntity={onCreateEntity}
          mountedProjects={[
            {
              entry: null,
              repoPath: '/managed/project-a/repo',
              name: 'Project A',
              lastOpenedAt: Date.now(),
              originPath: null,
            },
            {
              entry: null,
              repoPath: '/managed/project-b/repo',
              name: 'Project B',
              lastOpenedAt: Date.now(),
              originPath: null,
            },
          ]}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: 'Create in Project B' }));
      const picker = screen.getByTestId('explorer-add-picker');
      expect(picker).toHaveAttribute('data-destination-path', '/managed/project-b/repo');
      expect(picker).not.toHaveAttribute('data-destination-path', '/managed/project-a/repo');
      expect(within(picker).queryByRole('menuitem', { name: 'New text file' })).toBeNull();
    });
  });

  describe('remove project from Files', () => {
    beforeEach(() => {
      setMockWorkspaceState({
        folders: [{ path: '/path/to/project1', name: 'Project 1', addedAt: Date.now() }],
      });
    });

    it('managed project roots have "Archive project..." instead of a hide action', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      const project1 = within(rootTreeItemByPath('/path/to/project1')).getByText('Project 1');
      fireEvent.contextMenu(project1);

      await waitFor(() => {
        expect(screen.getByText('Archive project…')).toBeInTheDocument();
        expect(screen.queryByText('Hide project from Files')).not.toBeInTheDocument();
      });
    });

    it('reference projects can be hidden from Files instead of archived', async () => {
      setMockWorkspaceState({
        folders: [
          { path: '/path/to/project1', name: 'Project 1', addedAt: Date.now() },
          { path: '/mock/dev-assets', name: 'Dev Assets', addedAt: Date.now() + 1, pinned: true },
        ],
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      fireEvent.contextMenu(screen.getByText('Dev Assets'));

      await waitFor(() => {
        expect(screen.getByText('Hide project from Files')).toBeInTheDocument();
        expect(screen.queryByText('Archive project…')).not.toBeInTheDocument();
      });
    });
  });

  describe('context menu creation actions', () => {
    beforeEach(() => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
        expandedPaths: new Set(['/mock/test/workspace']),
      });
    });

    it('does not let a global shortcut guess a project destination', async () => {
      const { rerender } = render(
        <CommandScopeProviderForTest>
          <FileBrowser active onFileSelect={vi.fn()} onAddFolder={vi.fn()} />
        </CommandScopeProviderForTest>
      );

      fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: true });
      expect(screen.queryByDisplayValue('New Folder')).not.toBeInTheDocument();

      rerender(
        <CommandScopeProviderForTest>
          <FileBrowser active={false} onFileSelect={vi.fn()} onAddFolder={vi.fn()} />
        </CommandScopeProviderForTest>
      );
      fireEvent.keyDown(window, { key: 'n', code: 'KeyN', ctrlKey: true, shiftKey: true });
      expect(screen.queryByDisplayValue('New Folder')).not.toBeInTheDocument();
    });

    it('opens the shared type-first cascade beside a right-clicked file', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      expect(screen.getByRole('menuitem', { name: 'New Folder' })).toBeInTheDocument();
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));

      const picker = screen.getByTestId('explorer-add-picker');
      expect(picker).toHaveAttribute('data-launch-source', 'context-menu');
      expect(picker).toHaveAttribute('data-destination-path', '/mock/test/workspace');
      expect(screen.getByRole('menu', { name: 'File actions for plasmid' })).toBeVisible();
      expect(within(picker).getByRole('menuitem', { name: 'DNA sequences' })).toBeVisible();
      expect(within(picker).queryByRole('menuitem', { name: 'Text File' })).not.toBeInTheDocument();
    });

    it('selects and focuses a right-clicked tree row with an app-styled focus ring', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      const plasmidRow = screen
        .getByText('plasmid')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;

      fireEvent.contextMenu(plasmidRow);

      expect(plasmidRow).toHaveFocus();
      expect(mockSetSelectedPath).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb');
      expect(plasmidRow).toHaveClass('outline-none');
      expect(plasmidRow).toHaveClass('focus-visible:ring-accent/45');
    });

    it('wires Copy Relative Path to the filesystem-relative path', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Relative Path' }));

      expect(writeText).toHaveBeenCalledWith('plasmid.gb');
    });

    it('does not include mounted folder display names in copied relative paths', async () => {
      const writeText = vi.fn(() => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });
      fileBrowserMockState.createdEntries.set('/mock/dev-assets/pUC19.gb', {
        isDirectory: false,
      });
      setMockWorkspaceState({
        folders: [
          { path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() },
          { path: '/mock/dev-assets', name: 'Dev Assets', addedAt: Date.now() + 1 },
        ],
        expandedPaths: new Set(['/mock/test/workspace', '/mock/dev-assets']),
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('pUC19')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('pUC19'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy Relative Path' }));

      expect(writeText).toHaveBeenCalledWith('pUC19.gb');
      expect(writeText).not.toHaveBeenCalledWith('Dev Assets/pUC19.gb');
    });

    it('opens the shared native cascade from folder right-click -> New File', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('notes'));
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));

      const picker = screen.getByTestId('explorer-add-picker');
      expect(picker).toHaveAttribute('data-launch-source', 'context-menu');
      expect(within(picker).getByText('Add to folder')).toBeVisible();
      expect(within(picker).getByText('notes/')).toBeVisible();
      expect(screen.getByRole('menu', { name: 'File actions for notes' })).toBeVisible();
      expect(within(picker).getByRole('menuitem', { name: 'DNA sequences' })).toBeVisible();

      fireEvent.click(within(picker).getByRole('menuitem', { name: 'Strains' }));
      expect(within(picker).getByRole('menu', { name: 'Strains actions' })).toBeVisible();
    });

    it('wires Find in Folder... for directory context menus', async () => {
      const onFindInFolder = vi.fn();
      render(
        <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onFindInFolder={onFindInFolder} />
      );

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('notes'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Find in Folder...' }));

      expect(onFindInFolder).toHaveBeenCalledWith('/mock/test/workspace/notes');
    });

    it.each(['context-menu', 'keyboard'])(
      'reports an unreadable sequence package during %s Rename without offering a file move',
      async (gesture) => {
        fileBrowserMockState.createdEntries.set('/mock/test/workspace/physical-package', {
          isDirectory: true,
          packageKind: 'sequence',
        });
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

        const label = await screen.findByText('Sequence');
        if (gesture === 'context-menu') {
          fireEvent.contextMenu(label);
          fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
        } else {
          const row = label.closest('[data-testid="file-tree-item"]') as HTMLElement;
          fireEvent.click(row);
          fireEvent.keyDown(row, { key: 'F2' });
        }

        expect(useToastStore.getState().toasts).toContainEqual(
          expect.objectContaining({
            message: 'Could not open this sequence for renaming.',
            type: 'error',
          })
        );
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
        expect(platformMocks.rename).not.toHaveBeenCalled();
        expect(platformMocks.relocateEntityFile).not.toHaveBeenCalled();
      }
    );

    it('does not double-expand the parent chain when revealing a new pending file inside a collapsed folder  review)', async () => {
      fileBrowserMockState.expandedPaths = new Set();

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onCreateEntity={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('notes'));
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
      const picker = screen.getByTestId('explorer-add-picker');
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      fireEvent.click(
        within(within(picker).getByRole('menu', { name: 'DNA sequences actions' })).getByRole(
          'menuitem',
          { name: 'Create' }
        )
      );

      await screen.findByDisplayValue('Untitled DNA sequence');

      await waitFor(() => {
        expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledWith([
          '/mock/test/workspace/notes',
        ]);
      });
      expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledTimes(1);
    });

    it('repoints selection at the real path on commit, and clears it on cancel, instead of stranding it on the placeholder  review)', async () => {
      const createdPath = '/mock/test/workspace/renamed/renamed.gb';
      const onCreateEntity = vi.fn(() => ({ filePath: createdPath }));
      render(
        <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onCreateEntity={onCreateEntity} />
      );

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
      let picker = screen.getByTestId('explorer-add-picker');
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      fireEvent.click(
        within(within(picker).getByRole('menu', { name: 'DNA sequences actions' })).getByRole(
          'menuitem',
          { name: 'Create' }
        )
      );
      const sequenceInput = await screen.findByDisplayValue('Untitled DNA sequence');
      fireEvent.change(sequenceInput, { target: { value: 'renamed' } });
      fireEvent.keyDown(sequenceInput, { key: 'Enter' });

      await waitFor(() => {
        expect(onCreateEntity).toHaveBeenCalledWith({
          entityType: 'dna-sequences',
          destinationPath: '/mock/test/workspace',
          name: 'renamed',
          creationId: expect.any(String),
        });
      });
      expect(mockRevealPath).toHaveBeenLastCalledWith(createdPath);

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.pointerEnter(screen.getByRole('menuitem', { name: 'New…' }));
      picker = screen.getByTestId('explorer-add-picker');
      fireEvent.click(within(picker).getByRole('menuitem', { name: 'DNA sequences' }));
      fireEvent.click(
        within(within(picker).getByRole('menu', { name: 'DNA sequences actions' })).getByRole(
          'menuitem',
          { name: 'Create' }
        )
      );
      const secondInput = await screen.findByDisplayValue('Untitled DNA sequence');
      fireEvent.keyDown(secondInput, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByDisplayValue('Untitled DNA sequence')).not.toBeInTheDocument();
      });
      expect(mockSetSelectedPath).toHaveBeenLastCalledWith(null);
    });

    it.each(['Notes.txt', 'Notes.md'])(
      'makes registered %s available without starting a project rebuild',
      async (name) => {
        const changed = vi.fn();
        render(
          <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onWorkspaceChanged={changed} />
        );
        await screen.findByText('plasmid');
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Text File', exact: true }));
        const input = await screen.findByTestId('file-tree-rename-input');
        fireEvent.change(input, { target: { value: name } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
            status: 'created',
          })
        );
        expect(platformMocks.writeTextFile).toHaveBeenCalledWith(
          `/mock/test/workspace/${name}`,
          ''
        );
        expect(catalogMocks.registerWorkspaceFile).toHaveBeenCalledWith(
          expect.objectContaining({
            path: `/mock/test/workspace/${name}`,
            entityType: 'file',
            fileKind: 'text',
          })
        );
        expect(changed).not.toHaveBeenCalled();
        expect(mockRevealPath).toHaveBeenCalledWith(`/mock/test/workspace/${name}`);
        expect(screen.queryByTestId('file-tree-rename-input')).not.toBeInTheDocument();
      }
    );

    it.each(['Sequence.gb', 'Notebook.wpnote.json', 'Notes.txt'])(
      'retains project rebuilding for specialized or unregistered %s',
      async (name) => {
        const changed = vi.fn();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        if (name === 'Notes.txt')
          catalogMocks.registerWorkspaceFile.mockRejectedValueOnce(
            new Error('catalog unavailable')
          );
        try {
          render(
            <FileBrowser
              onFileSelect={vi.fn()}
              onAddFolder={vi.fn()}
              onWorkspaceChanged={changed}
            />
          );
          await screen.findByText('plasmid');
          fireEvent.contextMenu(screen.getByText('plasmid'));
          fireEvent.click(screen.getByRole('menuitem', { name: 'Text File', exact: true }));
          const input = await screen.findByTestId('file-tree-rename-input');
          fireEvent.change(input, { target: { value: name } });
          fireEvent.keyDown(input, { key: 'Enter' });
          await waitFor(() => expect(changed).toHaveBeenCalledWith('/mock/test/workspace'));
          expect(platformMocks.writeTextFile).toHaveBeenCalledWith(
            `/mock/test/workspace/${name}`,
            ''
          );
        } finally {
          warning.mockRestore();
        }
      }
    );

    it('creates folders beside a right-clicked file', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));

      const folderInput = await screen.findByDisplayValue('New Folder');
      expect(platformMocks.mkdir).not.toHaveBeenCalled();
      fireEvent.change(folderInput, { target: { value: 'Folder Beside' } });
      fireEvent.keyDown(folderInput, { key: 'Enter' });

      await waitFor(() => {
        expect(platformMocks.mkdir).toHaveBeenCalledWith(
          '/mock/test/workspace/Folder Beside',
          undefined,
          undefined
        );
      });
      expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
        workflow: 'file',
        action: 'create',
        fileTypeCategory: 'unknown',
      });
      expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
        status: 'created',
      });
    });

    it('does not qualify a failed folder create', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      platformMocks.mkdir.mockRejectedValueOnce(new Error('disk unavailable'));
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

        await screen.findByText('plasmid');
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));
        const folderInput = await screen.findByDisplayValue('New Folder');
        fireEvent.change(folderInput, { target: { value: 'Failed Folder' } });
        fireEvent.keyDown(folderInput, { key: 'Enter' });

        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('create_failed')
        );
        expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('creates folders inside a right-clicked folder', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('notes'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));

      const folderInput = await screen.findByDisplayValue('New Folder');
      expect(platformMocks.mkdir).not.toHaveBeenCalled();
      fireEvent.change(folderInput, { target: { value: 'Folder Inside' } });
      fireEvent.keyDown(folderInput, { key: 'Enter' });

      await waitFor(() => {
        expect(platformMocks.mkdir).toHaveBeenCalledWith(
          '/mock/test/workspace/notes/Folder Inside',
          undefined,
          undefined
        );
      });
    });

    it('cancels pending folder creation without touching the filesystem', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New Folder' }));

      const folderInput = await screen.findByDisplayValue('New Folder');
      fireEvent.keyDown(folderInput, { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByDisplayValue('New Folder')).not.toBeInTheDocument();
      });
      expect(platformMocks.mkdir).not.toHaveBeenCalled();
      expect(catalogMocks.registerWorkspaceFile).not.toHaveBeenCalled();
      expect(telemetryMocks.beginWorkflowAction).not.toHaveBeenCalled();
    });

    it('surfaces git color markers for untracked files after git status refreshes', async () => {
      fileBrowserMockState.gitStatusMap = new Map([['plasmid.gb', 'untracked']]);

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toHaveClass('text-green-600');
      });
      expect(screen.getByTitle('Git: untracked')).toHaveClass('bg-green-400');
    });

    it('commits a notebook Enter rename through the shared notebook owner instead of moving its folder', async () => {
      const path = '/mock/test/workspace/Review notebook';
      fileBrowserMockState.createdEntries.set(path, {
        isDirectory: true,
        packageKind: 'notebook',
      });
      catalogMocks.getCatalogFileForPath.mockResolvedValueOnce({
        entity_id: 'notebook-1',
        file_kind: 'waypoint-notebook',
        path,
      });
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      fireEvent.contextMenu(await screen.findByText('Review notebook'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByDisplayValue('Review notebook');
      fireEvent.change(input, { target: { value: 'Renamed notebook' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(notebookRenameMocks.renamePageArtifact).toHaveBeenCalledExactlyOnceWith(
          'notebook-1',
          'Renamed notebook'
        );
      });
      expect(notebookRenameMocks.fetchPage).toHaveBeenCalledWith('notebook-1');
      expect(platformMocks.relocateEntityFile).not.toHaveBeenCalled();
      expect(artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory).not.toHaveBeenCalled();
      expect(screen.queryByTestId('file-tree-rename-input')).not.toBeInTheDocument();
    });

    it('rebinds catalog identity after renaming a file', async () => {
      const onWorkspaceChanged = vi.fn();
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onWorkspaceChanged={onWorkspaceChanged}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      const input = screen.getByDisplayValue('plasmid');
      fireEvent.change(input, { target: { value: 'renamed.gb' } });
      fireEvent.keyDown(input, { key: 'Enter' });

      await waitFor(() => {
        expect(platformMocks.relocateEntityFile).toHaveBeenCalledWith({
          workspaceRoot: '/mock/test/workspace',
          oldPath: '/mock/test/workspace/plasmid.gb',
          newPath: '/mock/test/workspace/renamed.gb',
          mutationToken: 'file-browser-rename-token',
        });
      });
      expect(artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory).toHaveBeenCalledWith({
        oldPath: '/mock/test/workspace/plasmid.gb',
        newPath: '/mock/test/workspace/renamed.gb',
        workspaceRoot: '/mock/test/workspace',
        mutationToken: 'file-browser-rename-token',
      });
      expect(mutationMocks.withRendererWorkspaceMutation).toHaveBeenCalledWith(
        '/mock/test/workspace',
        expect.any(Function)
      );
      expect(platformMocks.rename).not.toHaveBeenCalled();
      expect(catalogMocks.rebindCatalogFilePath).not.toHaveBeenCalled();
      expect(onWorkspaceChanged).toHaveBeenCalledWith('/mock/test/workspace');
      expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
        workflow: 'file',
        action: 'rename',
        fileTypeCategory: 'dna',
      });
      expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
        status: 'updated',
      });
    });

    it('duplicates exact file bytes to a collision-safe sibling and qualifies after reconciliation', async () => {
      const onWorkspaceChanged = vi.fn().mockResolvedValue(undefined);
      fileBrowserMockState.createdEntries.set('/mock/test/workspace/plasmid copy.gb', {
        isDirectory: false,
      });
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onWorkspaceChanged={onWorkspaceChanged}
        />
      );

      await screen.findByText('plasmid');
      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

      await waitFor(() => {
        expect(platformMocks.writeWorkspaceBinaryFileAtomic).toHaveBeenCalledWith({
          workspaceRoot: '/mock/test/workspace',
          path: '/mock/test/workspace/plasmid copy 2.gb',
          content: new Uint8Array([0, 255, 19, 128]),
          mutationToken: 'file-browser-rename-token',
          artifactNoun: 'file',
        });
      });
      expect(platformMocks.readFile).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb');
      expect(onWorkspaceChanged).toHaveBeenCalledWith('/mock/test/workspace');
      expect(mockRevealPath).toHaveBeenCalledWith('/mock/test/workspace/plasmid copy 2.gb');
      expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
        workflow: 'file',
        action: 'duplicate',
        fileTypeCategory: 'dna',
      });
      expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
        status: 'created',
        affectedCount: 1,
      });
      expect(telemetryMocks.operations.at(-1)?.fail).not.toHaveBeenCalled();
    });

    it('routes hosted package Duplicate to the aggregate copy port, not the one-file writer', async () => {
      const { isHostedBrowserRuntime } = await import('../utils/environment');
      vi.mocked(isHostedBrowserRuntime).mockReturnValue(true);
      const source = '/mock/test/workspace/source-package';
      const destination = '/mock/test/workspace/source-package copy';
      fileBrowserMockState.createdEntries.set(source, {
        isDirectory: true,
        packageKind: 'sequence',
      });
      packageCopyMocks.duplicateHostedSequencePackage.mockResolvedValueOnce(destination);
      const changed = vi.fn().mockResolvedValue(undefined);
      try {
        render(
          <FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} onWorkspaceChanged={changed} />
        );
        await screen.findByText('Sequence');
        fireEvent.contextMenu(screen.getByText('Sequence'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
        await waitFor(() =>
          expect(packageCopyMocks.duplicateHostedSequencePackage).toHaveBeenCalledWith(source)
        );
        await waitFor(() => expect(mockRevealPath).toHaveBeenCalledWith(destination));
        expect(platformMocks.writeWorkspaceBinaryFileAtomic).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledWith('/mock/test/workspace');
        expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
          status: 'created',
          affectedCount: 1,
        });
      } finally {
        vi.mocked(isHostedBrowserRuntime).mockReturnValue(false);
      }
    });

    it('does not qualify a duplicate whose atomic write fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      platformMocks.writeWorkspaceBinaryFileAtomic.mockRejectedValueOnce(new Error('disk full'));
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

        await screen.findByText('plasmid');
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('duplicate_failed')
        );
        expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
        expect(mockRevealPath).not.toHaveBeenCalledWith('/mock/test/workspace/plasmid copy.gb');
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('does not qualify a failed rename', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      platformMocks.relocateEntityFile.mockRejectedValueOnce(new Error('MOVE_FAILED: denied'));
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

        await screen.findByText('plasmid');
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
        const input = screen.getByDisplayValue('plasmid');
        fireEvent.change(input, { target: { value: 'blocked.gb' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('rename_failed')
        );
        expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('holds one workspace mutation across drag relocation and Project Memory', async () => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'workspace', addedAt: Date.now() }],
      });
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      window.dispatchEvent(
        new CustomEvent('waypoint-file-move', {
          detail: {
            sourcePath: '/mock/test/workspace/plasmid.gb',
            destDir: '/mock/test/workspace/notes',
          },
        })
      );

      await waitFor(() => {
        expect(platformMocks.relocateEntityFile).toHaveBeenCalledWith({
          workspaceRoot: '/mock/test/workspace',
          oldPath: '/mock/test/workspace/plasmid.gb',
          newPath: '/mock/test/workspace/notes/plasmid.gb',
          mutationToken: 'file-browser-rename-token',
        });
      });
      expect(artifactMocks.recordWorkspaceArtifactFileRenameInProjectMemory).toHaveBeenCalledWith({
        oldPath: '/mock/test/workspace/plasmid.gb',
        newPath: '/mock/test/workspace/notes/plasmid.gb',
        workspaceRoot: '/mock/test/workspace',
        mutationToken: 'file-browser-rename-token',
      });
      expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
        workflow: 'file',
        action: 'move',
        fileTypeCategory: 'dna',
      });
      expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
        status: 'updated',
      });
    });

    it('does not qualify a failed drag relocation', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      platformMocks.relocateEntityFile.mockRejectedValueOnce(new Error('MOVE_FAILED: denied'));
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

        window.dispatchEvent(
          new CustomEvent('waypoint-file-move', {
            detail: {
              sourcePath: '/mock/test/workspace/plasmid.gb',
              destDir: '/mock/test/workspace/notes',
            },
          })
        );

        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('move_failed')
        );
        expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
      } finally {
        consoleErrorSpy.mockRestore();
      }
    });

    it('uses hosted versioned Delete without presenting native Trash promises', async () => {
      const { isHostedBrowserRuntime } = await import('../utils/environment');
      vi.mocked(isHostedBrowserRuntime).mockReturnValue(true);
      const onWorkspaceChanged = vi.fn();
      platformMocks.fileTrash.mockRejectedValue(new Error('Native Trash is unavailable'));
      try {
        render(
          <FileBrowser
            onFileSelect={vi.fn()}
            onAddFolder={vi.fn()}
            onWorkspaceChanged={onWorkspaceChanged}
          />
        );
        await screen.findByText('plasmid');
        expect(screen.queryByTestId('file-trash-open')).toBeNull();
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await waitFor(() =>
          expect(platformMocks.trashItem).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb')
        );
        expect(platformMocks.validateWorkspacePath).toHaveBeenCalledWith({
          workspaceRoot: '/mock/test/workspace',
          path: '/mock/test/workspace/plasmid.gb',
        });
        expect(platformMocks.fileTrash).not.toHaveBeenCalled();
        expect(catalogMocks.markCatalogPathMissing).toHaveBeenCalledWith(
          '/mock/test/workspace/plasmid.gb',
          'deleted'
        );
        expect(onWorkspaceChanged).toHaveBeenCalledWith('/mock/test/workspace');
        expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
          status: 'deleted',
          affectedCount: 1,
        });
      } finally {
        vi.mocked(isHostedBrowserRuntime).mockReturnValue(false);
      }
    });

    it('reports a refused hosted Delete without false success or native Trash recovery advice', async () => {
      const { isHostedBrowserRuntime } = await import('../utils/environment');
      vi.mocked(isHostedBrowserRuntime).mockReturnValue(true);
      const onWorkspaceChanged = vi.fn();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      platformMocks.fileTrash.mockRejectedValue(new Error('Native Trash is unavailable'));
      platformMocks.trashItem.mockRejectedValue(new Error('Finish the pending project mutation.'));
      try {
        render(
          <FileBrowser
            onFileSelect={vi.fn()}
            onAddFolder={vi.fn()}
            onWorkspaceChanged={onWorkspaceChanged}
          />
        );
        await screen.findByText('plasmid');
        fireEvent.contextMenu(screen.getByText('plasmid'));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await waitFor(() =>
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('delete_failed')
        );
        expect(platformMocks.trashItem).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb');
        expect(platformMocks.fileTrash).not.toHaveBeenCalled();
        expect(catalogMocks.markCatalogPathMissing).not.toHaveBeenCalled();
        expect(onWorkspaceChanged).not.toHaveBeenCalled();
        expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
        expect(useToastStore.getState().toasts).toContainEqual(
          expect.objectContaining({
            message:
              'Could not confirm deletion of "plasmid.gb". Reopen the project before retrying.',
          })
        );
      } finally {
        consoleError.mockRestore();
        vi.mocked(isHostedBrowserRuntime).mockReturnValue(false);
      }
    });

    it('moves files into recoverable Trash and marks their catalog binding missing', async () => {
      const onWorkspaceChanged = vi.fn();
      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          onWorkspaceChanged={onWorkspaceChanged}
          selectedPath="/mock/test/workspace/plasmid.gb"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('plasmid'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

      await waitFor(() => {
        expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
          status: 'deleted',
          affectedCount: 1,
        });
      });
      expect(platformMocks.fileTrash).toHaveBeenCalledWith({
        kind: 'trash',
        workspaceRoot: '/mock/test/workspace',
        path: '/mock/test/workspace/plasmid.gb',
        expectedRevision: 'inspected-source-revision',
        mutationToken: 'file-browser-rename-token',
      });
      expect(catalogMocks.markCatalogPathMissing).toHaveBeenCalledWith(
        '/mock/test/workspace/plasmid.gb',
        'moved-to-trash'
      );
      expect(onWorkspaceChanged).toHaveBeenCalledWith('/mock/test/workspace');
      expect(mockSetSelectedPath).toHaveBeenCalledWith(null);
      expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
        workflow: 'file',
        action: 'delete',
        fileTypeCategory: 'dna',
      });
      expect(telemetryMocks.operations.at(-1)?.complete).toHaveBeenCalledWith({
        status: 'deleted',
        affectedCount: 1,
      });
    });

    it.each([
      {
        label: 'confirmed refusal',
        stateChanged: false,
        error: 'Trash is unavailable',
        expectedMessage: 'Could not move "plasmid.gb" to Trash. No files were deleted.',
        deliveryPending: false,
      },
      {
        label: 'uncertain native outcome',
        stateChanged: 'unknown',
        error: 'Native Trash returned no receipt',
        expectedMessage:
          'The file operation could not finish. Inspect File Trash before retrying; a move may have completed.',
        deliveryPending: false,
      },
      {
        label: 'accepted scientific delivery',
        stateChanged: false,
        error: 'Delete accepted; cloud delivery is pending.',
        expectedMessage: 'Delete accepted; cloud delivery is pending.',
        deliveryPending: true,
      },
    ] as const)(
      'surfaces $label trash failure without misstating deletion',
      async ({ stateChanged, error, expectedMessage, deliveryPending }) => {
        const onWorkspaceChanged = vi.fn();
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        platformMocks.fileTrash.mockImplementation((request: WorkspaceFileTrashRequest) =>
          request.kind === 'trash'
            ? deliveryPending
              ? Promise.reject(new Error(error))
              : Promise.resolve({
                  kind: 'failed',
                  code: 'TRASH_UNAVAILABLE',
                  error,
                  stateChanged,
                })
            : runFileTrashMock(request)
        );
        try {
          render(
            <FileBrowser
              onFileSelect={vi.fn()}
              onAddFolder={vi.fn()}
              onWorkspaceChanged={onWorkspaceChanged}
            />
          );

          await waitFor(() => {
            expect(screen.getByText('plasmid')).toBeInTheDocument();
          });

          fireEvent.contextMenu(screen.getByText('plasmid'));
          fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

          await waitFor(() => {
            expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('delete_failed');
          });
          expect(platformMocks.fileTrash).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'trash', path: '/mock/test/workspace/plasmid.gb' })
          );
          expect(catalogMocks.markCatalogPathMissing).not.toHaveBeenCalled();
          if (deliveryPending)
            expect(onWorkspaceChanged).toHaveBeenCalledWith('/mock/test/workspace');
          else expect(onWorkspaceChanged).not.toHaveBeenCalled();
          expect(telemetryMocks.beginWorkflowAction).toHaveBeenCalledWith({
            workflow: 'file',
            action: 'delete',
            fileTypeCategory: 'dna',
          });
          expect(telemetryMocks.operations.at(-1)?.fail).toHaveBeenCalledWith('delete_failed');
          expect(telemetryMocks.operations.at(-1)?.complete).not.toHaveBeenCalled();
          expect(useToastStore.getState().toasts).toContainEqual(
            expect.objectContaining({
              message: expectedMessage,
              type: 'error',
              duration: 0,
            })
          );
        } finally {
          consoleErrorSpy.mockRestore();
        }
      }
    );

    it('honors the filesystem delete shortcut for the focused tree row', async () => {
      Object.defineProperty(navigator, 'platform', {
        value: 'Win32',
        configurable: true,
      });
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('plasmid')).toBeInTheDocument();
      });

      const plasmidRow = screen
        .getByText('plasmid')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;
      fireEvent.click(plasmidRow);
      expect(fireEvent.keyDown(plasmidRow, { key: 'Delete' })).toBe(false);

      await waitFor(() => {
        expect(platformMocks.fileTrash).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'trash', path: '/mock/test/workspace/plasmid.gb' })
        );
      });
    });

    it('moves folders into recoverable Trash without deleting the mounted root folder', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      fireEvent.contextMenu(screen.getByText('notes'));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

      await waitFor(() => {
        expect(platformMocks.fileTrash).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'trash', path: '/mock/test/workspace/notes' })
        );
      });
      expect(catalogMocks.markCatalogPathMissing).toHaveBeenCalledWith(
        '/mock/test/workspace/notes',
        'moved-to-trash'
      );

      fireEvent.contextMenu(rootTreeItemByPath('/mock/test/workspace'));
      expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Archive project…' })).toBeInTheDocument();
    });
  });

  describe('workspace reveal', () => {
    it('loads both nested result paths and highlights both rows until the user selects another', async () => {
      const first = '/mock/test/workspace/notes/first.txt';
      const second = '/mock/test/other/experiments/second.txt';
      fileBrowserMockState.expandedPaths = new Set();
      fileBrowserMockState.createdEntries.set(first, { isDirectory: false });
      fileBrowserMockState.createdEntries.set('/mock/test/other/experiments', {
        isDirectory: true,
      });
      fileBrowserMockState.createdEntries.set(second, { isDirectory: false });
      setMockWorkspaceState({
        folders: [
          { path: '/mock/test/workspace', name: 'Cloning', addedAt: 0 },
          { path: '/mock/test/other', name: 'Yeast', addedAt: 1 },
        ],
        expandedPaths: new Set(['/mock/test/workspace', '/mock/test/other']),
        revealRequestId: 2,
        revealTargetPath: first,
        revealTargetPaths: [first, second],
      });
      const props = { onFileSelect: vi.fn(), onAddFolder: vi.fn(), selectedPath: first };
      const { rerender } = render(<FileBrowser {...props} />);
      await waitFor(() => {
        expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledWith([
          '/mock/test/workspace/notes',
        ]);
        expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledWith([
          '/mock/test/other/experiments',
        ]);
      });
      rerender(<FileBrowser {...props} />);
      const firstRow = screen.getByText('first').closest('[data-testid="file-tree-item"]');
      const secondRow = screen.getByText('second').closest('[data-testid="file-tree-item"]');
      expect(firstRow).toHaveAttribute('aria-selected', 'true');
      expect(secondRow).toHaveAttribute('aria-selected', 'true');
      expect(firstRow).toHaveClass('bg-accent/15');
      expect(secondRow).toHaveClass('bg-accent/15');
      fireEvent.click(screen.getByText('plasmid'));
      expect(firstRow).toHaveAttribute('aria-selected', 'false');
      expect(secondRow).toHaveAttribute('aria-selected', 'false');
    });

    beforeEach(() => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
        expandedPaths: new Set(['/mock/test/workspace']),
        revealRequestId: 1,
        revealTargetPath: '/mock/test/workspace/notes/selected.txt',
      });
    });

    it('loads the full parent chain and scrolls the selected tree row into view', async () => {
      fileBrowserMockState.expandedPaths = new Set();
      fileBrowserMockState.createdEntries.set('/mock/test/workspace/notes/selected.txt', {
        isDirectory: false,
      });

      const props = {
        onFileSelect: vi.fn(),
        onAddFolder: vi.fn(),
        selectedPath: '/mock/test/workspace/notes/selected.txt',
      };
      const { rerender } = render(
        <FileBrowser
          onFileSelect={props.onFileSelect}
          onAddFolder={props.onAddFolder}
          selectedPath={props.selectedPath}
        />
      );

      await waitFor(() => {
        expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledWith([
          '/mock/test/workspace/notes',
        ]);
      });
      rerender(
        <FileBrowser
          onFileSelect={props.onFileSelect}
          onAddFolder={props.onAddFolder}
          selectedPath={props.selectedPath}
        />
      );
      await screen.findByText('selected');
      await waitFor(() => {
        expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledWith(
          expect.anything(),
          { block: 'center' }
        );
      });
      expect(screen.getByText('selected').closest('[data-testid="file-tree-item"]')).toHaveClass(
        'bg-accent/15'
      );
    });

    it('does not keep vertically centering normal selection after a reveal', async () => {
      setMockWorkspaceState({
        revealRequestId: 3,
        revealTargetPath: '/mock/test/workspace/sample.fasta',
      });

      const { rerender } = render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          selectedPath="/mock/test/workspace/sample.fasta"
        />
      );

      await waitFor(() => {
        expect(safeFocusMocks.scrollIntoNearestScrollContainer).toHaveBeenCalledWith(
          expect.anything(),
          { block: 'center' }
        );
      });

      safeFocusMocks.scrollIntoNearestScrollContainer.mockClear();
      rerender(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          selectedPath="/mock/test/workspace/plasmid.gb"
        />
      );

      await screen.findByText('plasmid');
      expect(safeFocusMocks.scrollIntoNearestScrollContainer).not.toHaveBeenCalled();
    });

    it('expands a collapsed root only when an explicit reveal request arrives', async () => {
      fileBrowserMockState.expandedPaths = new Set();
      fileBrowserMockState.createdEntries.set('/mock/test/workspace/notes/selected.txt', {
        isDirectory: false,
      });
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
        expandedPaths: new Set(),
        revealRequestId: 2,
      });

      render(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          selectedPath="/mock/test/workspace/notes/selected.txt"
        />
      );

      await waitFor(() => {
        expect(mockExpandPath).toHaveBeenCalledWith('/mock/test/workspace');
      });
      await waitFor(() => {
        expect(fileBrowserMockState.expandPathChain).toHaveBeenCalledWith([
          '/mock/test/workspace/notes',
        ]);
      });
    });
  });

  describe('file selection with tab type detection', () => {
    beforeEach(() => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
        expandedPaths: new Set(['/mock/test/workspace']),
      });
    });

    it.each(['double-click', 'context-open', 'context-split', 'keyboard-split'])(
      'preserves sequence package identity during %s opening',
      async (gesture) => {
        const packageRoot = '/mock/test/workspace/pBR322';
        const productPath = `${packageRoot}/pBR322.gb`;
        fileBrowserMockState.createdEntries.set(packageRoot, {
          isDirectory: true,
          packageKind: 'sequence',
        });
        const resolve = vi
          .spyOn(sequencePackageProduct, 'resolveSequencePackageProductPath')
          .mockResolvedValue(productPath);
        const onFileSelect = vi.fn();
        const onOpenInNewPanel = vi.fn();
        try {
          render(
            <FileBrowser
              onFileSelect={onFileSelect}
              onOpenInNewPanel={onOpenInNewPanel}
              onAddFolder={vi.fn()}
            />
          );
          const label = await screen.findByText('Sequence');
          const row = label.closest('[data-testid="file-tree-item"]') as HTMLElement;
          if (gesture === 'double-click') fireEvent.doubleClick(row);
          else if (gesture === 'keyboard-split') {
            fireEvent.click(row);
            fireEvent.keyDown(row, { key: 'Enter', ctrlKey: true });
          } else {
            fireEvent.contextMenu(label);
            fireEvent.click(
              screen.getByRole('menuitem', {
                name: gesture === 'context-open' ? 'Open' : 'Open in New Panel',
                exact: true,
              })
            );
          }
          const presenter = gesture.endsWith('split') ? onOpenInNewPanel : onFileSelect;
          await waitFor(() => expect(presenter).toHaveBeenCalledWith(productPath, 'sequence'));
          expect(resolve).toHaveBeenCalledWith(packageRoot);
          expect(presenter).not.toHaveBeenCalledWith(packageRoot, expect.anything());
        } finally {
          resolve.mockRestore();
        }
      }
    );

    it('single-clicking a file selects it without opening a tab', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(
        () => {
          expect(screen.getByText('plasmid')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.click(screen.getByText('plasmid'));

      expect(mockSetSelectedPath).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb');
      expect(onFileSelect).not.toHaveBeenCalled();
    });

    it('keeps focus on the clicked row when the same file is visible in nested workspace roots', async () => {
      const nestedRoot = '/mock/test/workspace/notes';
      const duplicatePath = `${nestedRoot}/target.gb`;
      fileBrowserMockState.createdEntries.set(`${nestedRoot}/alpha.txt`, {
        isDirectory: false,
      });
      fileBrowserMockState.createdEntries.set(duplicatePath, {
        isDirectory: false,
      });
      setMockWorkspaceState({
        folders: [
          { path: '/mock/test/workspace', name: 'Parent Workspace', addedAt: 1 },
          { path: nestedRoot, name: 'Nested Workspace', addedAt: 2 },
        ],
        expandedPaths: new Set(['/mock/test/workspace', nestedRoot]),
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      const duplicateRows = await waitFor(() => {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(`[data-entry-path="${duplicatePath}"]`)
        );
        expect(rows).toHaveLength(2);
        return rows;
      });
      const parentOccurrence = duplicateRows[0];
      const nestedOccurrence = duplicateRows[1];

      fireEvent.click(parentOccurrence);

      expect(parentOccurrence).toHaveFocus();
      expect(nestedOccurrence).not.toHaveFocus();
    });

    it('qualifies a user-driven folder activation without sending its path or name', async () => {
      const { rerender } = render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await screen.findByText('notes');
      fireEvent.click(screen.getByText('notes'));

      expect(telemetryMocks.observeWorkflowAction).toHaveBeenCalledWith({
        workflow: 'navigation',
        action: 'navigate',
        status: 'completed',
      });

      telemetryMocks.observeWorkflowAction.mockClear();
      rerender(
        <FileBrowser
          onFileSelect={vi.fn()}
          onAddFolder={vi.fn()}
          selectedPath="/mock/test/workspace/notes"
        />
      );
      expect(telemetryMocks.observeWorkflowAction).not.toHaveBeenCalled();
    });

    it('uses arrow keys for tree selection instead of browser scrolling', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('sample')).toBeInTheDocument();
      });

      const firstFileRow = screen
        .getByText('chrIV')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;
      const plasmidRow = screen
        .getByText('plasmid')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;

      fireEvent.click(firstFileRow);
      expect(firstFileRow).toHaveAttribute('aria-selected', 'true');

      expect(fireEvent.keyDown(firstFileRow, { key: 'ArrowDown' })).toBe(false);

      await waitFor(() => {
        expect(plasmidRow).toHaveAttribute('aria-selected', 'true');
      });
      expect(plasmidRow).toHaveFocus();
      expect(onFileSelect).not.toHaveBeenCalled();
    });

    it('extends contiguous tree selection with Shift+Arrow', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('sample')).toBeInTheDocument();
      });

      const firstFileRow = screen
        .getByText('chrIV')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;
      const plasmidRow = screen
        .getByText('plasmid')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;

      fireEvent.click(firstFileRow);
      expect(fireEvent.keyDown(firstFileRow, { key: 'ArrowDown', shiftKey: true })).toBe(false);

      await waitFor(() => {
        expect(firstFileRow).toHaveAttribute('aria-selected', 'true');
        expect(plasmidRow).toHaveAttribute('aria-selected', 'true');
      });
    });

    it('supports filesystem-style folder expansion and collapse from arrow keys', async () => {
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('notes')).toBeInTheDocument();
      });

      const notesRow = screen
        .getByText('notes')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;

      fireEvent.keyDown(notesRow, { key: 'ArrowLeft' });
      expect(fileBrowserMockState.collapseDirectory).toHaveBeenCalledWith(
        '/mock/test/workspace/notes'
      );

      fireEvent.keyDown(notesRow, { key: 'ArrowRight' });
      expect(fileBrowserMockState.expandDirectory).toHaveBeenCalledWith(
        '/mock/test/workspace/notes'
      );
    });

    it('opens the focused file with Enter, not with arrow navigation', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('sample')).toBeInTheDocument();
      });

      const sampleRow = screen
        .getByText('sample')
        .closest('[data-testid="file-tree-item"]') as HTMLElement;

      fireEvent.keyDown(sampleRow, { key: 'ArrowDown' });
      expect(onFileSelect).not.toHaveBeenCalled();

      fireEvent.keyDown(sampleRow, { key: 'Enter' });
      expect(onFileSelect).toHaveBeenCalledWith('/mock/test/workspace/sample.fasta', 'sequence');
    });

    it('double-clicking a sequence file opens it with the detected tab type', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(
        () => {
          expect(screen.getByText('plasmid')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.doubleClick(screen.getByText('plasmid'));

      expect(onFileSelect).toHaveBeenCalledWith('/mock/test/workspace/plasmid.gb', 'sequence');
    });

    it.each([
      ['protocol', 'protocol.json'],
      ['protocol-run', 'protocol-run.json'],
    ] as const)(
      'double-clicking a native %s package opens its authoritative metadata',
      async (packageKind, metaName) => {
        fileBrowserMockState.createdEntries.set('/mock/test/workspace/PCR', {
          isDirectory: true,
          packageKind,
        });
        const onFileSelect = vi.fn();
        render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

        await screen.findByText('PCR');
        fireEvent.doubleClick(screen.getByText('PCR'));

        expect(onFileSelect).toHaveBeenCalledWith(
          `/mock/test/workspace/PCR/.forge/${metaName}`,
          'scientific-document'
        );
      }
    );

    it('double-clicking a GBFF file opens it as a sequence', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(
        () => {
          expect(screen.getByText('chrIV')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.doubleClick(screen.getByText('chrIV'));

      expect(onFileSelect).toHaveBeenCalledWith('/mock/test/workspace/chrIV.gbff', 'sequence');
    });

    it('double-clicking a FASTA file opens it as a sequence', async () => {
      const onFileSelect = vi.fn();
      render(<FileBrowser onFileSelect={onFileSelect} onAddFolder={vi.fn()} />);

      await waitFor(
        () => {
          expect(screen.getByText('sample')).toBeInTheDocument();
        },
        { timeout: 2000 }
      );

      fireEvent.doubleClick(screen.getByText('sample'));

      expect(onFileSelect).toHaveBeenCalledWith('/mock/test/workspace/sample.fasta', 'sequence');
    });
  });

  describe('virtual catalog rows', () => {
    const strain = {
      kind: 'catalog' as const,
      entryId: 'catalog:strain-1',
      workspaceId: 1,
      entityId: 'strain-1',
      sourceRecordId: 'bfi_STRAINAA',
      name: 'Strain A',
      parentRelativePath: '',
      presentationKind: 'strain' as const,
    };

    beforeEach(() => {
      setMockWorkspaceState({
        folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
        expandedPaths: new Set(['/mock/test/workspace']),
      });
      fileBrowserMockState.catalogEntriesByParent.set('/mock/test/workspace', [strain]);
    });

    it('opens by catalog identity and never supplies a synthetic filesystem path', async () => {
      const opened = vi.fn();
      window.addEventListener('waypoint:open-entity', opened);
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);
        const row = (await screen.findByText('Strain A')).closest(
          '[data-testid="file-tree-item"]'
        ) as HTMLElement;

        expect(row).toHaveAttribute('data-entry-id', 'catalog:strain-1');
        expect(row).toHaveAttribute('data-entry-kind', 'catalog');
        expect(row).not.toHaveAttribute('data-entry-path');
        expect(row).not.toHaveAttribute('data-file-drop-target');

        fireEvent.doubleClick(row);
        expect(opened).toHaveBeenCalledOnce();
        expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          entityType: 'native-catalog',
          entityId: 'strain-1',
          label: 'Strain A',
          owningRoot: '/mock/test/workspace',
        });
        expect(platformMocks.stat).not.toHaveBeenCalled();
        expect(platformMocks.relocateEntityFile).not.toHaveBeenCalled();
        expect(platformMocks.fileTrash).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('waypoint:open-entity', opened);
      }
    });

    it('offers only Registry and bounded original-source actions', async () => {
      const sourceRequested = vi.fn();
      window.addEventListener('waypoint:view-original-provider-source', sourceRequested);
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);
        const row = (await screen.findByText('Strain A')).closest(
          '[data-testid="file-tree-item"]'
        ) as HTMLElement;

        fireEvent.contextMenu(row, { clientX: 24, clientY: 48 });
        const menu = screen.getByTestId('catalog-entry-context-menu');
        expect(within(menu).getByRole('menuitem', { name: 'Open in Registry' })).toBeVisible();
        const source = within(menu).getByRole('menuitem', { name: 'View original source' });
        expect(within(menu).queryByText(/rename|move|delete|reveal/i)).toBeNull();

        fireEvent.click(source);
        await screen.findByTestId('original-provider-source-text');
        expect(sourceRequested).toHaveBeenCalledOnce();
        expect((sourceRequested.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
          workspaceId: 1,
          entityId: 'strain-1',
          sourceRecordId: 'bfi_STRAINAA',
          label: 'Strain A',
        });
        expect(platformMocks.revealItemInDir).not.toHaveBeenCalled();
        expect(platformMocks.relocateEntityFile).not.toHaveBeenCalled();
        expect(platformMocks.fileTrash).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('waypoint:view-original-provider-source', sourceRequested);
      }
    });

    it('includes catalog IDs in keyboard navigation and range selection', async () => {
      const opened = vi.fn();
      window.addEventListener('waypoint:open-entity', opened);
      try {
        render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);
        const sampleRow = (await screen.findByText('sample')).closest(
          '[data-testid="file-tree-item"]'
        ) as HTMLElement;
        const strainRow = screen
          .getByText('Strain A')
          .closest('[data-testid="file-tree-item"]') as HTMLElement;

        fireEvent.click(sampleRow);
        fireEvent.keyDown(sampleRow, { key: 'ArrowDown', shiftKey: true });
        expect(sampleRow).toHaveAttribute('aria-selected', 'true');
        expect(strainRow).toHaveAttribute('aria-selected', 'true');

        fireEvent.keyDown(strainRow, { key: 'Enter' });
        expect(opened).toHaveBeenCalledOnce();
      } finally {
        window.removeEventListener('waypoint:open-entity', opened);
      }
    });

    it('keeps filesystem rows visible when the catalog listing is partial', async () => {
      fileBrowserMockState.partialError = {
        source: 'catalog',
        code: 'catalog_listing_failed',
        message: 'catalog unavailable',
      };
      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      expect(await screen.findByTestId('catalog-listing-partial-error')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Retry registry items' })).toBeEnabled();
      expect(screen.getByText('sample')).toBeVisible();
    });
  });

  it('keeps an index refusal scoped to its root and exposes the existing owner retry', async () => {
    setMockWorkspaceState({
      folders: [{ path: '/mock/test/workspace', name: 'Test Workspace', addedAt: Date.now() }],
      expandedPaths: new Set(['/mock/test/workspace']),
    });
    const retry = vi.fn();
    render(
      <FileBrowser
        onFileSelect={vi.fn()}
        onAddFolder={vi.fn()}
        failedProjectIndexRoots={new Set(['/mock/test/workspace'])}
        onRetryProjectIndex={retry}
      />
    );
    expect(await screen.findByTestId('project-index-error')).toHaveTextContent(
      'Project records could not be loaded.'
    );
    expect(screen.getByText('sample')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry project records', exact: true }));
    expect(retry).toHaveBeenCalledExactlyOnceWith('/mock/test/workspace');
  });

  describe('legacy persistence indicator', () => {
    it('does not show the legacy workspace file name in the project header', () => {
      setMockWorkspaceState({
        activeWorkspaceFile: '/path/to/my-project.waypoint-workspace',
        folders: [{ path: '/path/to/project', name: 'Project', addedAt: Date.now() }],
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      expect(screen.queryByText('my-project.waypoint-workspace')).not.toBeInTheDocument();
      expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('shows "Unsaved" when no workspace file', () => {
      setMockWorkspaceState({
        activeWorkspaceFile: null,
        folders: [{ path: '/path/to/project', name: 'Project', addedAt: Date.now() }],
      });

      render(<FileBrowser onFileSelect={vi.fn()} onAddFolder={vi.fn()} />);

      expect(screen.queryByText('.waypoint-workspace')).not.toBeInTheDocument();
    });
  });
});
