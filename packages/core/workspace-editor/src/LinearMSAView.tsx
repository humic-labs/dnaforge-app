import React, { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { SEQUENCE_FONT_FAMILY } from '@waypoint/platform';
import type { MSATrackData, RefCoordBase, InsertionMarker } from './msa-utils';
import { CHANGE_COLORS } from './types';

export interface LinearMSAViewProps {
  referenceSequence: string;
  tracks: MSATrackData[];
  cellWidth?: number;
  rowHeight?: number;
  maxHeight?: number;
  showRuler?: boolean;
  onPositionClick?: (refPos: number) => void;
  className?: string;
  style?: React.CSSProperties;
}

const LABEL_WIDTH = 140;
const COLUMN_BUFFER = 50;

const STATUS_COLORS: Record<string, string> = {
  incomplete: '#94a3b8',
  pass: '#22c55e',
  variants: '#f59e0b',
  fail: '#ef4444',
};

const MUTATION_BG: Record<string, string> = {
  substitution: CHANGE_COLORS.substitution.bg,
  insertion: CHANGE_COLORS.insertion.bg,
  deletion: CHANGE_COLORS.deletion.bg,
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildWindowedRowHtml(
  bases: RefCoordBase[],
  insertions: InsertionMarker[] | undefined,
  startCol: number,
  endCol: number,
  cellWidth: number,
  rowHeight: number,
  isReference: boolean
): string {
  const safeStart = Math.max(0, startCol);
  const safeEnd = Math.min(bases.length, endCol);
  if (safeStart >= safeEnd) return '';

  const offsetX = safeStart * cellWidth;

  let insertionMap: Map<number, string> | null = null;
  if (insertions && insertions.length > 0) {
    insertionMap = new Map();
    for (const ins of insertions) {
      if (ins.afterRefPos >= safeStart && ins.afterRefPos < safeEnd) {
        insertionMap.set(ins.afterRefPos, ins.bases);
      }
    }
  }

  const parts: string[] = [];
  parts.push(
    `<div style="position:absolute;left:${offsetX}px;display:flex;height:${rowHeight}px;line-height:${rowHeight}px">`
  );

  for (let i = safeStart; i < safeEnd; i++) {
    const b = bases[i];
    const bgColor = !isReference && b.mutation ? MUTATION_BG[b.mutation] : '';
    const textColor = !isReference && b.mutation && b.mutation !== 'substitution' ? '#fff' : '';
    const hasInsertion = !isReference && insertionMap?.has(i);

    let style = `width:${cellWidth}px;text-align:center;flex-shrink:0`;
    if (bgColor) style += `;background:${bgColor};border-radius:1px;font-weight:600`;
    if (textColor) style += `;color:${textColor}`;
    if (hasInsertion) style += `;position:relative`;

    parts.push(`<span style="${style}">${escapeHtml(b.base)}`);

    if (hasInsertion) {
      const insBase = insertionMap?.get(i) ?? '';
      parts.push(
        `<span style="position:absolute;top:-3px;right:-2px;width:6px;height:6px;border-radius:50%;background:${CHANGE_COLORS.insertion.accent};border:1px solid rgba(0,0,0,0.2)" title="Insertion: ${escapeHtml(insBase)}"></span>`
      );
    }

    parts.push('</span>');
  }

  parts.push('</div>');
  return parts.join('');
}

function buildWindowedRulerHtml(
  length: number,
  startCol: number,
  endCol: number,
  cellWidth: number
): string {
  const safeStart = Math.max(0, startCol);
  const safeEnd = Math.min(length, endCol);
  const parts: string[] = [];
  const firstTick = Math.floor(safeStart / 10) * 10;
  for (let i = firstTick; i < safeEnd; i += 10) {
    parts.push(
      `<span style="position:absolute;left:${i * cellWidth}px;width:${cellWidth * 10}px;text-align:left;padding-left:2px">${i + 1}</span>`
    );
  }
  return parts.join('');
}

export const LinearMSAView = React.memo(function LinearMSAView({
  referenceSequence,
  tracks,
  cellWidth = 11,
  rowHeight = 20,
  maxHeight = 300,
  showRuler = true,
  onPositionClick,
  className,
  style,
}: LinearMSAViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [hoveredPos, setHoveredPos] = useState<number | null>(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 200 });

  const refLength = referenceSequence?.length ?? 0;
  const totalWidth = refLength * cellWidth;

  const refBases = useMemo((): RefCoordBase[] => {
    if (!referenceSequence) return [];
    return Array.from(referenceSequence).map((base) => ({
      base,
      refBase: base,
      mutation: null,
    }));
  }, [referenceSequence]);

  const rulerHtml = useMemo(() => {
    if (!showRuler || refLength === 0) return '';
    return buildWindowedRulerHtml(refLength, visibleRange.start, visibleRange.end, cellWidth);
  }, [showRuler, refLength, visibleRange.start, visibleRange.end, cellWidth]);

  const refWindowHtml = useMemo(() => {
    if (refBases.length === 0) return '';
    return buildWindowedRowHtml(
      refBases,
      undefined,
      visibleRange.start,
      visibleRange.end,
      cellWidth,
      rowHeight,
      true
    );
  }, [refBases, visibleRange.start, visibleRange.end, cellWidth, rowHeight]);

  const trackWindowHtmls = useMemo(() => {
    return tracks.map((track) =>
      buildWindowedRowHtml(
        track.alignment.bases,
        track.alignment.insertions,
        visibleRange.start,
        visibleRange.end,
        cellWidth,
        rowHeight,
        false
      )
    );
  }, [tracks, visibleRange.start, visibleRange.end, cellWidth, rowHeight]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const scrollLeft = el.scrollLeft;
      const containerWidth = el.clientWidth;

      const newStart = Math.max(0, Math.floor(scrollLeft / cellWidth) - COLUMN_BUFFER);
      const newEnd = Math.min(
        refLength,
        Math.ceil((scrollLeft + containerWidth) / cellWidth) + COLUMN_BUFFER
      );

      setVisibleRange((prev) => {
        if (prev.start === newStart && prev.end === newEnd) return prev;
        return { start: newStart, end: newEnd };
      });
    },
    [cellWidth, refLength]
  );

  const handleGridClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!onPositionClick || !scrollContainerRef.current) return;
      const rect = scrollContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
      const pos = Math.floor(x / cellWidth);
      if (pos >= 0 && pos < refLength) {
        onPositionClick(pos);
      }
    },
    [onPositionClick, cellWidth, refLength]
  );

  const handleGridMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!scrollContainerRef.current) return;
      const rect = scrollContainerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + scrollContainerRef.current.scrollLeft;
      const pos = Math.floor(x / cellWidth);
      if (pos >= 0 && pos < refLength) {
        setHoveredPos(pos);
      } else {
        setHoveredPos(null);
      }
    },
    [cellWidth, refLength]
  );

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || refLength === 0) return;
    const containerWidth = el.clientWidth;
    const newEnd = Math.min(refLength, Math.ceil(containerWidth / cellWidth) + COLUMN_BUFFER);
    setVisibleRange((prev) => {
      if (prev.start === 0 && prev.end === newEnd) return prev;
      return { start: 0, end: newEnd };
    });
  }, [cellWidth, refLength]);

  if (!referenceSequence || refLength === 0) {
    return null;
  }

  if (tracks.length === 0) {
    return (
      <div
        className={className}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-fg-muted, #888)',
          padding: 16,
          fontSize: 13,
          ...style,
        }}
      >
        No alignment tracks to display
      </div>
    );
  }

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        fontFamily: SEQUENCE_FONT_FAMILY,
        fontSize: 11,
        overflow: 'hidden',
        maxHeight,
        border: '1px solid var(--color-border, #333)',
        borderRadius: 4,
        backgroundColor: 'var(--color-bg, #1a1a1a)',
        ...style,
      }}
    >
      {}
      <div
        style={{
          flexShrink: 0,
          width: LABEL_WIDTH,
          borderRight: '1px solid var(--color-border, #333)',
          backgroundColor: 'var(--color-bg-secondary, #222)',
          zIndex: 2,
          overflowY: 'hidden',
        }}
      >
        {showRuler && (
          <div
            style={{
              height: rowHeight - 4,
              lineHeight: `${rowHeight - 4}px`,
              padding: '0 8px',
              fontSize: 9,
              color: 'var(--color-fg-muted, #888)',
              borderBottom: '1px solid var(--color-border, #333)',
            }}
          >
            Position
          </div>
        )}

        <div
          style={{
            height: rowHeight,
            lineHeight: `${rowHeight}px`,
            padding: '0 8px',
            fontWeight: 600,
            color: 'var(--color-fg, #eee)',
            borderBottom: '1px solid var(--color-border-subtle, #2a2a2a)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          Reference
        </div>

        {tracks.map((track) => (
          <div
            key={track.id}
            style={{
              height: rowHeight,
              lineHeight: `${rowHeight}px`,
              padding: '0 8px',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderBottom: '1px solid var(--color-border-subtle, #2a2a2a)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: STATUS_COLORS[track.status] ?? '#888',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                color: 'var(--color-fg-secondary, #bbb)',
                fontSize: 10,
              }}
              title={`${track.label} (${(track.identity ?? 0).toFixed(1)}%)`}
            >
              {track.label}
            </span>
          </div>
        ))}
      </div>

      {}
      <div
        ref={scrollContainerRef}
        style={{
          flex: 1,
          overflowX: 'auto',
          overflowY: 'auto',
          cursor: onPositionClick ? 'pointer' : 'default',
        }}
        onScroll={handleScroll}
        onClick={handleGridClick}
        onMouseMove={handleGridMouseMove}
        onMouseLeave={() => setHoveredPos(null)}
      >
        {}
        {showRuler && (
          <div
            style={{
              position: 'relative',
              height: rowHeight - 4,
              width: totalWidth,
              lineHeight: `${rowHeight - 4}px`,
              fontSize: '9px',
              color: 'var(--color-fg-muted, #888)',
              borderBottom: '1px solid var(--color-border, #333)',
            }}
            dangerouslySetInnerHTML={{ __html: rulerHtml }}
          />
        )}

        {}
        {hoveredPos !== null && (
          <div
            style={{
              position: 'absolute',
              left: hoveredPos * cellWidth,
              top: 0,
              width: cellWidth,
              height: '100%',
              backgroundColor: 'rgba(255,255,255,0.05)',
              pointerEvents: 'none',
              zIndex: 1,
            }}
          />
        )}

        {}
        <div
          style={{
            position: 'relative',
            height: rowHeight,
            width: totalWidth,
            borderBottom: '1px solid var(--color-border-subtle, #2a2a2a)',
          }}
          dangerouslySetInnerHTML={{ __html: refWindowHtml }}
        />

        {}
        {tracks.map((track, idx) => (
          <div
            key={track.id}
            style={{
              position: 'relative',
              height: rowHeight,
              width: totalWidth,
              borderBottom: '1px solid var(--color-border-subtle, #2a2a2a)',
            }}
            dangerouslySetInnerHTML={{ __html: trackWindowHtmls[idx] }}
          />
        ))}
      </div>
    </div>
  );
});
