import { toUserMessage } from '@waypoint/user-messages';
import {
  captureProjectLifecycle,
  type ProjectLifecycle,
} from '../features/workspace-loader/workspace-telemetry';
import { useState, useCallback, useEffect, useRef } from 'react';
import { platform } from '../platform';

import { pathIsAtOrUnder, stripTrailingSep } from '../shared/path-boundary';
import { registerWorkspaceDisplayParticipant } from '../services/workspace-display-participants';
import { readExpandedPaths, writeExpandedPaths } from '../shared/ui-persistence';
import { retainExpandedBranch } from '../shared/tree-expansion';

import { isBiologyFile as isBiologySequenceFile } from '../utils/fileTypes';
import { parseSequencePackageDocument } from '../db/sequence-package';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import { sequenceDisplayName } from '../shared/sequence-presentation';
import { detectDocumentPackage, type DocumentPackageKind } from '../shared/document-package';
import { getCatalogEntityForFilePath } from '../db/workspace-catalog';
import {
  benchlingImportDisplayName,
  isManagedBenchlingProvenanceSidecar,
} from '../shared/benchling-import-display-name';
import type {
  WorkspaceBrowserCatalogEntry,
  WorkspaceBrowserFilesystemEntry,
  WorkspaceBrowserPartialError,
  WorkspaceListChildrenResult,
} from '../shared/workspace-browser-types';

const EXCLUDED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store']);
const NOTEBOOK_TITLE_MAX_LENGTH = 4_096;
const DIRECTORY_ENTRY_ENRICHMENT_CONCURRENCY = 8;
const EXPANDED_DIRECTORY_READ_CONCURRENCY = 4;

export interface FileEntry {
  kind: 'filesystem';

  entryId: string;

  name: string;

  displayName?: string;

  path: string;

  isDirectory: boolean;

  packageKind?: DocumentPackageKind;

  sequenceDocument?: ManagedSequenceDocumentRef;

  isNotebookPackage?: boolean;

  isBiologyFile: boolean;

  extension: string | null;

  children?: FileEntry[];

  isLoading?: boolean;

  isPending?: boolean;
}

export interface ProjectTreeReceipt {
  lifecycle: ProjectLifecycle | undefined;
  phase: 'tree_ready' | 'tree_partial' | 'tree_failed';
}

export interface UseFileBrowserReturn {
  projectTreeReceipt?: ProjectTreeReceipt;

  entries: FileEntry[];

  loading: boolean;

  error: string | null;

  catalogEntriesByParent: ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]>;

  partialError: WorkspaceBrowserPartialError | null;

  refresh: () => Promise<void>;

  expandDirectory: (path: string) => Promise<void>;

  expandPathChain: (paths: string[]) => Promise<void>;

  collapseDirectory: (path: string) => void;
  collapseOtherDirectories: (path: string) => void;

  expandedPaths: Set<string>;
}

function getExtension(filename: string): string | null {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) return null;
  return filename.slice(lastDot + 1).toLowerCase();
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function joinChildPath(dirPath: string, name: string): string {
  const sep = dirPath.includes('\\') && !dirPath.includes('/') ? '\\' : '/';

  const base = dirPath.endsWith(sep) ? dirPath.slice(0, -1) : dirPath;
  return `${base}${sep}${name}`;
}

async function readImportedNotebookTitle(packageRoot: string): Promise<string | undefined> {
  try {
    const entity = await getCatalogEntityForFilePath(packageRoot);
    if (entity?.type !== 'notebook') return undefined;
    const title = entity.name.trim();
    return title && title.length <= NOTEBOOK_TITLE_MAX_LENGTH ? title : undefined;
  } catch {
    return undefined;
  }
}

async function mapAtFixedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

type DirectoryEntries = Readonly<{
  files: FileEntry[];
  catalog: WorkspaceBrowserCatalogEntry[];
  partialError: WorkspaceBrowserPartialError | null;
}>;

type BrowserListingMode = 'workspace' | 'filesystem';

