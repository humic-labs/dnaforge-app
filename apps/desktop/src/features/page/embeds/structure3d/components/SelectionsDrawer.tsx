import { usePresentationListener } from '../../../../../presentation/PresentationSurface';
('use client');

import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useState, useRef, type RefObject } from 'react';
import type { HighlightGroup } from '../types';
import { safeFocus } from '../../../../../shared/utils/safeFocus';
import { resolveHighlightGroupColor } from '../utils/highlightUtils';
import { useOverflowYWhenNeeded } from '../hooks/useOverflowYWhenNeeded';

interface SelectionsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  highlightGroups: HighlightGroup[];
  loadErrors?: ReadonlyArray<string>;
  onActivate: (groupId: string) => void;
  onRename: (groupId: string, newLabel: string) => void | Promise<void>;
  onDelete: (groupId: string) => void;
  triggerRef: RefObject<HTMLDivElement | null>;
  layout?: 'bar' | 'sidebar';
}

export function SelectionsDrawer({
  isOpen,
  onClose,
  highlightGroups,
  loadErrors,
  onActivate,
  onRename,
  onDelete,
  triggerRef,
  layout = 'bar',
}: SelectionsDrawerProps) {
  const presentationEvents = usePresentationListener();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerOverflowsY = useOverflowYWhenNeeded(
    drawerRef,
    `${layout}:${highlightGroups.length}:${loadErrors?.length ?? 0}:${editingId ?? ''}`
  );

  useEffect(() => {
    const input = inputRef.current;
    if (editingId && input && safeFocus(input)) {
      input.select();
    }
  }, [editingId]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedInTrigger = triggerRef.current?.contains(target);
      const clickedInDrawer = drawerRef.current?.contains(target);

      if (!clickedInTrigger && !clickedInDrawer) {
        onClose();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
      queueMicrotask(() =>
        safeFocus(triggerRef.current?.querySelector<HTMLButtonElement>('button'))
      );
    };
    presentationEvents.add(document, 'keydown', handleEscape);

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      presentationEvents.remove(document, 'keydown', handleEscape);
    };
  }, [isOpen, onClose, triggerRef, presentationEvents]);

  useEffect(() => {
    if (!isOpen) {
      setEditingId(null);
      setEditLabel('');
    }
  }, [isOpen]);

  const handleStartEdit = (group: HighlightGroup) => {
    setEditingId(group.id);
    setEditLabel(group.label);
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editLabel.trim() || isRenaming) return;
    setIsRenaming(true);
    setEditError(null);
    try {
      await onRename(editingId, editLabel.trim());
      setEditingId(null);
      setEditLabel('');
    } catch (error) {
      setEditError(toUserMessage(error, 'structure.failed'));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditLabel('');
    setEditError(null);
  };

  const handleRowClick = (groupId: string, e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (editingId === groupId) return;
    onActivate(groupId);
  };

  const positionClasses =
    layout === 'sidebar'
      ? 'absolute top-0 right-full mr-1 w-56 max-h-64 rounded-md border'
      : 'absolute bottom-full right-0 w-64 max-h-48 rounded-t-md border-x border-t';

  const animationClasses =
    layout === 'sidebar'
      ? isOpen
        ? 'opacity-100 translate-x-0'
        : 'opacity-0 translate-x-2 pointer-events-none'
      : isOpen
        ? 'opacity-100 translate-y-0'
        : 'opacity-0 translate-y-2 pointer-events-none';

  return (
    <div
      ref={drawerRef}
      data-testid="saved-selections-drawer"
      data-overflow-y={drawerOverflowsY ? 'auto' : 'none'}
      className={`${positionClasses} ${
        drawerOverflowsY ? 'overflow-y-auto' : 'overflow-y-clip'
      } bg-bg border-border z-20 transition-all duration-200 ease-out shadow-lg ${animationClasses}`}
    >
      <div className="p-2">
        <div className="text-xs font-medium text-fg-muted mb-2">
          Saved Selections ({highlightGroups.length})
        </div>
        {!!loadErrors?.length && (
          <div
            data-testid="saved-selection-load-errors"
            role="alert"
            className="mb-2 rounded border border-red-500/40 bg-red-500/10 p-1.5 text-[10px] text-red-500"
          >
            {loadErrors.map((error) => (
              <div key={error}>{toUserMessage(error, 'structure.failed')}</div>
            ))}
          </div>
        )}
        {highlightGroups.length === 0 ? (
          <div className="text-xs text-fg-subtle py-2 text-center">No saved selections</div>
        ) : (
          <div className="flex flex-col gap-1">
            {highlightGroups.map((group) => {
              const isEditing = editingId === group.id;
              const groupColor = resolveHighlightGroupColor(group);

              return (
                <div
                  key={group.id}
                  onClick={(e) => handleRowClick(group.id, e)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs border transition-all cursor-pointer ${
                    isEditing ? '' : 'hover:bg-bg-subtle'
                  }`}
                  style={{
                    borderColor: groupColor,
                    backgroundColor: `${groupColor}15`,
                  }}
                  title={isEditing ? '' : 'Restore as active selection'}
                  data-testid={`highlight-group-${group.id}`}
                  data-action="restore-selection"
                >
                  {}
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: groupColor }}
                  />

                  {}
                  <div className="flex-1 min-w-0">
                    {isEditing ? (
                      <>
                        <div className="flex items-center gap-1">
                          <input
                            ref={inputRef}
                            type="text"
                            value={editLabel}
                            onChange={(e) => setEditLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                void handleSaveEdit();
                              }
                              if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                handleCancelEdit();
                              }
                            }}
                            onBlur={() => void handleSaveEdit()}
                            disabled={isRenaming}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 min-w-0 px-1 py-0.5 text-xs bg-bg border border-border rounded focus:outline-none focus:ring-1 focus:ring-accent"
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancelEdit();
                            }}
                            className="p-0.5 text-fg-muted hover:text-fg transition-colors shrink-0"
                            title="Cancel"
                            disabled={isRenaming}
                          >
                            <svg
                              className="w-3 h-3"
                              fill="none"
                              stroke="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M6 18L18 6M6 6l12 12"
                              />
                            </svg>
                          </button>
                        </div>
                        {editError && (
                          <div role="alert" className="mt-1 text-[10px] text-red-500">
                            {toUserMessage(editError, 'structure.failed')}
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Restore ${group.label}`}
                          onClick={() => onActivate(group.id)}
                          className="block w-full rounded text-left text-fg truncate select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                        >
                          {group.label}
                        </button>
                        <div className="text-[10px] text-fg-subtle truncate">
                          {group.selections
                            .map(
                              (sel) =>
                                `${sel.chain}:${sel.ranges
                                  .map(([s, e]) => (s === e ? String(s) : `${s}-${e}`))
                                  .join(',')}`
                            )
                            .join(' ')}
                        </div>
                      </>
                    )}
                  </div>

                  {}
                  {!isEditing && (
                    <div className="flex items-center shrink-0">
                      {}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartEdit(group);
                        }}
                        className="p-1 text-fg-muted hover:text-fg transition-colors"
                        title="Rename"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                          />
                        </svg>
                      </button>
                      {}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(group.id);
                        }}
                        className="p-1 text-fg-muted hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
