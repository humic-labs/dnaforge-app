import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import type { FileEntry } from '../hooks/useFileBrowser';
import type { WorkspaceBrowserCatalogEntry } from '../shared/workspace-browser-types';
import { startFileDrag } from '../hooks/useFileDrag';
import type { GitFileStatus } from '../features/workspace/git';
import { safeFocus, scrollIntoNearestScrollContainer } from '../shared/utils/safeFocus';
import { FileTypeIcon, FolderIcon } from './icons';
import { useSequenceStore } from '../features/sequence/store';
import { useCanvasStore } from '../features/canvas/store';
import { sequenceDocumentKey } from '../shared/managed-sequence-document';
import {
  entityIconKindForCatalogPresentation,
  iconForEntityKind,
} from './icons/entity-icon-registry';
import { TreeRow } from '../shared/components/tree/TreeRow';
import { getFileIconCategory, getTabTypeForFile } from '../utils/fileTypes';
import { TREE_HIDDEN_COMPOUND_SUFFIXES } from '../shared/registry-file-types';
import type { FileSelectionIntent } from './fileBrowserTypes';
import type { FileBrowserTreeEntry } from './fileBrowserTypes';
import { sortBrowserEntries } from './fileBrowserTreeUtils';
import { isApplePlatform } from './menuShortcuts';
import { pathRelativeToBoundary } from '../shared/path-boundary';
import { isHostedBrowserRuntime } from '../utils/environment';
import { isSupportedSequencePath } from '../shared/scientific-file-types';
import { isTypedDocumentCandidate } from '../shared/document-availability';
import { useDocumentAvailability } from '../features/document-opening/useDocumentAvailability';
import { userMessage } from '@waypoint/user-messages';

interface FileTreeItemProps {
  entry: FileBrowserTreeEntry;
  depth: number;
  expandedPaths: Set<string>;
  selectedEntryId: string | null;
  selectedEntryIds: Set<string>;
  focusableEntryId: string | null;
  revealRequestId: number;
  revealTargetPath: string | null;
  renamingPath: string | null;
  gitStatusMap?: Map<string, GitFileStatus>;
  rootPath?: string;
  catalogEntriesByParent?: ReadonlyMap<string, readonly WorkspaceBrowserCatalogEntry[]>;
  onToggle: (path: string) => void;
  onSelect: (entryId: string, intent?: FileSelectionIntent) => void;
  onOpen: (entry: FileBrowserTreeEntry) => void;
  onKeyNavigate: (entry: FileBrowserTreeEntry, e: KeyboardEvent) => void;
  onContextMenu?: (e: MouseEvent, entry: FileBrowserTreeEntry) => void;
  onRenameComplete: (oldPath: string, newName: string) => void | Promise<void>;
  onRenameCancel: () => void;
  onDelete: (path: string) => void;

  dragToMoveEnabled?: boolean;
}

const WORKSPACE_ROOT_SELECTOR = '[data-workspace-root-path]';

function focusTreeItemWithinActiveRoot(item: HTMLElement | null): void {
  if (!item) return;
  const activeElement = document.activeElement as HTMLElement | null;
  if (activeElement?.getAttribute('role') !== 'treeitem') return;
  if (activeElement.closest(WORKSPACE_ROOT_SELECTOR) !== item.closest(WORKSPACE_ROOT_SELECTOR)) {
    return;
  }
  safeFocus(item);
}

const FileIcon = ({ entry }: { entry: FileEntry }) => {
  const documentId = useCanvasStore((state) => {
    if (entry.sequenceDocument) return sequenceDocumentKey(entry.sequenceDocument);
    for (const panel of Object.values(state.panels)) {
      for (const tab of panel.tabs) {
        if (tab.type !== 'sequence' || !tab.sequenceDocument) continue;
        const sourcePath =
          tab.sequenceDocument.kind === 'import-source-sequence'
            ? tab.sequenceDocument.sourcePath
            : tab.sourceFileName;
        if (sourcePath?.replace(/\\/g, '/') === entry.path.replace(/\\/g, '/'))
          return sequenceDocumentKey(tab.sequenceDocument);
      }
    }
    return undefined;
  });
  const molecule = useSequenceStore((state) =>
    documentId ? state.sequences[documentId]?.molecule : undefined
  );
  const context = {
    path: entry.path,
    packageKind: entry.packageKind,
    ...entry.iconContext,
    molecule: molecule ?? entry.iconContext?.molecule,
  };
  if (entry.iconContext?.kind && !['file', 'text', 'generic'].includes(entry.iconContext.kind)) {
    const typed = iconForEntityKind(entry.iconContext.kind, 'w-4 h-4 flex-shrink-0', context);
    if (typed) return <>{typed}</>;
  }
  if (entry.packageKind) {
    const packaged = iconForEntityKind(entry.packageKind, 'w-4 h-4 flex-shrink-0', context);
    if (packaged) return <>{packaged}</>;
  }
  if (getTabTypeForFile(entry.name) === 'primer') {
    return <>{iconForEntityKind('primer', 'w-4 h-4 flex-shrink-0', context)}</>;
  }
  const category = entry.isBiologyFile ? 'biology' : getFileIconCategory(entry.name);
  return (
    <FileTypeIcon
      category={category}
      className="w-4 h-4 flex-shrink-0"
      context={{
        ...context,
        ...(category === 'genome' ? { kind: 'track-view' } : {}),
      }}
    />
  );
};

