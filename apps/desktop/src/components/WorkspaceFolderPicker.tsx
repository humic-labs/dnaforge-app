import { toUserMessage, userMessageWithValues, userMessageValue } from '@waypoint/user-messages';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { platform } from '../platform';
import { relocateRegistryFile } from '../features/workspace/relocate-registry-file';
import { useToastStore } from '../stores/toast-store';
import { useFileBrowser, type FileEntry } from '../hooks/useFileBrowser';
import { FileTreeItem } from './FileTreeItem';
import { FileContextMenu } from './FileContextMenu';
import { fileMenuPathActions } from './file-menu-path-actions';
import { beginSequenceEntryRename } from './sequence-entry-rename';
import { ChevronRotatableIcon, ProjectRootIcon } from './icons';
import { safeFocus, scrollIntoNearestScrollContainer } from '../shared/utils/safeFocus';
import { withPendingArtifacts, findFileEntryByPath } from './fileBrowserTreeUtils';
import type { PendingArtifactCreate } from './fileBrowserTypes';
import { nextAvailableFolderName, createFolderArtifact } from './folder-create';
import { findContainingPathBoundary, pathRelativeToBoundary } from '../shared/path-boundary';

const EMPTY_PATHS = new Set<string>();
const noop = () => {};
const stripTrailer = (p: string) => p.replace(/[\\/]+$/, '');
const sepOf = (p: string) => (p.includes('\\') ? '\\' : '/');
const parentOf = (p: string) => {
  const s = stripTrailer(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : s;
};
const baseName = (p: string) => stripTrailer(p).split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;

function folderEntries(entries: FileEntry[]): FileEntry[] {
  return entries
    .filter((entry) => entry.isDirectory)
    .map((entry) =>
      entry.children ? { ...entry, children: folderEntries(entry.children) } : entry
    );
}

const sanitizeFolderName = (raw: string): string => {
  const cleaned = raw.trim().replace(/[\\/]+/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '' : cleaned;
};

function chainToDir(rootPath: string, dir: string): string[] {
  const rp = stripTrailer(rootPath);
  const target = stripTrailer(dir);
  if (!target || target === rp || !target.startsWith(rp + sepOf(rp))) return [];
  const sep = sepOf(rp);
  const rel = target.slice(rp.length).replace(/^[\\/]+/, '');
  const acc: string[] = [];
  let cur = rp;
  for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
    cur = `${cur}${sep}${seg}`;
    acc.push(cur);
  }
  return acc;
}

interface ContextMenuState extends Pick<FileEntry, 'packageKind' | 'sequenceDocument'> {
  position: { x: number; y: number };
  path: string;
  displayName: string;
  isDirectory: boolean;
  isRoot: boolean;
}

function WorkspaceTree({
  root,
  selectedDir,
  renamingPath,
  pendingArtifacts,
  rootTestId,
  onSelectFolder,
  onContextMenu,
  onOpen,
  onRenameComplete,
  onRenameCancel,
  onRegisterRefresh,
  onRegisterExpand,
  onUnregister,
  autoExpandTo,
  revealRequestId,
  revealTargetPath,
  foldersOnly,
}: {
  root: { path: string; name: string };
  foldersOnly: boolean;
  selectedDir: string;
  renamingPath: string | null;
  pendingArtifacts: PendingArtifactCreate[];
  rootTestId: (path: string) => string;
  onSelectFolder: (dir: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onOpen: (path: string) => void;
  onRenameComplete: (oldPath: string, newName: string) => void;
  onRenameCancel: () => void;
  onRegisterRefresh: (rootPath: string, refresh: () => Promise<void>) => void;
  onRegisterExpand: (rootPath: string, expand: (paths: string[]) => Promise<void>) => void;
  onUnregister: (rootPath: string) => void;
  autoExpandTo: string | null;
  revealRequestId: number;
  revealTargetPath: string | null;
}) {
  const {
    entries,
    loading: rootLoading,
    expandedPaths,
    expandDirectory,
    collapseDirectory,
    expandPathChain,
    refresh,
  } = useFileBrowser(root.path, false, 'filesystem');
  const [rootOpen, setRootOpen] = useState(autoExpandTo !== null);
  const rootRowRef = useRef<HTMLDivElement>(null);
  const lastCenteredRevealRequestIdRef = useRef(0);

  useEffect(() => {
    setRootOpen(autoExpandTo !== null);
  }, [autoExpandTo, selectedDir]);

  useEffect(() => {
    const key = stripTrailer(root.path);
    onRegisterRefresh(key, refresh);
    onRegisterExpand(key, async (paths) => {
      setRootOpen(true);
      await expandPathChain(paths);
    });
    return () => onUnregister(key);
  }, [root.path, refresh, expandPathChain, onRegisterRefresh, onRegisterExpand, onUnregister]);

  const chain = useMemo(
    () => (autoExpandTo ? chainToDir(root.path, autoExpandTo) : []),
    [root.path, autoExpandTo]
  );
  const chainKey = chain.join('\n');
  useEffect(() => {
    if (rootLoading) return;
    if (chain.length) void expandPathChain(chain);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainKey, rootLoading]);

  const handleToggle = useCallback(
    (path: string) => {
      if (expandedPaths.has(path)) collapseDirectory(path);
      else void expandDirectory(path);
    },
    [expandedPaths, collapseDirectory, expandDirectory]
  );

  const handleSelect = useCallback(
    (entryId: string) => {
      const path = entryId.startsWith('filesystem:') ? entryId.slice('filesystem:'.length) : '';
      if (!path) return;
      const entry = findFileEntryByPath(entries, path);
      onSelectFolder(entry && !entry.isDirectory ? parentOf(path) : path);
    },
    [entries, onSelectFolder]
  );

  const visibleEntries = useMemo(() => {
    const tree = withPendingArtifacts(entries, stripTrailer(root.path), pendingArtifacts);
    return foldersOnly ? folderEntries(tree) : tree;
  }, [entries, root.path, pendingArtifacts, foldersOnly]);

  const rootSelected = stripTrailer(selectedDir) === stripTrailer(root.path);
  useEffect(() => {
    if (rootLoading) return;
    if (!Number.isFinite(revealRequestId) || revealRequestId <= 0) return;
    if (lastCenteredRevealRequestIdRef.current === revealRequestId) return;
    if (stripTrailer(revealTargetPath ?? '') !== stripTrailer(root.path)) return;
    if (!rootSelected) return;
    if (scrollIntoNearestScrollContainer(rootRowRef.current, { block: 'center' })) {
      lastCenteredRevealRequestIdRef.current = revealRequestId;
    }
  }, [revealRequestId, revealTargetPath, root.path, rootSelected, rootLoading]);

  const rootEntry: FileEntry = {
    kind: 'filesystem',
    entryId: `filesystem:${stripTrailer(root.path)}`,
    name: root.name,
    path: stripTrailer(root.path),
    isDirectory: true,
    isBiologyFile: false,
    extension: null,
  };
  return (
    <div>
      {}
      <div
        ref={rootRowRef}
        role="button"
        tabIndex={0}
        data-testid={rootTestId(stripTrailer(root.path))}
        onClick={(e) => {
          safeFocus(e.currentTarget);
          onSelectFolder(root.path);
          setRootOpen((o) => !o);
        }}
        onContextMenu={(e) => onContextMenu(e, rootEntry)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSelectFolder(root.path);
            setRootOpen((o) => !o);
          }
        }}
        style={{ paddingLeft: 8 }}
        className={`flex w-full cursor-pointer select-none items-center gap-1.5 py-1 pr-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/45 ${
          rootSelected ? 'bg-accent/15 text-accent' : 'text-fg hover:bg-accent/10'
        }`}
      >
        <span className="flex w-3 flex-shrink-0 items-center">
          <ChevronRotatableIcon expanded={rootOpen} />
        </span>
        <ProjectRootIcon />
        <span className="truncate font-medium">{root.name}</span>
      </div>

      {rootOpen &&
        visibleEntries.map((entry) => (
          <FileTreeItem
            key={entry.entryId}
            entry={entry}
            depth={1}
            expandedPaths={expandedPaths}
            selectedEntryId={`filesystem:${selectedDir}`}
            selectedEntryIds={EMPTY_PATHS}
            focusableEntryId={null}
            revealRequestId={revealRequestId}
            revealTargetPath={revealTargetPath}
            renamingPath={renamingPath}
            rootPath={root.path}
            onToggle={handleToggle}
            onSelect={handleSelect}
            onOpen={(target) => {
              if (target.kind === 'filesystem') onOpen(target.path);
            }}
            onKeyNavigate={noop}
            onContextMenu={(e, target) => {
              if (target.kind === 'filesystem') onContextMenu(e, target);
            }}
            onRenameComplete={onRenameComplete}
            onRenameCancel={onRenameCancel}
            onDelete={noop}
            dragToMoveEnabled={false}
          />
        ))}
    </div>
  );
}

