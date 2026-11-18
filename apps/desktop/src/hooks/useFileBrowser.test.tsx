import { userMessage } from '@waypoint/user-messages';
/**
 * @vitest-environment jsdom
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverWorkspaceDisplay } from '../services/workspace-display-participants';
import { useFileBrowser } from './useFileBrowser';
import type { FileEntry } from './useFileBrowser';
import { readExpandedPaths, writeExpandedPaths } from '../shared/ui-persistence';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';

const platformMocks = vi.hoisted(() => ({
  readDir: vi.fn(),
  readTextFile: vi.fn(),

  exists: vi.fn(async () => false),
  listChildren: vi.fn(),
}));

vi.mock('../platform', () => ({
  platform: vi.fn(() => ({
    fs: {
      readDir: platformMocks.readDir,
      readTextFile: platformMocks.readTextFile,
      exists: platformMocks.exists,
    },
    workspace: {
      listChildren: platformMocks.listChildren,
    },
  })),
}));

function findEntry(entries: FileEntry[], path: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.children) {
      const child = findEntry(entry.children, path);
      if (child) return child;
    }
  }
  return null;
}

function installListChildrenMock(): void {
  platformMocks.listChildren.mockImplementation(
    async (request: { workspaceRoot: string; parentRelativePath: string }) => {
      const path = request.parentRelativePath
        ? `${request.workspaceRoot}/${request.parentRelativePath}`
        : request.workspaceRoot;
      const entries = await platformMocks.readDir(path);
      return {
        workspaceId: 1,
        parentRelativePath: request.parentRelativePath,
        entries: entries.map((entry: { name: string; isDirectory: boolean; isFile: boolean }) => ({
          kind: 'filesystem' as const,
          entryId: `filesystem:${path}/${entry.name}`,
          path: `${path}/${entry.name}`,
          ...entry,
        })),
        partialError: null,
      };
    }
  );
}

describe('useFileBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMocks.readTextFile.mockReset();

    localStorage.clear();
    installListChildrenMock();
  });

  it('retains children revealed while an earlier root refresh is in flight', async () => {
    const directories: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/lab': [
        { name: 'Selected Root', isDirectory: true, isFile: false },
        { name: 'Appended Root', isDirectory: true, isFile: false },
      ],
      '/lab/Selected Root': [],
      '/lab/Appended Root': [{ name: 'Omega', isDirectory: true, isFile: false }],
      '/lab/Appended Root/Omega': [{ name: 'Deep', isDirectory: true, isFile: false }],
    };
    let hold = false;
    let release!: () => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (hold && path === '/lab/Selected Root') {
        hold = false;
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return directories[path] ?? [];
    });
    const listChildren = platformMocks.listChildren.getMockImplementation()!;
    const catalogEntry = {
      kind: 'catalog' as const,
      entryId: 'catalog:imported-strain',
      workspaceId: 1,
      entityId: 'imported-strain',
      sourceRecordId: null,
      name: 'Imported strain',
      parentRelativePath: 'Appended Root/Omega',
      presentationKind: 'strain' as const,
    };
    platformMocks.listChildren.mockImplementation(async (request) => {
      const listing = await listChildren(request);
      return request.parentRelativePath === 'Appended Root/Omega'
        ? { ...listing, entries: [...listing.entries, catalogEntry] }
        : listing;
    });
    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    await act(async () => {
      await result.current.expandDirectory('/lab/Selected Root');
    });
    hold = true;
    let refresh!: Promise<unknown>;
    act(() => {
      refresh = result.current.refresh();
    });
    await reading;
    await act(async () => {
      await result.current.expandPathChain(['/lab/Appended Root', '/lab/Appended Root/Omega']);
    });
    expect(findEntry(result.current.entries, '/lab/Appended Root/Omega')?.children?.[0].name).toBe(
      'Deep'
    );
    await act(async () => {
      release();
      await refresh;
    });
    expect(result.current.expandedPaths.has('/lab/Appended Root')).toBe(true);
    expect(result.current.catalogEntriesByParent.get('/lab/Appended Root/Omega')).toEqual([
      catalogEntry,
    ]);
    expect(findEntry(result.current.entries, '/lab/Appended Root/Omega')?.children?.[0].name).toBe(
      'Deep'
    );
  });

  it('refreshes an expanded folder without collapsing or dropping its children', async () => {
    const directoryEntries: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/lab': [
        { name: 'experiments', isDirectory: true, isFile: false },
        { name: 'root.txt', isDirectory: false, isFile: true },
      ],
      '/lab/experiments': [{ name: 'draft.txt', isDirectory: false, isFile: true }],
    };
    platformMocks.readDir.mockImplementation(async (path: string) => directoryEntries[path] ?? []);

    const { result } = renderHook(() => useFileBrowser('/lab'));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual([
        'experiments',
        'root.txt',
      ]);
    });

    await act(async () => {
      await result.current.expandDirectory('/lab/experiments');
    });

    await waitFor(() => {
      const experiments = result.current.entries.find((entry) => entry.name === 'experiments');
      expect(experiments?.children?.map((entry) => entry.name)).toEqual(['draft.txt']);
      expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);
    });

    directoryEntries['/lab/experiments'] = [
      { name: 'committed-name.txt', isDirectory: false, isFile: true },
    ];

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      const experiments = result.current.entries.find((entry) => entry.name === 'experiments');
      expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);
      expect(experiments?.children?.map((entry) => entry.name)).toEqual(['committed-name.txt']);
    });
  });

  it('hides .waypoint.json sidecars and dotfiles from the tree', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) =>
      path === '/lab'
        ? [
            { name: 'reference.gb', isDirectory: false, isFile: true },
            { name: 'reference.gb.waypoint.json', isDirectory: false, isFile: true },
            { name: '.welcome-seen', isDirectory: false, isFile: true },
            { name: 'notes.txt', isDirectory: false, isFile: true },
          ]
        : []
    );

    const { result } = renderHook(() => useFileBrowser('/lab'));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['notes.txt', 'reference']);
    });
  });

  it('retains virtual catalog rows by stable entry ID without inventing a filesystem path', async () => {
    platformMocks.listChildren.mockResolvedValue({
      workspaceId: 1,
      parentRelativePath: '',
      entries: [
        {
          kind: 'catalog',
          entryId: 'catalog:strain-1',
          workspaceId: 1,
          entityId: 'strain-1',
          sourceRecordId: 'bfi_STRAINAA',
          name: 'Strain A',
          parentRelativePath: '',
          presentationKind: 'strain',
        },
      ],
      partialError: null,
    });

    const { result } = renderHook(() => useFileBrowser('/lab'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.entries).toEqual([]);
      expect(result.current.catalogEntriesByParent.get('/lab')).toEqual([
        expect.objectContaining({ entryId: 'catalog:strain-1', entityId: 'strain-1' }),
      ]);
    });
  });

  it('expands a deep directory chain after loading each parent into the tree', async () => {
    const directoryEntries: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/lab': [
        { name: 'level-1', isDirectory: true, isFile: false },
        { name: 'root.txt', isDirectory: false, isFile: true },
      ],
      '/lab/level-1': [{ name: 'level-2', isDirectory: true, isFile: false }],
      '/lab/level-1/level-2': [{ name: 'level-3', isDirectory: true, isFile: false }],
      '/lab/level-1/level-2/level-3': [{ name: 'target.txt', isDirectory: false, isFile: true }],
    };
    platformMocks.readDir.mockImplementation(async (path: string) => directoryEntries[path] ?? []);

    const { result } = renderHook(() => useFileBrowser('/lab'));

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.name)).toEqual(['level-1', 'root.txt']);
    });

    await act(async () => {
      await result.current.expandPathChain([
        '/lab/level-1',
        '/lab/level-1/level-2',
        '/lab/level-1/level-2/level-3',
      ]);
    });

    await waitFor(() => {
      expect(findEntry(result.current.entries, '/lab/level-1')?.children?.[0]?.name).toBe(
        'level-2'
      );
      expect(
        findEntry(result.current.entries, '/lab/level-1/level-2/level-3')?.children?.[0]?.name
      ).toBe('target.txt');
      expect(result.current.expandedPaths.has('/lab/level-1')).toBe(true);
      expect(result.current.expandedPaths.has('/lab/level-1/level-2')).toBe(true);
      expect(result.current.expandedPaths.has('/lab/level-1/level-2/level-3')).toBe(true);
    });

    expect(
      platformMocks.readDir.mock.calls
        .map(([path]) => String(path))
        .filter((path) => !path.endsWith('/.forge'))
    ).toEqual(['/lab', '/lab/level-1', '/lab/level-1/level-2', '/lab/level-1/level-2/level-3']);
  });
});

describe('useFileBrowser reveals newly imported descendants', () => {
  it.each(['empty', 'populated'])(
    'refreshes a cached %s ancestor when the next folder is new',
    async (initial) => {
      vi.clearAllMocks();
      platformMocks.readTextFile.mockReset();
      localStorage.clear();
      installListChildrenMock();
      const parent = '/lab/Appended Root';
      const child = `${parent}/Omega`;
      const tree: Record<string, Array<{ name: string; isDirectory: boolean; isFile: boolean }>> = {
        '/lab': [{ name: 'Appended Root', isDirectory: true, isFile: false }],
        [parent]:
          initial === 'empty' ? [] : [{ name: 'existing', isDirectory: true, isFile: false }],
        [`${parent}/existing`]: [{ name: 'retained.txt', isDirectory: false, isFile: true }],
        [child]: [{ name: 'target.txt', isDirectory: false, isFile: true }],
      };
      platformMocks.readDir.mockImplementation(async (path: string) => tree[path] ?? []);
      const { result } = renderHook(() => useFileBrowser('/lab'));
      await waitFor(() => expect(result.current.entries).toHaveLength(1));
      await act(async () => {
        await result.current.expandDirectory(parent);
      });
      expect(findEntry(result.current.entries, parent)?.children).toHaveLength(
        initial === 'empty' ? 0 : 1
      );
      if (initial === 'populated') {
        await act(async () => {
          await result.current.expandDirectory(`${parent}/existing`);
        });
      }
      tree[parent].push({ name: 'Omega', isDirectory: true, isFile: false });

      await act(async () => {
        await result.current.expandPathChain([parent, child]);
      });

      expect(findEntry(result.current.entries, child)?.children?.[0]?.name).toBe('target.txt');
      expect(result.current.expandedPaths.has(parent)).toBe(true);
      expect(result.current.expandedPaths.has(child)).toBe(true);
      if (initial === 'populated') {
        expect(findEntry(result.current.entries, `${parent}/existing`)?.children?.[0]?.name).toBe(
          'retained.txt'
        );
        expect(result.current.expandedPaths.has(`${parent}/existing`)).toBe(true);
      }
    }
  );
});

describe('useFileBrowser — package rows ', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMocks.readTextFile.mockReset();
    localStorage.clear();
    installListChildrenMock();
  });

  function mockTree(tree: Record<string, Array<{ name: string; isDirectory: boolean }>>) {
    platformMocks.exists.mockImplementation(async (path: string) => tree[path] !== undefined);
    platformMocks.readDir.mockImplementation(async (path: string) => {
      const entries = tree[path];
      if (!entries) throw new Error(`ENOENT: ${path}`);
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        isFile: !entry.isDirectory,
      }));
    });
  }

  it('projects the package identity and name without exposing its physical filename as a label', async () => {
    mockTree({
      '/ws': [{ name: 'physical-import__seq_123', isDirectory: true }],
      '/ws/physical-import__seq_123/.forge': [{ name: 'plasmid.json', isDirectory: false }],
    });
    platformMocks.readTextFile.mockResolvedValue(
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'package-test',
          name: 'pBR322 Follow-up',
          product: { file: 'unrelated-raw-product.gb', topology: 'circular' },
        })
      )
    );
    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    const entry = result.current.entries[0];
    expect(entry.name).toBe('pBR322 Follow-up');
    expect(entry.sequenceDocument).toEqual({
      kind: 'managed-sequence',
      packageId: 'package-test',
      packageRoot: '/ws/physical-import__seq_123',
    });
    expect(entry).not.toHaveProperty('sourceFileName');
    expect(entry).not.toHaveProperty('productPath');
    expect(entry).not.toHaveProperty('productFile');
  });

  it('renders a plasmid package as a file-like leaf, not an expandable folder', async () => {
    mockTree({
      '/ws': [{ name: 'pMyConstruct', isDirectory: true }],
      '/ws/pMyConstruct/.forge': [{ name: 'plasmid.json', isDirectory: false }],
    });
    platformMocks.readTextFile.mockResolvedValue(
      serializeSequencePackageDocument(
        buildSequencePackageDocument({
          id: 'my-construct',
          name: 'pMyConstruct',
          product: { file: 'product.gb', topology: 'circular' },
        })
      )
    );

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(1));

    const pkg = findEntry(result.current.entries, '/ws/pMyConstruct')!;
    expect(pkg.packageKind).toBe('sequence');
    expect(pkg.name).toBe('pMyConstruct');
    expect(pkg.isDirectory).toBe(false);

    expect(pkg.extension).toBeNull();
  });

  it('uses a neutral label rather than a physical directory when sequence metadata is unreadable', async () => {
    mockTree({
      '/ws': [{ name: 'raw-import__seq_123', isDirectory: true }],
      '/ws/raw-import__seq_123/.forge': [{ name: 'plasmid.json', isDirectory: false }],
    });
    platformMocks.readTextFile.mockRejectedValue(new Error('Unreadable metadata'));
    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.entries[0]).toMatchObject({ name: 'Sequence', packageKind: 'sequence' });
    expect(result.current.entries[0].sequenceDocument).toBeUndefined();
  });

  it('still renders a notebook package as a leaf', async () => {
    mockTree({
      '/ws': [{ name: 'Lab notes', isDirectory: true }],
      '/ws/Lab notes/.forge': [{ name: 'notebook.json', isDirectory: false }],
    });

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(1));

    const pkg = findEntry(result.current.entries, '/ws/Lab notes')!;
    expect(pkg.packageKind).toBe('notebook');
    expect(pkg.isNotebookPackage).toBe(true);
    expect(pkg.isDirectory).toBe(false);
  });

  it.each([
    ['protocol.json', 'protocol'],
    ['protocol-run.json', 'protocol-run'],
  ] as const)('renders a native %s package as a file-like leaf', async (metaName, packageKind) => {
    mockTree({
      '/ws': [{ name: 'PCR', isDirectory: true }],
      '/ws/PCR/.forge': [{ name: metaName, isDirectory: false }],
    });

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(1));

    const pkg = findEntry(result.current.entries, '/ws/PCR')!;
    expect(pkg.packageKind).toBe(packageKind);
    expect(pkg.isDirectory).toBe(false);
    expect(pkg.extension).toBeNull();
  });

  it('leaves an ordinary directory expandable', async () => {
    mockTree({ '/ws': [{ name: 'Sequences', isDirectory: true }] });

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(1));

    const dir = findEntry(result.current.entries, '/ws/Sequences')!;
    expect(dir.packageKind).toBeUndefined();
    expect(dir.isDirectory).toBe(true);
  });

  it('uses one quiet probe per directory and reads only present marker directories', async () => {
    mockTree({
      '/ws': [
        { name: 'a', isDirectory: true },
        { name: 'b', isDirectory: true },
        { name: 'seq.gb', isDirectory: false },
      ],
      '/ws/a/.forge': [{ name: 'plasmid.json', isDirectory: false }],
    });

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(3));

    const existenceProbes = platformMocks.exists.mock.calls.filter(([path]: [string]) =>
      String(path).endsWith('/.forge')
    );
    expect(existenceProbes).toHaveLength(2);
    const markerReads = platformMocks.readDir.mock.calls.filter(([path]: [string]) =>
      String(path).endsWith('/.forge')
    );
    expect(markerReads).toHaveLength(1);
  });

  it('treats a .forge dir with no known marker as a plain directory', async () => {
    mockTree({
      '/ws': [{ name: 'odd', isDirectory: true }],
      '/ws/odd/.forge': [{ name: 'something-else.json', isDirectory: false }],
    });

    const { result } = renderHook(() => useFileBrowser('/ws'));
    await waitFor(() => expect(result.current.entries.length).toBe(1));

    const entry = findEntry(result.current.entries, '/ws/odd')!;
    expect(entry.packageKind).toBeUndefined();
    expect(entry.isDirectory).toBe(true);
  });

  it('collapsing a parent also forgets its expanded descendants', async () => {
    const directoryEntries: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/lab': [{ name: 'a', isDirectory: true, isFile: false }],
      '/lab/a': [{ name: 'b', isDirectory: true, isFile: false }],
      '/lab/a/b': [{ name: 'leaf.txt', isDirectory: false, isFile: true }],
    };
    platformMocks.readDir.mockImplementation(async (path: string) => directoryEntries[path] ?? []);

    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    await act(async () => {
      await result.current.expandDirectory('/lab/a');
    });
    await act(async () => {
      await result.current.expandDirectory('/lab/a/b');
    });
    expect(result.current.expandedPaths.has('/lab/a/b')).toBe(true);

    act(() => {
      result.current.collapseDirectory('/lab/a');
    });

    expect(result.current.expandedPaths.has('/lab/a')).toBe(false);
    expect(result.current.expandedPaths.has('/lab/a/b')).toBe(false);
  });

  it('drops a directory that can no longer be read, and never retries it', async () => {
    const directoryEntries: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/lab': [
        { name: 'gone', isDirectory: true, isFile: false },
        { name: 'keep', isDirectory: true, isFile: false },
      ],
      '/lab/gone': [{ name: 'old.txt', isDirectory: false, isFile: true }],
      '/lab/keep': [{ name: 'kept.txt', isDirectory: false, isFile: true }],
    };
    let goneIsMissing = false;
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/lab/gone' && goneIsMissing) throw new Error('ENOENT');
      return directoryEntries[path] ?? [];
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    await act(async () => {
      await result.current.expandDirectory('/lab/gone');
    });
    await act(async () => {
      await result.current.expandDirectory('/lab/keep');
    });

    goneIsMissing = true;
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(findEntry(result.current.entries, '/lab/keep')?.children?.[0]?.name).toBe('kept.txt');

    expect(result.current.expandedPaths.has('/lab/gone')).toBe(false);
    expect(result.current.expandedPaths.has('/lab/keep')).toBe(true);

    platformMocks.readDir.mockClear();
    await act(async () => {
      await result.current.refresh();
    });
    expect(platformMocks.readDir.mock.calls.map(([path]) => path)).not.toContain('/lab/gone');

    consoleError.mockRestore();
  });

  it('does not mark a directory expanded when reading it failed', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/lab') return [{ name: 'missing', isDirectory: true, isFile: false }];
      throw new Error('ENOENT');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    await act(async () => {
      await result.current.expandPathChain(['/lab/missing']);
    });

    expect(result.current.expandedPaths.has('/lab/missing')).toBe(false);
    consoleError.mockRestore();
  });

  it('a slower earlier load cannot overwrite a newer one', async () => {
    let call = 0;
    const gate: Array<() => void> = [];
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path !== '/lab') return [];
      call += 1;
      if (call === 2) {
        await new Promise<void>((resolve) => gate.push(resolve));
        return [{ name: 'stale.txt', isDirectory: false, isFile: true }];
      }
      if (call === 3) return [{ name: 'fresh.txt', isDirectory: false, isFile: true }];
      return [{ name: 'initial.txt', isDirectory: false, isFile: true }];
    });

    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries[0]?.name).toBe('initial.txt'));

    let slow!: Promise<void>;
    act(() => {
      slow = result.current.refresh();
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entries[0]?.name).toBe('fresh.txt');

    await act(async () => {
      gate.forEach((release) => release());
      await slow;
    });

    expect(result.current.entries[0]?.name).toBe('fresh.txt');
  });

  const nestedTree: Record<
    string,
    Array<{ name: string; isDirectory: boolean; isFile: boolean }>
  > = {
    '/lab': [{ name: 'experiments', isDirectory: true, isFile: false }],
    '/lab/experiments': [
      { name: 'runs', isDirectory: true, isFile: false },
      { name: 'notes.txt', isDirectory: false, isFile: true },
    ],
    '/lab/experiments/runs': [{ name: 'r1.txt', isDirectory: false, isFile: true }],
  };

  it('restores expanded folders AND their children on a fresh mount', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => nestedTree[path] ?? []);
    writeExpandedPaths('/lab', ['/lab/experiments', '/lab/experiments/runs']);

    const { result } = renderHook(() => useFileBrowser('/lab', true));

    await waitFor(() => {
      expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);
      expect(result.current.expandedPaths.has('/lab/experiments/runs')).toBe(true);
      expect(findEntry(result.current.entries, '/lab/experiments/runs')?.children?.[0]?.name).toBe(
        'r1.txt'
      );
    });
  });

  it('restores shallowest-first so a parent exists before its child', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => nestedTree[path] ?? []);
    writeExpandedPaths('/lab', ['/lab/experiments/runs', '/lab/experiments']);

    const { result } = renderHook(() => useFileBrowser('/lab', true));
    await waitFor(() => {
      expect(result.current.expandedPaths.size).toBe(2);
    });

    expect(
      platformMocks.readDir.mock.calls
        .map(([path]) => String(path))
        .filter((path) => !path.endsWith('/.forge'))
    ).toEqual(['/lab', '/lab/experiments', '/lab/experiments/runs']);
  });

  it('persists an expand and a collapse', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => nestedTree[path] ?? []);
    const { result } = renderHook(() => useFileBrowser('/lab', true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    await act(async () => {
      await result.current.expandDirectory('/lab/experiments');
    });
    await waitFor(() => expect(readExpandedPaths('/lab')).toEqual(['/lab/experiments']));

    act(() => {
      result.current.collapseDirectory('/lab/experiments');
    });
    await waitFor(() => expect(readExpandedPaths('/lab')).toEqual([]));
  });

  it('does NOT read or write storage when persistence is off (the modal picker)', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => nestedTree[path] ?? []);

    writeExpandedPaths('/lab', ['/lab/some-other-dir']);

    const { result } = renderHook(() => useFileBrowser('/lab'));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    expect(result.current.expandedPaths.size).toBe(0);

    await act(async () => {
      await result.current.expandDirectory('/lab/experiments');
    });
    expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);

    expect(readExpandedPaths('/lab')).toEqual(['/lab/some-other-dir']);
  });

  it('keeps a transient read failure — only a MISSING directory is dropped', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/lab/experiments') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return nestedTree[path] ?? [];
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeExpandedPaths('/lab', ['/lab/experiments']);

    const { result } = renderHook(() => useFileBrowser('/lab', true));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);
    expect(readExpandedPaths('/lab')).toEqual(['/lab/experiments']);
    consoleError.mockRestore();
  });

  it('keeps two roots independent', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/wsA') return [{ name: 'a-dir', isDirectory: true, isFile: false }];
      if (path === '/wsB') return [{ name: 'b-dir', isDirectory: true, isFile: false }];
      return [];
    });
    writeExpandedPaths('/wsA', ['/wsA/a-dir']);
    writeExpandedPaths('/wsB', ['/wsB/b-dir']);

    const a = renderHook(() => useFileBrowser('/wsA', true));
    const b = renderHook(() => useFileBrowser('/wsB', true));

    await waitFor(() => {
      expect(a.result.current.expandedPaths.has('/wsA/a-dir')).toBe(true);
      expect(b.result.current.expandedPaths.has('/wsB/b-dir')).toBe(true);
    });
    expect(a.result.current.expandedPaths.has('/wsB/b-dir')).toBe(false);
    expect(b.result.current.expandedPaths.has('/wsA/a-dir')).toBe(false);
  });

  it('prunes a restored path whose directory no longer exists, silently', async () => {
    platformMocks.readDir.mockImplementation(async (path: string) => {
      if (path === '/lab') return [{ name: 'experiments', isDirectory: true, isFile: false }];
      if (path === '/lab/gone') throw new Error('ENOENT');
      return nestedTree[path] ?? [];
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeExpandedPaths('/lab', ['/lab/experiments', '/lab/gone']);

    const { result } = renderHook(() => useFileBrowser('/lab', true));

    await waitFor(() => {
      expect(result.current.expandedPaths.has('/lab/experiments')).toBe(true);
      expect(result.current.expandedPaths.has('/lab/gone')).toBe(false);

      expect(readExpandedPaths('/lab')).toEqual(['/lab/experiments']);
    });
    expect(result.current.error).toBeNull();
    consoleError.mockRestore();
  });
});

describe('post-reconstruction display delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformMocks.readDir.mockReset();
    platformMocks.readTextFile.mockReset();
    localStorage.clear();
    installListChildrenMock();
  });

  it('shows files created after the mount read and leaves another root untouched', async () => {
    const entries: Record<
      string,
      Array<{ name: string; isDirectory: boolean; isFile: boolean }>
    > = {
      '/received': [],
      '/other': [{ name: 'existing.txt', isDirectory: false, isFile: true }],
    };
    platformMocks.readDir.mockImplementation(async (path: string) => entries[path] ?? []);
    const received = renderHook(() => useFileBrowser('/received', true));
    const other = renderHook(() => useFileBrowser('/other', true));
    await waitFor(() => {
      expect(received.result.current.loading).toBe(false);
      expect(other.result.current.entries).toHaveLength(1);
    });
    const otherReads = platformMocks.readDir.mock.calls.filter(
      ([path]) => path === '/other'
    ).length;
    entries['/received'] = [{ name: 'restored.gb', isDirectory: false, isFile: true }];
    let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>>;
    await act(async () => {
      report = await deliverWorkspaceDisplay({
        workspaceRoot: '/received/',
        operationId: 'native-restore',
        assertCurrent() {},
      });
    });
    expect(report!.errors).toEqual([]);
    expect(received.result.current.entries.map((entry) => entry.path)).toEqual([
      '/received/restored.gb',
    ]);
    expect(other.result.current.entries.map((entry) => entry.path)).toEqual([
      '/other/existing.txt',
    ]);
    expect(platformMocks.readDir.mock.calls.filter(([path]) => path === '/other')).toHaveLength(
      otherReads
    );
  });

  it('publishes a fresh read when an ordinary refresh supersedes the required read', async () => {
    type Entry = { name: string; isDirectory: boolean; isFile: boolean };
    let releaseRequired!: (value: Entry[]) => void;
    let releaseOrdinary!: (value: Entry[]) => void;
    const requiredRead = new Promise<Entry[]>((resolve) => {
      releaseRequired = resolve;
    });
    const ordinaryRead = new Promise<Entry[]>((resolve) => {
      releaseOrdinary = resolve;
    });
    platformMocks.readDir.mockResolvedValue([]);
    const view = renderHook(() => useFileBrowser('/received', true));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    platformMocks.readDir
      .mockImplementationOnce(() => requiredRead)
      .mockImplementationOnce(() => ordinaryRead)
      .mockResolvedValue([{ name: 'latest.gb', isDirectory: false, isFile: true }]);
    let delivery!: ReturnType<typeof deliverWorkspaceDisplay>;
    await act(async () => {
      delivery = deliverWorkspaceDisplay({
        workspaceRoot: '/received',
        operationId: 'incoming',
        assertCurrent() {},
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(platformMocks.readDir).toHaveBeenCalledTimes(2));
    let ordinary!: Promise<void>;
    await act(async () => {
      ordinary = view.result.current.refresh();
      await Promise.resolve();
    });
    let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>>;
    try {
      await act(async () => {
        releaseRequired([{ name: 'old-required.gb', isDirectory: false, isFile: true }]);
        report = await delivery;
      });
    } finally {
      await act(async () => {
        releaseOrdinary([{ name: 'old-ordinary.gb', isDirectory: false, isFile: true }]);
        await ordinary;
      });
    }
    expect(report!.errors).toEqual([]);
    expect(view.result.current.entries.map((entry) => entry.path)).toEqual(['/received/latest.gb']);
  });

  it.each(['root', 'expanded child'])(
    'reports a failed %s directory read to the display owner',
    async (where) => {
      const rootEntries = [{ name: 'restored', isDirectory: true, isFile: false }];
      platformMocks.readDir.mockImplementation(async (path: string) =>
        path === '/received' ? rootEntries : []
      );
      const view = renderHook(() => useFileBrowser('/received', true));
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      if (where === 'expanded child') {
        await act(async () => {
          await view.result.current.expandDirectory('/received/restored');
        });
      }
      const failure = new Error('Restored directory could not be read');
      platformMocks.readDir.mockImplementation(async (path: string) => {
        if (path === (where === 'root' ? '/received' : '/received/restored')) throw failure;
        return path === '/received' ? rootEntries : [];
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>>;
        await act(async () => {
          report = await deliverWorkspaceDisplay({
            workspaceRoot: '/received',
            operationId: 'incoming',
            assertCurrent() {},
          });
        });
        expect(report!.errors).toEqual([failure]);
        expect(view.result.current.error).toBe(userMessage('failure.failed-to-read-directory'));
      } finally {
        consoleError.mockRestore();
      }
    }
  );

  it('does not publish rows or an error from a superseded workspace operation', async () => {
    type Entry = { name: string; isDirectory: boolean; isFile: boolean };
    platformMocks.readDir.mockResolvedValue([
      { name: 'accepted.gb', isDirectory: false, isFile: true },
    ]);
    const view = renderHook(() => useFileBrowser('/received', true));
    await waitFor(() => expect(view.result.current.loading).toBe(false));
    let release!: (value: Entry[]) => void;
    platformMocks.readDir.mockImplementationOnce(
      () =>
        new Promise<Entry[]>((resolve) => {
          release = resolve;
        })
    );
    let current = true;
    const canceled = new Error('Workspace operation superseded');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let delivery!: ReturnType<typeof deliverWorkspaceDisplay>;
      await act(async () => {
        delivery = deliverWorkspaceDisplay({
          workspaceRoot: '/received',
          operationId: 'old-incoming',
          assertCurrent() {
            if (!current) throw canceled;
          },
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(release).toBeTypeOf('function'));
      let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>>;
      await act(async () => {
        current = false;
        release([{ name: 'stale.gb', isDirectory: false, isFile: true }]);
        report = await delivery;
      });
      expect(report!.errors).toEqual([canceled]);
      expect(view.result.current.entries.map((entry) => entry.path)).toEqual([
        '/received/accepted.gb',
      ]);
      expect(view.result.current.error).toBeNull();
      expect(view.result.current.loading).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it.each([false, true])(
    'does not deliver a retired sidebar into the newly selected workspace (read rejects: %s)',
    async (rejectRead) => {
      type Entry = { name: string; isDirectory: boolean; isFile: boolean };
      const entries: Record<string, Entry[]> = {
        '/received': [{ name: 'old.txt', isDirectory: false, isFile: true }],
        '/other': [{ name: 'current.txt', isDirectory: false, isFile: true }],
      };
      platformMocks.readDir.mockImplementation(async (path: string) => entries[path] ?? []);
      const view = renderHook(({ root }) => useFileBrowser(root, true), {
        initialProps: { root: '/received' },
      });
      await waitFor(() => expect(view.result.current.loading).toBe(false));
      let release!: (value: Entry[]) => void;
      let fail!: (error: Error) => void;
      platformMocks.readDir.mockImplementationOnce(
        () =>
          new Promise<Entry[]>((resolve, reject) => {
            release = resolve;
            fail = reject;
          })
      );
      let delivery!: ReturnType<typeof deliverWorkspaceDisplay>;
      await act(async () => {
        delivery = deliverWorkspaceDisplay({
          workspaceRoot: '/received',
          operationId: 'incoming-before-workspace-switch',
          assertCurrent() {},
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(release).toBeTypeOf('function'));
      view.rerender({ root: '/other' });
      await waitFor(() =>
        expect(view.result.current.entries.map((entry) => entry.path)).toEqual([
          '/other/current.txt',
        ])
      );
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let report: Awaited<ReturnType<typeof deliverWorkspaceDisplay>>;
        await act(async () => {
          if (rejectRead) fail(new Error('Previous workspace read failed'));
          else release([{ name: 'restored.txt', isDirectory: false, isFile: true }]);
          report = await delivery;
        });
        expect(report!.errors).toEqual([]);
        expect(consoleError).not.toHaveBeenCalled();
        expect(view.result.current.entries.map((entry) => entry.path)).toEqual([
          '/other/current.txt',
        ]);
        expect(view.result.current.error).toBeNull();
        expect(view.result.current.loading).toBe(false);
      } finally {
        consoleError.mockRestore();
      }
    }
  );
});