function editableStemLength(entry: FileEntry): number {
  if (entry.packageKind || entry.isNotebookPackage || entry.isBiologyFile) return entry.name.length;
  if (entry.isDirectory) return entry.name.length;
  const lowerName = entry.name.toLowerCase();

  for (const compoundExtension of TREE_HIDDEN_COMPOUND_SUFFIXES) {
    if (lowerName.endsWith(compoundExtension)) {
      return entry.name.length - compoundExtension.length;
    }
  }
  if (!entry.extension) return entry.name.length;
  return entry.name.length - (entry.extension.length + 1);
}

function displayName(entry: FileEntry): string {
  if (entry.displayName?.trim()) return entry.displayName.trim();
  const stem = entry.name.slice(0, editableStemLength(entry));
  return stem.length > 0 ? stem : entry.name;
}

function hiddenRenameSuffix(entry: FileEntry): string {
  if (entry.isDirectory || entry.packageKind || entry.isNotebookPackage) return '';
  if (entry.isBiologyFile) {
    const filename = entry.path.split(/[\\/]/u).pop() ?? '';
    const match = filename.match(/\.(?:[^.]+\.)?(?:gz|bgz|bgzf)$|\.[^.]+$/iu);
    return match?.[0] ?? '';
  }
  const lowerName = entry.name.toLowerCase();
  for (const compoundExtension of TREE_HIDDEN_COMPOUND_SUFFIXES) {
    if (lowerName.endsWith(compoundExtension)) {
      return entry.name.slice(entry.name.length - compoundExtension.length);
    }
  }
  return '';
}

function renameStem(entry: FileEntry): string {
  if (entry.isBiologyFile) return entry.name;
  const suffix = hiddenRenameSuffix(entry);
  return suffix ? entry.name.slice(0, entry.name.length - suffix.length) : entry.name;
}

function isMoveToTrashShortcut(e: KeyboardEvent): boolean {
  if (isApplePlatform()) {
    return e.key === 'Backspace' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  }
  return e.key === 'Delete' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
}

export function FileTreeItem(props: FileTreeItemProps) {
  return props.entry.kind === 'catalog' ? (
    <CatalogTreeItem {...props} entry={props.entry} />
  ) : (
    <FilesystemTreeItem {...props} entry={props.entry} />
  );
}

function CatalogTreeItem({
  entry,
  depth,
  selectedEntryId,
  selectedEntryIds,
  focusableEntryId,
  onSelect,
  onOpen,
  onKeyNavigate,
  onContextMenu,
}: Omit<FileTreeItemProps, 'entry'> & { entry: WorkspaceBrowserCatalogEntry }) {
  const itemRef = useRef<HTMLDivElement>(null);
  const isSelected = selectedEntryIds.has(entry.entryId) || selectedEntryId === entry.entryId;
  const isFocusable = focusableEntryId === entry.entryId;

  useEffect(() => {
    if (!isFocusable) return;
    focusTreeItemWithinActiveRoot(itemRef.current);
  }, [isFocusable]);

  return (
    <TreeRow
      ref={itemRef}
      depth={depth}
      data-testid="file-tree-item"
      data-entry-id={entry.entryId}
      data-entry-kind="catalog"
      data-entry-name={entry.name}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      tabIndex={isFocusable ? 0 : -1}
      onClick={(event) => {
        safeFocus(event.currentTarget);
        onSelect(entry.entryId, {
          extend: event.shiftKey,
          toggle: event.metaKey || event.ctrlKey,
        });
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        onOpen(entry);
      }}
      onKeyDown={(event) => onKeyNavigate(entry, event)}
      onContextMenu={(event) => {
        event.preventDefault();
        safeFocus(event.currentTarget);
        if (!selectedEntryIds.has(entry.entryId)) onSelect(entry.entryId);
        onContextMenu?.(event, entry);
      }}
      title={entry.name}
      isSelected={isSelected}
      icon={iconForEntityKind(
        entityIconKindForCatalogPresentation(entry.presentationKind),
        'w-4 h-4 flex-shrink-0',
        entry.iconContext
      )}
      label={entry.name}
      labelTitle={entry.name}
    />
  );
}