async function readDirectoryEntries(
  workspaceRoot: string,
  dirPath: string,
  listingMode: BrowserListingMode
): Promise<DirectoryEntries> {
  const listing: Pick<WorkspaceListChildrenResult, 'entries' | 'partialError'> =
    listingMode === 'workspace'
      ? await platform().workspace.listChildren({
          workspaceRoot,
          parentRelativePath: workspaceParentRelativePath(workspaceRoot, dirPath),
        })
      : {
          entries: (await platform().fs.readDir(dirPath)).map((entry) => ({
            kind: 'filesystem' as const,
            entryId: `filesystem:${joinChildPath(dirPath, entry.name)}`,
            name: entry.name,
            path: joinChildPath(dirPath, entry.name),
            isDirectory: entry.isDirectory,
            isFile: entry.isFile,
          })),
          partialError: null,
        };
  const rawEntries = listing.entries.filter(
    (entry): entry is WorkspaceBrowserFilesystemEntry => entry.kind === 'filesystem'
  );

  const visibleEntries = rawEntries.filter(
    (entry) =>
      !EXCLUDED_DIRS.has(entry.name) &&
      !entry.name.startsWith('.') &&
      !entry.name.toLowerCase().endsWith('.waypoint.json') &&
      !isManagedBenchlingProvenanceSidecar({ parentPath: dirPath, entryName: entry.name })
  );

  const entries = await mapAtFixedConcurrency(
    visibleEntries,
    DIRECTORY_ENTRY_ENRICHMENT_CONCURRENCY,
    async (entry): Promise<FileEntry> => {
      const fullPath = joinChildPath(dirPath, entry.name);
      const isDir = entry.isDirectory;
      const detectedPackage = isDir
        ? await detectDocumentPackage(fullPath, platform().fs).catch(() => undefined)
        : undefined;
      const packageKind = detectedPackage?.kind;
      let sequenceDocument: ManagedSequenceDocumentRef | undefined;
      let packageName: string | undefined;
      if (packageKind === 'sequence') {
        try {
          const metadataPath = detectedPackage?.metadataPath;
          if (!metadataPath) throw new Error('Sequence package metadata is unavailable.');
          const document = parseSequencePackageDocument(
            await platform().fs.readTextFile(metadataPath)
          );
          packageName = sequenceDisplayName(document.name);
          sequenceDocument = {
            kind: 'managed-sequence',
            packageId: document.id,
            packageRoot: fullPath,
          };
        } catch {
          packageName = 'Sequence';
        }
      }
      const importedDisplayName = benchlingImportDisplayName({
        parentPath: dirPath,
        entryName: entry.name,
        isDirectory: isDir,
      });
      const importedName =
        packageKind === 'notebook' && importedDisplayName
          ? ((await readImportedNotebookTitle(fullPath)) ?? importedDisplayName)
          : importedDisplayName;
      const isBiologyFile =
        packageKind === 'sequence' || (!isDir && isBiologySequenceFile(entry.name));
      const name =
        packageName ??
        (isBiologyFile ? sequenceDisplayName(importedName ?? entry.name) : entry.name);

      return {
        kind: 'filesystem',
        entryId: entry.entryId,
        name,
        displayName: isBiologyFile ? undefined : importedName,
        path: fullPath,

        isDirectory: isDir && !packageKind,
        packageKind,
        sequenceDocument,
        isNotebookPackage: packageKind === 'notebook',
        isBiologyFile,
        extension: !isDir && !packageKind ? getExtension(entry.name) : null,
        children: undefined,
      };
    }
  );

  return {
    files: sortEntries(entries),
    catalog: listing.entries.filter(
      (entry): entry is WorkspaceBrowserCatalogEntry => entry.kind === 'catalog'
    ),
    partialError: listing.partialError,
  };
}

function workspaceParentRelativePath(workspaceRoot: string, dirPath: string): string {
  if (!pathIsAtOrUnder(dirPath, workspaceRoot)) {
    throw new Error('Workspace browser directory is outside its mounted root.');
  }
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/$/u, '');
  const directory = dirPath.replace(/\\/g, '/').replace(/\/$/u, '');
  return directory === root ? '' : directory.slice(root.length + 1);
}