export interface WorkspaceFolderPickerProps {
  roots: ReadonlyArray<{ path: string; name: string }>;
  initialDir: string;
  selectedDir: string;
  onSelectFolder: (folderPath: string) => void;
  idPrefix?: string;
  containerTestId?: string;
  className?: string;
  surface?: 'panel' | 'bare';
  foldersOnly?: boolean;
  readOnly?: boolean;
}

export interface WorkspaceFolderPickerHandle {
  newFolder(dir: string): void;
}

export const WorkspaceFolderPicker = forwardRef<
  WorkspaceFolderPickerHandle,
  WorkspaceFolderPickerProps
>(function WorkspaceFolderPicker(
  {
    roots,
    initialDir,
    selectedDir,
    onSelectFolder,
    idPrefix = 'workspace-folder-picker',
    containerTestId,
    className,
    surface = 'panel',
    foldersOnly = false,
    readOnly = false,
  },
  ref
) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [pendingArtifacts, setPendingArtifacts] = useState<PendingArtifactCreate[]>([]);
  const refreshers = useRef(new Map<string, () => Promise<void>>());
  const expanders = useRef(new Map<string, (paths: string[]) => Promise<void>>());

  const [revealRequestId, setRevealRequestId] = useState(0);
  const revealedForRef = useRef<string | null>(null);
  const revealTargetPath = stripTrailer(selectedDir || initialDir || '') || null;
  useEffect(() => {
    if (!revealTargetPath || revealedForRef.current === revealTargetPath) return;
    revealedForRef.current = revealTargetPath;
    setRevealRequestId((n) => n + 1);
  }, [revealTargetPath]);

  const rootTestId = useCallback((path: string) => `${idPrefix}-folder-${path}`, [idPrefix]);

  const registerRefresh = useCallback((rootPath: string, refresh: () => Promise<void>) => {
    refreshers.current.set(rootPath, refresh);
  }, []);
  const registerExpand = useCallback(
    (rootPath: string, expand: (paths: string[]) => Promise<void>) => {
      expanders.current.set(rootPath, expand);
    },
    []
  );
  const unregisterTree = useCallback((rootPath: string) => {
    refreshers.current.delete(rootPath);
    expanders.current.delete(rootPath);
  }, []);

  const ownerRootOf = useCallback(
    (dir: string) => {
      const owner = findContainingPathBoundary(roots, dir);
      return owner ? stripTrailer(owner.path) : undefined;
    },
    [roots]
  );
  const relativePathOf = useCallback(
    (p: string) => {
      const owner = findContainingPathBoundary(roots, p);
      if (!owner) return null;
      const rel = pathRelativeToBoundary(p, owner.path);
      return rel === null ? null : rel || '.';
    },
    [roots]
  );
  const refreshOwner = useCallback(
    async (dir: string) => {
      const owner = ownerRootOf(dir);
      if (owner) await refreshers.current.get(owner)?.();
    },
    [ownerRootOf]
  );

  const openContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry, isRoot: boolean) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly) return;
      setContextMenu({
        position: { x: e.clientX, y: e.clientY },
        path: entry.path,
        displayName: entry.name,
        packageKind: entry.packageKind,
        sequenceDocument: entry.sequenceDocument,
        isDirectory: entry.isDirectory,
        isRoot,
      });
    },
    [readOnly]
  );

  const beginNewFolder = useCallback(
    async (dir: string) => {
      if (readOnly) return;
      const parent = stripTrailer(dir);
      const chosen = await nextAvailableFolderName(
        parent,
        async (path) => pendingArtifacts.some((p) => p.path === path) || platform().fs.exists(path)
      );
      if (!chosen) return;
      const owner = ownerRootOf(parent);
      const pending: PendingArtifactCreate = {
        id: crypto.randomUUID(),
        kind: 'folder',
        parentPath: parent,
        path: chosen.path,
        fileName: chosen.name,
        workspaceRoot: owner ?? null,
        context: { parentPath: parent, workspaceRoot: owner ?? null },
      };
      if (owner) {
        const expand = expanders.current.get(owner);
        const chain = chainToDir(owner, parent);
        if (expand) await expand(chain);
      }
      setPendingArtifacts((prev) => [...prev, pending]);
      setRenamingPath(pending.path);
    },
    [pendingArtifacts, ownerRootOf, readOnly]
  );

  useImperativeHandle(ref, () => ({ newFolder: (dir: string) => void beginNewFolder(dir) }), [
    beginNewFolder,
  ]);

  const commitPending = useCallback(
    async (pending: PendingArtifactCreate, requestedName: string) => {
      const name = sanitizeFolderName(requestedName) || pending.fileName;
      const sep = sepOf(pending.parentPath);
      const finalPath = `${stripTrailer(pending.parentPath)}${sep}${name}`;
      if (finalPath !== pending.path && (await platform().fs.exists(finalPath))) {
        return;
      }
      try {
        await createFolderArtifact({
          path: finalPath,
          name,
          parentPath: pending.parentPath,
          workspaceRoot: pending.workspaceRoot,
          createdBy: 'workspace-folder-picker',
        });
      } catch {
        return;
      }
      setPendingArtifacts((prev) => prev.filter((p) => p.id !== pending.id));
      setRenamingPath(null);
      await refreshOwner(pending.parentPath);
      onSelectFolder(finalPath);
    },
    [refreshOwner, onSelectFolder]
  );

  const commitRename = useCallback(
    async (oldPath: string, newName: string) => {
      setRenamingPath(null);
      const clean = sanitizeFolderName(newName);
      if (!clean || clean === baseName(oldPath)) return;
      const newPath = `${parentOf(oldPath)}${sepOf(oldPath)}${clean}`;
      try {
        if (await platform().fs.exists(newPath)) return;
        await relocateRegistryFile({
          workspaceRoot: ownerRootOf(oldPath) ?? null,
          oldPath,
          newPath,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : '';
        useToastStore.getState().addToast(
          raw.replace(/^[A-Z_]+:\s*/, '')
            ? toUserMessage(raw.replace(/^[A-Z_]+:\s*/, ''), 'operation.failed')
            : userMessageWithValues('notice.couldn-t-rename-value', {
                value0: userMessageValue(baseName(oldPath)),
              }),
          { definition: 'workspace-folder-picker-commit-rename' }
        );
        console.error('[WorkspaceFolderPicker] Failed to rename folder:', err);
        return;
      }
      try {
        await refreshOwner(oldPath);
        if (stripTrailer(selectedDir) === stripTrailer(oldPath)) onSelectFolder(newPath);
      } catch {}
    },
    [ownerRootOf, refreshOwner, selectedDir, onSelectFolder]
  );

  const handleRenameComplete = useCallback(
    (oldPath: string, newName: string) => {
      if (readOnly) return;
      const pending = pendingArtifacts.find((p) => p.path === oldPath);
      if (pending) {
        void commitPending(pending, newName);
        return;
      }
      void commitRename(oldPath, newName);
    },
    [pendingArtifacts, commitPending, commitRename, readOnly]
  );

  const handleRenameCancel = useCallback(() => {
    setPendingArtifacts((prev) => prev.filter((p) => p.path !== renamingPath));
    setRenamingPath(null);
  }, [renamingPath]);

  const handleOpen = useCallback(
    (path: string, isDirectory: boolean) => {
      if (!isDirectory) {
        onSelectFolder(parentOf(path));
        return;
      }
      const owner = ownerRootOf(path);
      const expand = owner ? expanders.current.get(owner) : undefined;
      const chain = owner ? chainToDir(owner, path) : [];
      if (expand) void expand(chain);
      onSelectFolder(path);
    },
    [ownerRootOf, onSelectFolder]
  );

  return (
    <div className={surface === 'bare' ? 'h-full min-h-0' : undefined}>
      <div
        data-testid={containerTestId ?? idPrefix}
        data-file-move-disabled=""
        className={`overflow-auto bg-bg py-1 ${
          surface === 'panel' ? 'rounded-md border border-border' : ''
        } ${className ?? 'max-h-[45vh] min-h-[160px]'}`}
      >
        {roots.map((root) => {
          const rp = stripTrailer(root.path);
          const target = revealTargetPath;
          const owns = rp === ownerRootOf(target ?? '');
          return (
            <WorkspaceTree
              key={rp}
              root={root}
              foldersOnly={foldersOnly}
              selectedDir={selectedDir}
              renamingPath={renamingPath}
              pendingArtifacts={pendingArtifacts}
              rootTestId={rootTestId}
              onSelectFolder={onSelectFolder}
              onOpen={(path) => handleOpen(path, false)}
              onContextMenu={(e, entry) =>
                openContextMenu(e, entry, stripTrailer(entry.path) === rp)
              }
              onRenameComplete={handleRenameComplete}
              onRenameCancel={handleRenameCancel}
              onRegisterRefresh={registerRefresh}
              onRegisterExpand={registerExpand}
              onUnregister={unregisterTree}
              autoExpandTo={owns ? target : null}
              revealRequestId={owns ? revealRequestId : 0}
              revealTargetPath={owns ? revealTargetPath : null}
            />
          );
        })}
      </div>

      {!readOnly && contextMenu && (
        <FileContextMenu
          position={contextMenu.position}
          {...fileMenuPathActions(contextMenu.path, relativePathOf(contextMenu.path))}
          displayName={contextMenu.displayName}
          isDirectory={contextMenu.isDirectory}
          isRootFolder={contextMenu.isRoot}
          onClose={() => setContextMenu(null)}
          onOpen={() => {
            handleOpen(contextMenu.path, contextMenu.isDirectory);
            setContextMenu(null);
          }}
          onRename={
            contextMenu.isRoot
              ? undefined
              : () => {
                  if (
                    !beginSequenceEntryRename({
                      name: contextMenu.displayName,
                      packageKind: contextMenu.packageKind,
                      sequenceDocument: contextMenu.sequenceDocument,
                    })
                  ) {
                    setRenamingPath(contextMenu.path);
                  }
                  setContextMenu(null);
                }
          }
          onNewFolder={() => {
            void beginNewFolder(
              contextMenu.isDirectory ? contextMenu.path : parentOf(contextMenu.path)
            );
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
});