function FilesystemTreeItem({
  entry,
  depth,
  expandedPaths,
  selectedEntryId,
  selectedEntryIds,
  focusableEntryId,
  revealRequestId,
  revealTargetPath,
  renamingPath,
  gitStatusMap,
  rootPath,
  catalogEntriesByParent = new Map(),
  onToggle,
  onSelect,
  onOpen,
  onKeyNavigate,
  onContextMenu,
  onRenameComplete,
  onRenameCancel,
  onDelete,
  dragToMoveEnabled = true,
}: Omit<FileTreeItemProps, 'entry'> & { entry: FileEntry }) {
  const typedCandidate =
    !entry.isDirectory && (Boolean(entry.packageKind) || isTypedDocumentCandidate(entry.path));
  const availability = useDocumentAvailability(rootPath, typedCandidate ? entry.path : undefined);
  const showNeutralIcon = availability?.state === 'checking' || availability?.state === 'blocked';
  const availabilityDetail =
    availability?.state === 'blocked'
      ? availability.reason
      : availability?.state === 'checking'
        ? userMessage('document.checking')
        : availability?.state === 'unchecked'
          ? userMessage('document.checkOnOpen')
          : undefined;
  const [renameValue, setRenameValue] = useState(() => renameStem(entry));
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);
  const lastCenteredRevealRequestIdRef = useRef(0);
  const lastSubmittedRenameValueRef = useRef<string | null>(null);
  const renameSubmissionRef = useRef<symbol | null>(null);
  const isRenaming = renamingPath === entry.path;
  const currentRenameStem = renameStem(entry);
  const selectWholeRenameValue = entry.isDirectory || Boolean(hiddenRenameSuffix(entry));
  const renameSelectionEnd = editableStemLength(entry);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      safeFocus(inputRef.current);

      if (selectWholeRenameValue) {
        inputRef.current.select();
      } else {
        inputRef.current.setSelectionRange(0, renameSelectionEnd);
      }
    }
  }, [entry.path, isRenaming, renameSelectionEnd, selectWholeRenameValue]);

  useEffect(() => {
    setRenameValue(currentRenameStem);
  }, [
    currentRenameStem,
    entry.path,
    entry.name,
    entry.displayName,
    entry.isDirectory,
    entry.packageKind,
  ]);

  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (isRenaming) return;
      if (entry.isPending) return;
      safeFocus(e.currentTarget);
      onSelect(entry.entryId, {
        extend: e.shiftKey,
        toggle: e.metaKey || e.ctrlKey,
      });
      if (entry.isDirectory) {
        if (e.shiftKey || e.metaKey || e.ctrlKey) return;
        onToggle(entry.path);
      } else if (isHostedBrowserRuntime()) {
        onOpen(entry);
      }
    },
    [entry, onToggle, onSelect, onOpen, isRenaming]
  );

  const handleDoubleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (isRenaming) return;
      if (entry.isPending) return;
      if (entry.isDirectory) return;
      e.preventDefault();
      onOpen(entry);
    },
    [entry, onOpen, isRenaming]
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (isRenaming) return;
      if (entry.isPending) return;
      safeFocus(e.currentTarget);
      if (!selectedEntryIds.has(entry.entryId)) {
        onSelect(entry.entryId);
      }
      onContextMenu?.(e, { ...entry, documentAvailability: availability });
    },
    [entry, availability, onContextMenu, onSelect, isRenaming, selectedEntryIds]
  );

  const handleRenameSubmit = useCallback(() => {
    const trimmedValue = renameValue.trim();
    if (!trimmedValue) {
      onRenameCancel();
      return;
    }

    const suffix = hiddenRenameSuffix(entry);
    const explicitSequenceFilename = entry.isBiologyFile && isSupportedSequencePath(trimmedValue);
    const finalName =
      suffix &&
      !trimmedValue.toLowerCase().endsWith(suffix.toLowerCase()) &&
      !explicitSequenceFilename
        ? `${trimmedValue}${suffix}`
        : trimmedValue;
    const originalRenameStem = renameStem(entry);
    if ((trimmedValue !== originalRenameStem && finalName !== entry.name) || entry.isPending) {
      if (lastSubmittedRenameValueRef.current === finalName) return;
      lastSubmittedRenameValueRef.current = finalName;
      const submission = Symbol('rename-submission');
      renameSubmissionRef.current = submission;
      void Promise.resolve(onRenameComplete(entry.path, finalName)).catch(() => {
        if (renameSubmissionRef.current === submission) {
          lastSubmittedRenameValueRef.current = null;
          renameSubmissionRef.current = null;
        }
      });
    } else {
      onRenameCancel();
    }
  }, [renameValue, entry, onRenameComplete, onRenameCancel]);

  const handleRenameKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setRenameValue(entry.name);
        onRenameCancel();
      }
    },
    [handleRenameSubmit, entry.name, onRenameCancel]
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isRenaming && !entry.isPending && isMoveToTrashShortcut(e)) {
        e.preventDefault();
        e.stopPropagation();
        onDelete(entry.path);
        return;
      }
      onKeyNavigate(entry, e);
    },
    [entry, isRenaming, onDelete, onKeyNavigate]
  );

  const isExpanded = expandedPaths.has(entry.path);
  const isSelected = selectedEntryIds.has(entry.entryId) || selectedEntryId === entry.entryId;
  const isFocusable = focusableEntryId === entry.entryId;
  const isDesign = !entry.isDirectory && getFileIconCategory(entry.name) === 'design';
  const paddingLeft = 8 + depth * 16;

  useEffect(() => {
    if (!Number.isFinite(revealRequestId) || revealRequestId <= 0) return;
    if (lastCenteredRevealRequestIdRef.current === revealRequestId) return;
    if (revealTargetPath !== entry.path) return;
    if (selectedEntryId !== entry.entryId) return;
    lastCenteredRevealRequestIdRef.current = revealRequestId;

    scrollIntoNearestScrollContainer(itemRef.current, { block: 'center' });
  }, [entry.entryId, entry.path, revealRequestId, revealTargetPath, selectedEntryId]);

  useEffect(() => {
    if (!isFocusable) return;
    focusTreeItemWithinActiveRoot(itemRef.current);
  }, [isFocusable]);

  const relativePath = rootPath
    ? (pathRelativeToBoundary(entry.path, rootPath) ?? entry.name)
    : entry.name;
  const gitFileStatus = gitStatusMap?.get(relativePath);

  const dirGitStatus = useMemo(() => {
    const aggregates = entry.isDirectory || Boolean(entry.packageKind);
    if (!aggregates || !gitStatusMap || !relativePath) return undefined;
    const prefix = relativePath + '/';
    let worst: GitFileStatus | undefined;
    const priority: Record<GitFileStatus, number> = {
      deleted: 3,
      modified: 2,
      added: 1,
      untracked: 1,
      renamed: 0,
    };
    for (const [path, status] of gitStatusMap) {
      if (path.startsWith(prefix)) {
        if (!worst || priority[status] > priority[worst]) {
          worst = status;
        }
      }
    }
    return worst;
  }, [entry.isDirectory, entry.packageKind, gitStatusMap, relativePath]);

  const effectiveGitStatus = gitFileStatus || dirGitStatus;

  const gitTextClass =
    effectiveGitStatus === 'modified'
      ? 'text-yellow-600 dark:text-yellow-300'
      : effectiveGitStatus === 'untracked' || effectiveGitStatus === 'added'
        ? 'text-green-600 dark:text-green-300'
        : effectiveGitStatus === 'deleted'
          ? 'text-red-600 dark:text-red-300'
          : '';

  const browserChildren = entry.isDirectory
    ? sortBrowserEntries([
        ...(entry.children ?? []),
        ...(catalogEntriesByParent.get(entry.path) ?? []),
      ])
    : [];

  return (
    <div>
      <TreeRow
        ref={itemRef}
        depth={depth}
        data-testid={
          !entry.isDirectory && entry.path.includes('/hosted/')
            ? 'hosted-tree-file'
            : 'file-tree-item'
        }
        data-entry-id={entry.entryId}
        data-entry-kind="filesystem"
        data-entry-path={entry.path}
        data-document-path={
          !entry.isDirectory && entry.path.includes('/hosted/')
            ? entry.path.split('/').slice(3).join('/')
            : undefined
        }
        data-entry-name={entry.name}
        data-document-availability={availability?.state}
        data-git-status={effectiveGitStatus ?? undefined}
        data-file-drop-target={entry.isDirectory && dragToMoveEnabled ? 'true' : undefined}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={entry.isDirectory ? isExpanded : undefined}
        tabIndex={isFocusable ? 0 : -1}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
        onMouseDown={(e) => {
          if (!dragToMoveEnabled) return;
          if (isRenaming || entry.isPending) return;
          if (e.button !== 0) return;
          startFileDrag(entry.path, entry.name, e);
        }}
        title={
          availabilityDetail ??
          (isDesign ? displayName(entry) : entry.isBiologyFile ? entry.name : entry.path)
        }
        isSelected={isSelected}
        isExpanded={entry.isDirectory ? isExpanded : undefined}
        isLoading={entry.isDirectory ? entry.isLoading : undefined}
        className={[entry.isBiologyFile ? 'font-medium' : '', isRenaming ? 'bg-bg-muted' : '']
          .filter(Boolean)
          .join(' ')}
        icon={
          entry.isDirectory ? (
            <FolderIcon expanded={isExpanded} className="w-4 h-4 flex-shrink-0" />
          ) : showNeutralIcon ? (
            <FileTypeIcon category="generic" className="w-4 h-4 flex-shrink-0" />
          ) : (
            <FileIcon entry={entry} />
          )
        }
        labelClassName={isRenaming ? 'flex-1 min-w-0' : gitTextClass}
        labelTitle={
          isRenaming
            ? undefined
            : (availabilityDetail ??
              (isDesign ? displayName(entry) : (entry.displayName ?? entry.name)))
        }
        label={
          isRenaming ? (
            <input
              ref={inputRef}
              type="text"
              data-testid="file-tree-rename-input"
              aria-label={`Name for ${entry.name}`}
              value={renameValue}
              onChange={(e) => {
                lastSubmittedRenameValueRef.current = null;
                renameSubmissionRef.current = null;
                setRenameValue(e.target.value);
              }}
              onBlur={handleRenameSubmit}
              onKeyDown={handleRenameKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="w-full min-w-0 select-text px-1 py-0.5 text-sm bg-bg border border-accent rounded outline-none"
            />
          ) : (
            <>
              {displayName(entry)}
              {availabilityDetail && (
                <span className="block whitespace-normal text-xs leading-tight text-fg-subtle">
                  {availabilityDetail}
                </span>
              )}
            </>
          )
        }
        trailing={
          <>
            {}
            {!isRenaming &&
              !entry.isBiologyFile &&
              !isDesign &&
              displayName(entry) !== entry.name && (
                <span className="sr-only" aria-hidden="true">
                  {entry.name}
                </span>
              )}

            {!isRenaming && entry.isBiologyFile && entry.extension && (
              <span className="ml-auto text-xs text-fg-subtle uppercase">{entry.extension}</span>
            )}

            {!isRenaming && gitFileStatus && (
              <span
                className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
                  gitFileStatus === 'modified'
                    ? 'bg-yellow-400'
                    : gitFileStatus === 'untracked' || gitFileStatus === 'added'
                      ? 'bg-green-400'
                      : gitFileStatus === 'deleted'
                        ? 'bg-red-400'
                        : ''
                } ${entry.isBiologyFile ? '' : 'ml-auto'}`}
                title={`Git: ${gitFileStatus}`}
              />
            )}
          </>
        }
      />

      {entry.isDirectory && isExpanded && entry.children && (
        <div>
          {browserChildren.length === 0 ? (
            <div
              style={{ paddingLeft: paddingLeft + 20 }}
              className="py-1 text-xs text-fg-subtle italic"
            >
              Empty folder
            </div>
          ) : (
            browserChildren.map((child) => (
              <FileTreeItem
                key={child.entryId}
                entry={child}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                selectedEntryId={selectedEntryId}
                selectedEntryIds={selectedEntryIds}
                focusableEntryId={focusableEntryId}
                revealRequestId={revealRequestId}
                revealTargetPath={revealTargetPath}
                renamingPath={renamingPath}
                gitStatusMap={gitStatusMap}
                rootPath={rootPath}
                catalogEntriesByParent={catalogEntriesByParent}
                onToggle={onToggle}
                onSelect={onSelect}
                onOpen={onOpen}
                onKeyNavigate={onKeyNavigate}
                onContextMenu={onContextMenu}
                onRenameComplete={onRenameComplete}
                onRenameCancel={onRenameCancel}
                onDelete={onDelete}
                dragToMoveEnabled={dragToMoveEnabled}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
