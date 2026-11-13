import type { FileEntry } from '../hooks/useFileBrowser';
import type { WorkspaceBrowserCatalogEntry } from '../shared/workspace-browser-types';
import type { WorkspaceFolder } from '../stores/workspaceStore';
import { findWorkspaceRootForPath } from '../db/workspace-catalog';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import type { FileBrowserTreeEntry, PendingArtifactCreate } from './fileBrowserTypes';

export function sortBrowserEntries(entries: FileBrowserTreeEntry[]): FileBrowserTreeEntry[] {
  return [...entries].sort((left, right) => {
    const leftDirectory = left.kind === 'filesystem' && left.isDirectory;
    const rightDirectory = right.kind === 'filesystem' && right.isDirectory;
    if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
    const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
    return byName !== 0 ? byName : left.entryId.localeCompare(right.entryId);
  });
}

export function flattenVisibleEntries(
  entries: FileEntry[],
  expandedPaths: Set<string>,
  catalogEntriesByParent: ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]> = new Map(),
  parentPath = ''
): FileBrowserTreeEntry[] {
  const flat: FileBrowserTreeEntry[] = [];
  const siblings = sortBrowserEntries([
    ...entries,
    ...(catalogEntriesByParent.get(parentPath) ?? []),
  ]);
  for (const entry of siblings) {
    flat.push(entry);
    if (
      entry.kind === 'filesystem' &&
      entry.isDirectory &&
      expandedPaths.has(entry.path) &&
      entry.children
    ) {
      flat.push(
        ...flattenVisibleEntries(entry.children, expandedPaths, catalogEntriesByParent, entry.path)
      );
    }
  }
  return flat;
}

export function findParentEntryId(
  entries: FileEntry[],
  targetEntryId: string,
  catalogEntriesByParent: ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]> = new Map(),
  parentEntryId: string | null = null,
  parentPath = ''
): string | null {
  const catalogEntries = catalogEntriesByParent.get(parentPath) ?? [];
  if (catalogEntries.some((entry) => entry.entryId === targetEntryId)) return parentEntryId;
  for (const entry of entries) {
    if (entry.entryId === targetEntryId) return parentEntryId;
    if (entry.children) {
      const found = findParentEntryId(
        entry.children,
        targetEntryId,
        catalogEntriesByParent,
        entry.entryId,
        entry.path
      );
      if (found) return found;
    }
  }
  return null;
}

export function findBrowserEntryById(
  entries: FileEntry[],
  targetEntryId: string,
  catalogEntriesByParent: ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]> = new Map(),
  parentPath = ''
): FileBrowserTreeEntry | null {
  const catalogEntry = (catalogEntriesByParent.get(parentPath) ?? []).find(
    (entry) => entry.entryId === targetEntryId
  );
  if (catalogEntry) return catalogEntry;
  for (const entry of entries) {
    if (entry.entryId === targetEntryId) return entry;
    if (entry.children) {
      const found = findBrowserEntryById(
        entry.children,
        targetEntryId,
        catalogEntriesByParent,
        entry.path
      );
      if (found) return found;
    }
  }
  return null;
}

export function rangeBetweenEntryIds(
  entryIds: string[],
  anchorEntryId: string,
  activeEntryId: string
): string[] {
  const anchorIndex = entryIds.indexOf(anchorEntryId);
  const activeIndex = entryIds.indexOf(activeEntryId);
  if (anchorIndex === -1 || activeIndex === -1) return [activeEntryId];
  const start = Math.min(anchorIndex, activeIndex);
  const end = Math.max(anchorIndex, activeIndex);
  return entryIds.slice(start, end + 1);
}

export function rangeBetweenPaths(
  paths: string[],
  anchorPath: string,
  activePath: string
): string[] {
  return rangeBetweenEntryIds(paths, anchorPath, activePath);
}

export function findFileEntryByPath(entries: FileEntry[], targetPath: string): FileEntry | null {
  for (const entry of entries) {
    if (entry.path === targetPath) return entry;
    if (entry.children) {
      const found = findFileEntryByPath(entry.children, targetPath);
      if (found) return found;
    }
  }
  return null;
}

export function workspaceRelativePathForPath(
  folders: WorkspaceFolder[],
  path: string
): string | null {
  const workspaceRoot = findWorkspaceRootForPath(folders, path);
  if (!workspaceRoot) return null;
  const relative = pathRelativeToBoundary(path, workspaceRoot);
  if (relative === null) return null;
  return relative === '' ? '.' : relative;
}

function extensionForName(name: string): string | null {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1 || lastDot === name.length - 1) return null;
  return name.slice(lastDot + 1).toLowerCase();
}

function pendingArtifactToFileEntry(pending: PendingArtifactCreate): FileEntry {
  const isDirectory = pending.kind === 'folder';
  return {
    kind: 'filesystem',
    entryId: `pending:${pending.id}`,
    name: pending.fileName,
    path: pending.path,
    isDirectory,
    isBiologyFile: false,
    extension: isDirectory ? null : extensionForName(pending.fileName),
    children: isDirectory ? [] : undefined,
    isPending: true,
  };
}

export function withPendingArtifacts(
  entries: FileEntry[],
  parentPath: string,
  pendingArtifacts: PendingArtifactCreate[]
): FileEntry[] {
  const childEntries = entries.map((entry) => {
    if (!entry.isDirectory) return entry;
    if (!entry.children) return entry;
    return {
      ...entry,
      children: withPendingArtifacts(entry.children, entry.path, pendingArtifacts),
    };
  });
  const pendingHere = pendingArtifacts
    .filter((pending) => pending.parentPath === parentPath)
    .map(pendingArtifactToFileEntry);
  return pendingHere.length > 0 ? [...childEntries, ...pendingHere] : childEntries;
}
