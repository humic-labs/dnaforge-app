import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import type { Annotation } from '@waypoint/sequence-utils';
import { formatPosition } from '../format-position';
import { scrollOffsetForRow } from '../scroll-into-view';
import { safeFocus } from '../../../../shared/utils/safeFocus';
import { ANNOTATION_GRID, annotationVisibilityKey, type AnnotationSavePayload } from './helpers';
import { DirectionIndicator } from './annotation-fields';
import { AnnotationEditForm } from './AnnotationEditForm';

const ROW_HEIGHT = 24;
const OVERSCAN = 5;

interface VirtualAnnotationListProps {
  items: Array<{ ann: Annotation; originalIndex: number }>;
  emptyMessage: string;
  selectedIndex: number | null;
  expandedIndex: number | null;
  scrollToOriginalIndex?: number | null;
  onScrollHandled?: () => void;
  annotations: Annotation[];
  circular?: boolean;
  sequenceLength?: number;
  hiddenKeys: Set<string>;
  onToggleVisibility: (ann: Annotation) => void;
  onRowClick: (index: number, ann: Annotation) => void;
  onRowSelect: (index: number, ann: Annotation) => void;
  onRowDoubleClick: (index: number) => void;
  onEditClick: (e: React.MouseEvent, index: number) => void;
  onSave: (index: number, data: AnnotationSavePayload) => void;
  onDelete: (index: number) => void;
  onCancelEdit: () => void;
}

