import React, { useCallback, useRef, useEffect, useMemo, useState } from 'react';
import type { TabType } from '../types';
import type { TabStripPresentation } from '../tab-menu-presentation';
import { stripDisplayExtension } from '../../../utils/fileTypes';

const TAB_TYPES_SHOWING_RAW_LABEL: ReadonlySet<TabType> = new Set(['sequence', 'chat', 'record']);
import type { GitFileStatus } from '../../workspace/public/git';
import { useDragStore } from '../dragStore';
import { safeFocus } from '../../../shared/utils/safeFocus';
import { iconForEntityKind } from '../../../components/icons/entity-icon-registry';
import {
  AssemblyTabIcon,
  BiologyFileIcon,
  ChatTabIcon,
  GenericFileIcon,
  GenomeAssemblyIcon,
  ImageFileIcon,
  NotebookTabIcon,
  PdfFileIcon,
  ProteinIcon,
  SpreadsheetFileIcon,
  StructureFileIcon,
  TextFileIcon,
  WebFileIcon,
} from '../../../components/icons';

interface TabProps {
  tab: TabStripPresentation;
  panelId: string;
  index: number;
  isActive: boolean;
  isBeforeActive?: boolean;
  isAfterActive?: boolean;
  isEditing?: boolean;
  gitStatus?: GitFileStatus;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onContextMenu?: (tabId: string, position: { x: number; y: number }) => void;
  onStartRename?: (tabId: string) => void;
  onRename?: (tabId: string, newLabel: string) => void;
  onCancelRename?: () => void;
}

const INSERT_GAP_WIDTH = 80;

export function getTabIcon(tabType: TabType, className = 'w-3.5 h-3.5 flex-shrink-0') {
  const shared = iconForEntityKind(tabType, className);
  if (shared) return shared;

  switch (tabType) {
    case 'sequence':
      return <BiologyFileIcon className={className} />;
    case 'image':
      return <ImageFileIcon className={className} />;
    case 'pdf':
      return <PdfFileIcon className={className} />;
    case 'table':
      return <SpreadsheetFileIcon className={className} />;
    case 'html':
      return <WebFileIcon className={className} />;
    case 'text':
      return <TextFileIcon className={className} />;
    case 'terminal':
      return (
        <span className={className} aria-hidden="true">
          ›_
        </span>
      );
    case 'structure':
      return <StructureFileIcon className={className} />;
    case 'chat':
      return <ChatTabIcon className={className} />;
    case 'page':
      return <NotebookTabIcon className={className} />;
    case 'scientific-document':
      return <NotebookTabIcon className={className} />;
    case 'design':
    case 'assembly-panel':
    case 'adjacency-graph':
    case 'assembly-browser':
      return <AssemblyTabIcon className={className} />;
    case 'protein':
      return <ProteinIcon className={className} />;
    case 'primer':
    case 'record':
      return iconForEntityKind(tabType, className);
    case 'file':
      return <GenericFileIcon className={className} />;
    default: {
      const _exhaustive: never = tabType;
      void _exhaustive;
      return <GenericFileIcon className={className} />;
    }
  }
}

export function getTabIconForTab(
  tab: TabStripPresentation,
  className = 'w-3.5 h-3.5 flex-shrink-0'
) {
  if (tab.type === 'structure' && tab.isMolecularDocument)
    return iconForEntityKind('molecular-document', className);
  if (tab.type === 'sequence' && tab.isIndexedSequence) {
    return <GenomeAssemblyIcon className={className} />;
  }
  return getTabIcon(tab.type, className);
}

const DRAG_THRESHOLD = 5;