function updateEntriesWithChildren(
  entries: FileEntry[],
  targetPath: string,
  children: FileEntry[] | undefined,
  isLoading: boolean
): FileEntry[] {
  return entries.map((entry) => {
    if (entry.path === targetPath) {
      return { ...entry, children, isLoading };
    }
    if (entry.children) {
      return {
        ...entry,
        children: updateEntriesWithChildren(entry.children, targetPath, children, isLoading),
      };
    }
    return entry;
  });
}

function isMissingDirectoryError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code === 'ENOENT' || code === 'ENOTDIR';
  const message = err instanceof Error ? err.message : String(err ?? '');
  return /\b(ENOENT|ENOTDIR)\b|no such file or directory|not a directory/i.test(message);
}

function findEntry(entries: FileEntry[], targetPath: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === targetPath) return entry;
    if (entry.children) {
      const child = findEntry(entry.children, targetPath);
      if (child) return child;
    }
  }
  return null;
}

function preserveExpandedChildren(
  loaded: FileEntry[],
  current: FileEntry[],
  expanded: ReadonlySet<string>
): FileEntry[] {
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]));
  return loaded.map((entry) => {
    const previous = currentByPath.get(entry.path);
    if (!entry.isDirectory || !previous?.isDirectory) return entry;
    if (entry.children === undefined) {
      return expanded.has(entry.path) && previous.children !== undefined
        ? { ...entry, children: previous.children }
        : entry;
    }
    return {
      ...entry,
      children: preserveExpandedChildren(entry.children, previous.children ?? [], expanded),
    };
  });
}