export function VirtualAnnotationList({
  items,
  emptyMessage,
  selectedIndex,
  expandedIndex,
  scrollToOriginalIndex,
  onScrollHandled,
  annotations,
  circular,
  sequenceLength,
  hiddenKeys,
  onToggleVisibility,
  onRowClick,
  onRowSelect,
  onRowDoubleClick,
  onEditClick,
  onSave,
  onDelete,
  onCancelEdit,
}: VirtualAnnotationListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const lastHeightRef = useRef(0);
  const [editFormHeight, setEditFormHeight] = useState(220);

  useLayoutEffect(() => {
    if (scrollToOriginalIndex == null) return;
    const el = containerRef.current;
    if (!el) {
      onScrollHandled?.();
      return;
    }
    if (el.clientHeight <= 0) return;
    const pos = items.findIndex((it) => it.originalIndex === scrollToOriginalIndex);
    if (pos >= 0) {
      const next = scrollOffsetForRow({
        rowTop: pos * ROW_HEIGHT,
        rowHeight: ROW_HEIGHT,
        viewportHeight: el.clientHeight,
        scrollTop: el.scrollTop,
        margin: ROW_HEIGHT * 2,
      });
      if (next != null) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    }
    onScrollHandled?.();
  }, [scrollToOriginalIndex, viewportHeight, items, onScrollHandled]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height ?? 0;
      if (Math.abs(h - lastHeightRef.current) > 1) {
        lastHeightRef.current = h;
        setViewportHeight(h);
      }
    });
    ro.observe(el);
    lastHeightRef.current = el.clientHeight;
    setViewportHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop((e.target as HTMLDivElement).scrollTop);
  }, []);

  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) return;
      e.preventDefault();
      const pos = items.findIndex((it) => it.originalIndex === selectedIndex);
      if (e.key === 'Escape') {
        onCancelEdit();
        return;
      }
      if (e.key === 'Enter') {
        const cur = pos >= 0 ? items[pos] : null;
        if (cur) onRowClick(cur.originalIndex, cur.ann);
        return;
      }
      const nextPos =
        pos < 0
          ? e.key === 'ArrowDown'
            ? 0
            : items.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(items.length - 1, pos + 1)
            : Math.max(0, pos - 1);
      const next = items[nextPos];
      if (next) onRowSelect(next.originalIndex, next.ann);
    },
    [items, selectedIndex, onRowSelect, onRowClick, onCancelEdit]
  );

  const getRowHeight = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item) return ROW_HEIGHT;
      return item.originalIndex === expandedIndex ? ROW_HEIGHT + editFormHeight : ROW_HEIGHT;
    },
    [items, expandedIndex, editFormHeight]
  );

  const { totalHeight, startIndex, endIndex, offsets } = useMemo(() => {
    const offs: number[] = [];
    let h = 0;
    for (let i = 0; i < items.length; i++) {
      offs.push(h);
      h += getRowHeight(i);
    }

    let start = 0;
    let end = items.length;

    let lo = 0,
      hi = items.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (offs[mid] + getRowHeight(mid) < scrollTop) lo = mid + 1;
      else hi = mid - 1;
    }
    start = Math.max(0, lo - OVERSCAN);

    const bottom = scrollTop + viewportHeight;
    let idx = lo;
    while (idx < items.length && offs[idx] < bottom) idx++;
    end = Math.min(items.length, idx + OVERSCAN);

    return { totalHeight: h, startIndex: start, endIndex: end, offsets: offs };
  }, [items, scrollTop, viewportHeight, getRowHeight]);

  if (items.length === 0) {
    return (
      <div ref={containerRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        <div className="text-xs text-fg-muted py-8 text-center">{emptyMessage}</div>
      </div>
    );
  }

  const visibleItems = items.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      data-testid="annotation-list-scroll"
      className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 focus:outline-none"
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={handleListKeyDown}
      onMouseDown={() => safeFocus(containerRef.current)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        {visibleItems.map((item, i) => {
          const actualIndex = startIndex + i;
          const { ann, originalIndex } = item;
          const isSelected = selectedIndex === originalIndex;
          const isExpanded = expandedIndex === originalIndex;
          return (
            <div
              key={`${ann.name}-${ann.start}-${originalIndex}`}
              style={{
                position: 'absolute',
                top: offsets[actualIndex],
                left: 0,
                right: 0,
                height: getRowHeight(actualIndex),
              }}
            >
              <div
                role="row"
                data-testid={`annotation-row-${originalIndex}`}
                onClick={() => onRowClick(originalIndex, ann)}
                onDoubleClick={() => onRowDoubleClick(originalIndex)}
                className={`group grid items-center px-1 py-0.5 text-xs cursor-pointer select-none ${
                  isExpanded || isSelected ? 'bg-green-500/15' : 'wp-interactive'
                }`}
                style={{ gridTemplateColumns: ANNOTATION_GRID, height: ROW_HEIGHT }}
              >
                <span className="flex items-center justify-center">
                  <DirectionIndicator direction={ann.direction} color={ann.color || '#718096'} />
                </span>
                <span className="px-1 truncate text-fg">{ann.name}</span>
                <span className="px-1 text-fg-muted truncate">{ann.type}</span>
                {}
                <span
                  className="relative px-1 text-fg-muted tabular-nums font-mono text-[10px] truncate"
                  title={`${ann.start}-${ann.end}`}
                >
                  <span
                    className={`block truncate ${
                      isExpanded || isSelected ? 'pr-3.5' : 'pr-0 group-hover:pr-3.5'
                    }`}
                  >
                    {(() => {
                      const pos = formatPosition(ann.start, ann.end, ann.direction ?? 0);
                      return pos.delta ? `${pos.origin} ${pos.delta}` : pos.origin;
                    })()}
                  </span>
                  <span
                    data-testid={`edit-icon-${originalIndex}`}
                    onClick={(e) => onEditClick(e, originalIndex)}
                    role="button"
                    aria-label={
                      isExpanded ? 'Collapse annotation editor' : 'Expand annotation editor'
                    }
                    title={isExpanded ? 'Collapse' : 'Expand'}
                    className={`absolute -right-0.5 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded wp-interactive cursor-pointer ${
                      isExpanded
                        ? 'text-accent opacity-100'
                        : isSelected
                          ? 'text-fg-muted opacity-100'
                          : 'text-fg-muted opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
                    >
                      <path d="M4 6l4 4 4-4" />
                    </svg>
                  </span>
                </span>
                <span
                  className="flex items-center justify-center"
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    data-testid={`annotation-visible-${originalIndex}`}
                    checked={!hiddenKeys.has(annotationVisibilityKey(ann))}
                    onChange={() => onToggleVisibility(ann)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={
                      hiddenKeys.has(annotationVisibilityKey(ann))
                        ? 'Show this annotation in the viewer'
                        : 'Hide this annotation in the viewer (does not delete it)'
                    }
                    aria-label={`Toggle visibility of ${ann.name}`}
                    className="w-3 h-3 cursor-pointer accent-gray-300 dark:accent-gray-600"
                  />
                </span>
              </div>
              {isExpanded && (
                <AnnotationEditForm
                  annotation={ann}
                  allAnnotations={annotations}
                  circular={circular}
                  sequenceLength={sequenceLength}
                  onSave={(data) => onSave(originalIndex, data)}
                  onDelete={() => onDelete(originalIndex)}
                  onCancel={onCancelEdit}
                  onHeightChange={setEditFormHeight}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