export const Tab = React.memo(function Tab({
  tab,
  panelId,
  index,
  isActive,
  isBeforeActive = false,
  isAfterActive = false,
  isEditing,
  onSelect,
  onClose,
  onContextMenu,
  onStartRename,
  onRename,
  onCancelRename,
  gitStatus,
}: TabProps) {
  const startDrag = useDragStore((s) => s.startDrag);
  const isDragging = useDragStore((s) => s.isDragging);
  const dragTabId = useDragStore((s) => s.dragTabId);
  const dropTargetPanelId = useDragStore((s) => s.dropTargetPanelId);
  const dropInsertIndex = useDragStore((s) => s.dropInsertIndex);

  const mouseDownRef = useRef<{ x: number; y: number } | null>(null);
  const dragStartedRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(tab.label);

  useEffect(() => {
    if (isEditing && safeFocus(inputRef.current)) {
      setEditValue(tab.label);
      inputRef.current!.select();
    }
  }, [isEditing, tab.label]);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== tab.label) {
      onRename?.(tab.id, trimmed);
    } else {
      onCancelRename?.();
    }
  }, [editValue, tab.label, tab.id, onRename, onCancelRename]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleRenameSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancelRename?.();
      }
    },
    [handleRenameSubmit, onCancelRename]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (tab.type === 'page' && onStartRename) {
        e.preventDefault();
        e.stopPropagation();
        onStartRename(tab.id);
        return;
      }
    },
    [tab.type, tab.id, onStartRename]
  );

  const showGapBefore = useMemo(() => {
    if (!isDragging || dropTargetPanelId !== panelId || dropInsertIndex === null) {
      return false;
    }
    return index === dropInsertIndex && dragTabId !== tab.id;
  }, [isDragging, dropTargetPanelId, panelId, dropInsertIndex, index, dragTabId, tab.id]);

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;

      if ((e.target as HTMLElement).closest('button')) return;

      mouseDownRef.current = { x: e.clientX, y: e.clientY };
      dragStartedRef.current = false;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!mouseDownRef.current || dragStartedRef.current) return;

        const dx = moveEvent.clientX - mouseDownRef.current.x;
        const dy = moveEvent.clientY - mouseDownRef.current.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance > DRAG_THRESHOLD) {
          dragStartedRef.current = true;
          startDrag(tab.id, panelId, tab.label, tab.type);
        }
      };

      const cleanup = () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        cleanupRef.current = null;
      };

      const handleMouseUp = () => {
        cleanup();

        if (!dragStartedRef.current && mouseDownRef.current) {
          onSelect(tab.id);
        }

        mouseDownRef.current = null;
      };

      cleanupRef.current = cleanup;

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [tab.id, tab.label, tab.type, panelId, startDrag, onSelect]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose(tab.id);
    },
    [onClose, tab.id]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu?.(tab.id, { x: e.clientX, y: e.clientY });
    },
    [onContextMenu, tab.id]
  );

  const isBeingDragged = isDragging && dragTabId === tab.id;

  if (isBeingDragged) {
    return (
      <div
        data-analytics-block
        role="tab"
        data-tab-id={tab.id}
        data-tab-index={index}
        style={{
          width: 0,
          padding: 0,
          overflow: 'hidden',
          opacity: 0,
          transition: 'width 150ms ease-out, opacity 150ms ease-out',
        }}
      />
    );
  }

  return (
    <div
      data-analytics-block
      role="tab"
      data-testid={`tab-${tab.id}`}
      data-tab-id={tab.id}
      data-tab-index={index}
      data-tab-label={tab.label}
      data-tab-type={tab.type}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      style={{
        marginLeft: showGapBefore ? `${INSERT_GAP_WIDTH}px` : undefined,
        transition: 'margin-left 150ms ease-out',
      }}
      className={`
        ph-no-capture tab-shell relative group flex items-center cursor-pointer text-sm
        select-none max-w-[240px] flex-1 basis-0 self-stretch
        ${
          isActive
            ? 'chrome-tab-active text-fg z-10 min-w-[6.5rem]'
            : 'text-fg-muted wp-interactive min-w-[3.5rem]'
        }
      `}
    >
      {!isActive && (
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-y-1 rounded-md bg-bg-subtle opacity-0 transition-opacity duration-fast group-hover:opacity-100 ${
            isBeforeActive ? 'left-1 right-2' : isAfterActive ? 'left-2 right-1' : 'inset-x-1'
          }`}
        />
      )}
      {!isActive && !isBeforeActive && (
        <span
          aria-hidden
          data-tab-divider
          className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 h-4 w-0.5 rounded-full bg-border-hover transition-opacity duration-150"
        />
      )}
      <div className="tab-inner relative z-[1] flex items-center gap-1.5 px-3 min-w-0 w-full">
        {getTabIconForTab(tab, 'tab-icon w-3.5 h-3.5 flex-shrink-0')}
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            className="flex-1 min-w-0 px-1 py-0 text-sm bg-bg-subtle border border-accent rounded focus:outline-none focus:ring-1 focus:ring-accent"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            data-testid={`tab-label-${tab.id}`}
            className={`tab-label flex-1 ${
              gitStatus === 'modified'
                ? 'text-yellow-600 dark:text-yellow-300'
                : gitStatus === 'untracked' || gitStatus === 'added'
                  ? 'text-green-600 dark:text-green-300'
                  : gitStatus === 'deleted'
                    ? 'text-red-600 dark:text-red-300'
                    : ''
            }`}
          >
            {TAB_TYPES_SHOWING_RAW_LABEL.has(tab.type)
              ? tab.label
              : stripDisplayExtension(tab.label)}
          </span>
        )}
        {!isEditing && (
          <span
            className={`tab-trailing relative flex-shrink-0 w-4 h-4 flex items-center justify-center${
              isActive ? ' tab-trailing-pinned' : ''
            }`}
          >
            {tab.isDirty && (
              <span
                data-testid={`tab-dirty-${tab.id}`}
                data-tab-dirty="true"
                role="img"
                aria-label="Unsaved changes"
                className="pointer-events-none absolute w-2 h-2 rounded-full bg-fg-muted transition-opacity duration-fast group-hover:opacity-0"
                title="Unsaved changes"
              />
            )}
            <button
              data-testid={`tab-close-${tab.id}`}
              onClick={handleClose}
              className={`
 flex items-center justify-center w-full h-full rounded wp-interactive
 transition-opacity duration-fast
 ${
   tab.isDirty
     ? 'opacity-0 group-hover:opacity-100'
     : isActive
       ? 'opacity-60 hover:opacity-100'
       : 'opacity-0 group-hover:opacity-60 hover:!opacity-100'
 }
              `}
              aria-label={`Close ${tab.label}`}
              title="Close tab"
            >
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </span>
        )}
      </div>
    </div>
  );
});