export function useFileBrowser(
  workspacePath: string | null,
  persistExpansion = false,
  listingMode: BrowserListingMode = 'workspace'
): UseFileBrowserReturn {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [projectTreeReceipt, setProjectTreeReceipt] = useState<ProjectTreeReceipt>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogEntriesByParent, setCatalogEntriesByParent] = useState<
    ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]>
  >(new Map());
  const [partialError, setPartialError] = useState<WorkspaceBrowserPartialError | null>(null);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() =>
    persistExpansion && workspacePath ? new Set(readExpandedPaths(workspacePath)) : new Set()
  );

  const expandedRootRef = useRef<string | null>(
    persistExpansion && workspacePath ? workspacePath : null
  );
  const entriesRef = useRef(entries);
  const expandedPathsRef = useRef(expandedPaths);

  const loadGenerationRef = useRef(0);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  const loadRoot = useCallback(
    async (options?: {
      preserveExpanded?: boolean;
      restore?: boolean;
      rejectOnFailure?: boolean;
      beforePublish?: () => void;
    }) => {
      if (!workspacePath) {
        options?.beforePublish?.();
        setEntries([]);
        setCatalogEntriesByParent(new Map());
        setPartialError(null);
        return false;
      }

      const generation = ++loadGenerationRef.current;
      const lifecycle =
        persistExpansion && listingMode === 'workspace'
          ? captureProjectLifecycle(workspacePath)
          : undefined;
      options?.beforePublish?.();
      setProjectTreeReceipt(undefined);
      const isCurrent = () => mountedRef.current && loadGenerationRef.current === generation;

      if (options?.restore && persistExpansion) {
        const seeded = new Set(readExpandedPaths(workspacePath));
        expandedPathsRef.current = seeded;
        expandedRootRef.current = workspacePath;
        setExpandedPaths(seeded);
      }

      setLoading(true);
      setError(null);
      setPartialError(null);

      try {
        const rootListing = await readDirectoryEntries(workspacePath, workspacePath, listingMode);
        let nextEntries = rootListing.files;
        const nextCatalogEntries = new Map<string, readonly WorkspaceBrowserCatalogEntry[]>([
          [workspacePath, rootListing.catalog],
        ]);
        let nextPartialError = rootListing.partialError;
        const replayExpanded = options?.preserveExpanded || options?.restore;
        const pathsToRestore = replayExpanded
          ? Array.from(expandedPathsRef.current).sort((a, b) => a.length - b.length)
          : [];

        const gone: string[] = [];
        const restoredDirectories = await mapAtFixedConcurrency(
          pathsToRestore,
          EXPANDED_DIRECTORY_READ_CONCURRENCY,
          async (path): Promise<PromiseSettledResult<DirectoryEntries>> => {
            try {
              return {
                status: 'fulfilled',
                value: await readDirectoryEntries(workspacePath, path, listingMode),
              };
            } catch (reason) {
              return { status: 'rejected', reason };
            }
          }
        );

        for (const [index, expandedPath] of pathsToRestore.entries()) {
          try {
            const restored = restoredDirectories[index];
            if (restored.status === 'rejected') throw restored.reason;
            const children = restored.value;
            nextEntries = updateEntriesWithChildren(
              nextEntries,
              expandedPath,
              children.files,
              false
            );
            nextCatalogEntries.set(expandedPath, children.catalog);
            nextPartialError ??= children.partialError;
          } catch (err) {
            console.error(`Failed to refresh expanded directory ${expandedPath}:`, err);
            if (options?.rejectOnFailure && !isMissingDirectoryError(err)) throw err;
            nextEntries = updateEntriesWithChildren(nextEntries, expandedPath, [], false);
            if (isMissingDirectoryError(err)) gone.push(expandedPath);
          }
        }

        if (isCurrent()) {
          options?.beforePublish?.();
          setProjectTreeReceipt({
            lifecycle,
            phase: nextPartialError ? 'tree_partial' : 'tree_ready',
          });
          setEntries((currentEntries) => {
            const next = preserveExpandedChildren(
              nextEntries,
              currentEntries,
              expandedPathsRef.current
            );
            entriesRef.current = next;
            return next;
          });
          setCatalogEntriesByParent((previous) => {
            const next = new Map(nextCatalogEntries);
            for (const path of expandedPathsRef.current) {
              const catalog = previous.get(path);
              if (!next.has(path) && catalog) next.set(path, catalog);
            }
            return next;
          });
          setPartialError(nextPartialError);

          if (!replayExpanded) {
            const nextExpandedPaths = new Set<string>();
            expandedPathsRef.current = nextExpandedPaths;
            setExpandedPaths(nextExpandedPaths);
          } else if (gone.length > 0) {
            const nextExpandedPaths = new Set(expandedPathsRef.current);
            for (const dead of gone) nextExpandedPaths.delete(dead);
            expandedPathsRef.current = nextExpandedPaths;
            setExpandedPaths(nextExpandedPaths);
          }
        }
        return isCurrent();
      } catch (err) {
        console.error('Failed to read workspace directory:', err);
        if (isCurrent()) {
          options?.beforePublish?.();
          setProjectTreeReceipt({ lifecycle, phase: 'tree_failed' });
          setError(toUserMessage(err, 'failure.failed-to-read-directory'));
          entriesRef.current = [];
          setEntries([]);
          setCatalogEntriesByParent(new Map());
          setPartialError(null);
        }
        if (options?.rejectOnFailure) throw err;
        return false;
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    },
    [listingMode, persistExpansion, workspacePath]
  );

  useEffect(() => {
    if (!workspacePath || !persistExpansion || listingMode !== 'workspace') return;
    let active = true;
    const unregister = registerWorkspaceDisplayParticipant(async (context) => {
      if (stripTrailingSep(context.workspaceRoot) !== stripTrailingSep(workspacePath)) return;
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!active) return;
          context.assertCurrent();
          const published = await loadRoot({
            preserveExpanded: true,
            rejectOnFailure: true,
            beforePublish() {
              if (!active) throw new Error('Workspace file list was retired.');
              context.assertCurrent();
            },
          });
          if (!active) return;
          context.assertCurrent();
          if (published) return;
        }
        throw new Error('File list reload was superseded before it could publish rebuilt files.');
      } catch (err) {
        if (active) throw err;
      }
    });
    return () => {
      active = false;
      unregister();
    };
  }, [loadRoot, listingMode, persistExpansion, workspacePath]);

  useEffect(() => {
    void loadRoot(persistExpansion ? { restore: true } : { preserveExpanded: false });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadRoot]);

  useEffect(() => {
    if (!persistExpansion || !workspacePath) return;
    if (expandedRootRef.current !== workspacePath) return;
    writeExpandedPaths(workspacePath, Array.from(expandedPaths));
  }, [expandedPaths, workspacePath, persistExpansion]);

  const expandDirectory = useCallback(
    async (path: string) => {
      setEntries((prev) => {
        const next = updateEntriesWithChildren(prev, path, undefined, true);
        entriesRef.current = next;
        return next;
      });

      try {
        if (!workspacePath) return;
        const children = await readDirectoryEntries(workspacePath, path, listingMode);
        if (mountedRef.current) {
          setEntries((prev) => {
            const next = updateEntriesWithChildren(prev, path, children.files, false);
            entriesRef.current = next;
            expandedPathsRef.current = new Set([...expandedPathsRef.current, path]);
            return next;
          });
          setCatalogEntriesByParent((previous) => new Map(previous).set(path, children.catalog));
          if (children.partialError) setPartialError(children.partialError);
          setExpandedPaths((prev) => {
            const next = new Set([...prev, path]);
            expandedPathsRef.current = next;
            return next;
          });
        }
      } catch (err) {
        console.error(`Failed to read directory ${path}:`, err);
        if (mountedRef.current) {
          setEntries((prev) => {
            const next = updateEntriesWithChildren(prev, path, [], false);
            entriesRef.current = next;
            return next;
          });
        }
      }
    },
    [listingMode, workspacePath]
  );

  const expandPathChain = useCallback(
    async (paths: string[]) => {
      const uniquePaths = paths.filter((path, index) => path && paths.indexOf(path) === index);
      if (uniquePaths.length === 0) return;

      let nextEntries = entriesRef.current;
      const nextExpandedPaths = new Set(expandedPathsRef.current);
      let changed = false;

      for (const [index, path] of uniquePaths.entries()) {
        const entry = findEntry(nextEntries, path);
        if (!entry?.isDirectory) continue;

        const nextPath = uniquePaths[index + 1];
        const needsRefresh =
          nextPath !== undefined &&
          pathIsAtOrUnder(nextPath, path) &&
          !findEntry(nextEntries, nextPath);
        if (entry.children !== undefined && !needsRefresh) {
          if (!nextExpandedPaths.has(path)) {
            nextExpandedPaths.add(path);
            changed = true;
          }
          continue;
        }

        try {
          if (!workspacePath) break;
          const children = await readDirectoryEntries(workspacePath, path, listingMode);
          const cached = new Map((entry.children ?? []).map((child) => [child.path, child]));
          const files = children.files.map((child) => {
            const previous = cached.get(child.path);
            return child.isDirectory && previous?.isDirectory
              ? { ...child, children: previous.children, isLoading: previous.isLoading }
              : child;
          });
          nextEntries = updateEntriesWithChildren(nextEntries, path, files, false);
          setCatalogEntriesByParent((previous) => new Map(previous).set(path, children.catalog));
          if (children.partialError) setPartialError(children.partialError);
          nextExpandedPaths.add(path);
          changed = true;
        } catch (err) {
          console.error(`Failed to read directory ${path}:`, err);
          nextEntries = updateEntriesWithChildren(nextEntries, path, [], false);

          nextExpandedPaths.delete(path);
          changed = true;
        }
      }

      if (changed && mountedRef.current) {
        entriesRef.current = nextEntries;
        expandedPathsRef.current = nextExpandedPaths;
        setEntries(nextEntries);
        setExpandedPaths(nextExpandedPaths);
      }
    },
    [listingMode, workspacePath]
  );

  const collapseDirectory = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set<string>();
      for (const candidate of prev) {
        if (candidate === path || pathIsAtOrUnder(candidate, path)) continue;
        next.add(candidate);
      }
      expandedPathsRef.current = next;
      return next;
    });
  }, []);

  const collapseOtherDirectories = useCallback((path: string) => {
    setExpandedPaths((previous) => {
      const next = retainExpandedBranch(previous, path);
      expandedPathsRef.current = next;
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    await loadRoot({ preserveExpanded: true });
  }, [loadRoot]);

  return {
    projectTreeReceipt,
    entries,
    loading,
    error,
    catalogEntriesByParent,
    partialError,
    refresh,
    expandDirectory,
    expandPathChain,
    collapseDirectory,
    collapseOtherDirectories,
    expandedPaths,
  };
}
