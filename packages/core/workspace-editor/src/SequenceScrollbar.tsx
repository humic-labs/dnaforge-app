import React, {
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
  useMemo,
  useLayoutEffect,
  useId,
} from 'react';
import type {
  Annotation,
  AnnotationColorMode,
  ColoredCutSite,
  SearchMatch,
} from '@waypoint/sequence-utils';
import { MAX_CUT_SITES_ON_OVERVIEW, resolveAnnotationDisplayColor } from '@waypoint/sequence-utils';
import type { Selection, LayoutSnapshot2D, ViewportRange } from './types';
import { getScrollYForSequencePosition } from './layout-utils';
import {
  SequenceScrollbarAnnotationCanvas,
  type SequenceScrollbarAnnotationMarker,
} from './SequenceScrollbarAnnotationCanvas';

export interface SequenceScrollbarHandle {
  setViewport: (scrollTop: number, viewportHeight: number, totalHeight: number) => void;
  setViewportPositions: (range: ViewportRange) => void;
}

export interface SequenceScrollbarProps {
  layout: LayoutSnapshot2D;
  sequenceLength: number;
  annotations: Annotation[];
  annotationColorMode?: AnnotationColorMode;
  cutSites?: ColoredCutSite[];
  scannedCutSites?: ColoredCutSite[];
  selection?: Selection | null;
  searchMatches?: SearchMatch[];
  activeSearchIndex?: number;
  viewportScrollTop?: number;
  viewportHeight?: number;
  reservedHeight?: number;
  totalHeight?: number;
  onNavigate?: (scrollTop: number) => void;
  onNavigationStart?: () => void;
  width?: number;
  translationMode?: never;
}

const SequenceScrollbarInner = forwardRef<SequenceScrollbarHandle, SequenceScrollbarProps>(
  (
    {
      layout,
      sequenceLength,
      annotations,
      annotationColorMode,
      cutSites = [],
      scannedCutSites = [],
      selection,
      searchMatches = [],
      activeSearchIndex = 0,
      viewportScrollTop = 0,
      viewportHeight = 0,
      totalHeight: propTotalHeight,
      onNavigate,
      onNavigationStart,
      translationMode: _translationMode,
      width = 24,
      reservedHeight,
    },
    ref
  ) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const viewportRectRef = useRef<SVGRectElement>(null);
    const viewportRectWrapRef = useRef<SVGRectElement>(null);
    const clipId = useId();
    const [isDragging, setIsDragging] = useState(false);
    const [dragStartY, setDragStartY] = useState(0);
    const [dragStartPosition, setDragStartPosition] = useState(0);
    const [hasDragged, setHasDragged] = useState(false);
    const [hoveredAnnotationName, setHoveredAnnotationName] = useState<string | null>(null);

    const totalHeight = propTotalHeight || layout.totalHeight;

    const viewportStateRef = useRef({
      scrollTop: viewportScrollTop,
      height: viewportHeight,
      total: totalHeight,
    });

    const onNavigateRef = useRef(onNavigate);
    React.useEffect(() => {
      onNavigateRef.current = onNavigate;
    }, [onNavigate]);

    React.useEffect(() => {
      viewportStateRef.current = {
        scrollTop: viewportScrollTop,
        height: viewportHeight,
        total: totalHeight,
      };
    }, [viewportScrollTop, viewportHeight, totalHeight]);

    const viewportPositionsRef = useRef({ startPos: 0, endPos: 0 });

    useImperativeHandle(
      ref,
      () => ({
        setViewport: (scrollTop: number, height: number, total: number) => {
          viewportStateRef.current = { scrollTop, height, total };
        },
        setViewportPositions: (range: ViewportRange) => {
          const startPos = range.start;
          const endPos = range.end;
          viewportPositionsRef.current = { startPos, endPos };

          const seqLen = sequenceLength;
          if (seqLen === 0) return;

          const isCircular = layout.isCircular;

          let viewportSize: number;
          if (range.wraps) {
            viewportSize = seqLen - startPos + endPos;
          } else {
            viewportSize = Math.max(0, endPos - startPos);
          }

          const startPercent = (startPos / seqLen) * 100;
          const heightPercent = Math.max(2, (viewportSize / seqLen) * 100);

          if (viewportRectRef.current) {
            viewportRectRef.current.setAttribute('y', `${startPercent}%`);
            viewportRectRef.current.setAttribute('height', `${heightPercent}%`);
          }

          if (isCircular && viewportRectWrapRef.current) {
            const mainEndPercent = startPercent + heightPercent;
            if (mainEndPercent > 100) {
              const overflowPercent = mainEndPercent - 100;
              viewportRectWrapRef.current.setAttribute('y', '0%');
              viewportRectWrapRef.current.setAttribute('height', `${overflowPercent}%`);
              viewportRectWrapRef.current.setAttribute('opacity', '1');
            } else {
              viewportRectWrapRef.current.setAttribute('opacity', '0');
            }
          } else if (viewportRectWrapRef.current) {
            viewportRectWrapRef.current.setAttribute('opacity', '0');
          }
        },
      }),
      [sequenceLength, layout.isCircular]
    );

    const containerDivRef = useRef<HTMLDivElement>(null);
    const [actualMinimapHeight, setActualMinimapHeight] = useState(viewportHeight || 400);

    React.useEffect(() => {
      if (!containerDivRef.current) return;

      const resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const height = entry.contentRect.height;
          if (height > 0) {
            setActualMinimapHeight(height);
          }
        }
      });

      resizeObserver.observe(containerDivRef.current);
      return () => resizeObserver.disconnect();
    }, []);

    const minimapHeight = actualMinimapHeight;

    const annotationMarkers = useMemo<SequenceScrollbarAnnotationMarker[]>(() => {
      if (!annotations.length || sequenceLength === 0) return [];

      const LINE_HEIGHT = 2;
      const LANE_GAP = 1;

      const cdsAnnotations = annotations.filter((a) => a.type === 'CDS');
      const otherAnnotations = annotations.filter((a) => a.type !== 'CDS');

      const cdsFrameGroups: Annotation[][] = [];
      for (const cds of cdsAnnotations) {
        cdsFrameGroups.push([cds]);
      }

      const sorted = [...otherAnnotations].sort((a, b) => a.start - b.start);

      const laneEnds: number[] = [];
      const annotationsWithLanes: Array<{ annotation: Annotation; lane: number }> = [];

      for (const ann of sorted) {
        let lane = 0;
        for (let i = 0; i < laneEnds.length; i++) {
          if (laneEnds[i] <= ann.start) {
            lane = i;
            break;
          }
          lane = i + 1;
        }
        while (laneEnds.length <= lane) {
          laneEnds.push(0);
        }
        laneEnds[lane] = ann.end;
        annotationsWithLanes.push({ annotation: ann, lane });
      }

      for (const group of cdsFrameGroups) {
        const unionStart = Math.min(...group.map((c) => c.start));
        const unionEnd = Math.max(...group.map((c) => c.end));

        let lane = 0;
        for (let i = 0; i < laneEnds.length; i++) {
          if (laneEnds[i] <= unionStart) {
            lane = i;
            break;
          }
          lane = i + 1;
        }
        while (laneEnds.length <= lane) {
          laneEnds.push(0);
        }
        laneEnds[lane] = unionEnd;

        for (const cds of group) {
          annotationsWithLanes.push({ annotation: cds, lane });
        }
      }

      const totalLanes = laneEnds.length;
      const totalLaneWidth = totalLanes * LINE_HEIGHT + (totalLanes - 1) * LANE_GAP;
      const startX = (width - totalLaneWidth) / 2;

      return annotationsWithLanes.map(({ annotation: ann, lane }) => {
        const startY = ((ann.start - 1) / sequenceLength) * minimapHeight;
        const endY = (ann.end / sequenceLength) * minimapHeight;
        const height = Math.max(1, endY - startY);

        const x = startX + lane * (LINE_HEIGHT + LANE_GAP);

        return {
          name: ann.name,
          y: startY,
          height,
          x,
          width: LINE_HEIGHT,
          color: resolveAnnotationDisplayColor(ann, {
            profile: { colorMode: annotationColorMode },
          }),
        };
      });
    }, [annotationColorMode, annotations, sequenceLength, minimapHeight, width]);

    const cutSiteMarkers = useMemo(() => {
      if (!cutSites.length || sequenceLength === 0) return [];
      if (cutSites.length > MAX_CUT_SITES_ON_OVERVIEW) return [];

      return cutSites.map((site) => {
        const y = (site.cutPositionTop / sequenceLength) * minimapHeight;

        return {
          site,
          y,
          color: site.color,
        };
      });
    }, [cutSites, sequenceLength, minimapHeight]);

    const scannedCutSiteMarkers = useMemo(() => {
      if (!scannedCutSites.length || sequenceLength === 0) return [];

      return scannedCutSites.map((site) => {
        const y = (site.cutPositionTop / sequenceLength) * minimapHeight;

        return {
          site,
          y,
          color: site.color,
        };
      });
    }, [scannedCutSites, sequenceLength, minimapHeight]);

    const selectionMarkers = useMemo(() => {
      if (!selection || sequenceLength === 0) return null;

      const positionToMarker = (startPos: number, endPos: number) => {
        const startY = (startPos / sequenceLength) * minimapHeight;
        const endY = ((endPos + 1) / sequenceLength) * minimapHeight;
        const height = Math.max(2, endY - startY);
        return { y: startY, height };
      };

      if (selection.wraps) {
        const marker1 = positionToMarker(selection.start, sequenceLength - 1);
        const marker2 = positionToMarker(0, selection.end);
        return [marker1, marker2];
      }

      const startPos = Math.min(selection.start, selection.end);
      const endPos = Math.max(selection.start, selection.end);
      return [positionToMarker(startPos, endPos)];
    }, [selection, sequenceLength, minimapHeight]);

    const searchMatchMarkers = useMemo(() => {
      if (!searchMatches.length || sequenceLength === 0) return [];

      return searchMatches.map((match, idx) => {
        const startY = (match.start / sequenceLength) * minimapHeight;
        const endY = ((match.end + 1) / sequenceLength) * minimapHeight;
        const height = Math.max(2, endY - startY);
        const isActive = idx === activeSearchIndex;
        return { y: startY, height, isActive };
      });
    }, [searchMatches, activeSearchIndex, sequenceLength, minimapHeight]);

    const navigateToPosition = useCallback(
      (position: number, center: boolean) => {
        if (sequenceLength <= 0) return;
        const target = layout.isCircular
          ? ((position % sequenceLength) + sequenceLength) % sequenceLength
          : Math.max(0, Math.min(sequenceLength - 1, position));
        const y = getScrollYForSequencePosition(target, layout, true);
        if (y === null) return;
        const { height } = viewportStateRef.current;
        onNavigateRef.current?.(
          Math.max(0, Math.min(layout.totalHeight - height, y - (center ? height / 2 : 0)))
        );
      },
      [layout, sequenceLength]
    );

    const handleSvgClick = useCallback(
      (e: React.MouseEvent<SVGSVGElement>) => {
        if (hasDragged) {
          setHasDragged(false);
          return;
        }

        if (!onNavigateRef.current || !svgRef.current) return;

        const rect = svgRef.current.getBoundingClientRect();
        const clickY = e.clientY - rect.top;
        const clickPercent = clickY / minimapHeight;

        navigateToPosition(clickPercent * sequenceLength, true);
      },
      [hasDragged, minimapHeight, navigateToPosition, sequenceLength]
    );

    const handleSvgMouseMove = useCallback(
      (event: React.MouseEvent<SVGSVGElement>) => {
        if (!svgRef.current) return;
        const bounds = svgRef.current.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return;
        const x = ((event.clientX - bounds.left) / bounds.width) * width;
        const y = ((event.clientY - bounds.top) / bounds.height) * minimapHeight;
        let nextName: string | null = null;
        for (let index = annotationMarkers.length - 1; index >= 0; index -= 1) {
          const marker = annotationMarkers[index];
          if (
            x >= marker.x &&
            x <= marker.x + marker.width &&
            y >= marker.y &&
            y <= marker.y + marker.height
          ) {
            nextName = marker.name;
            break;
          }
        }
        setHoveredAnnotationName((current) => (current === nextName ? current : nextName));
      },
      [annotationMarkers, minimapHeight, width]
    );

    const handleViewportMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      setDragStartY(e.clientY);
      setDragStartPosition(viewportPositionsRef.current.startPos);
    }, []);

    const handleMouseMove = useCallback(
      (e: MouseEvent) => {
        if (!isDragging || !onNavigateRef.current || !svgRef.current) return;

        const deltaY = e.clientY - dragStartY;

        if (Math.abs(deltaY) > 3) {
          setHasDragged(true);
        }

        navigateToPosition(dragStartPosition + (deltaY / minimapHeight) * sequenceLength, false);
      },
      [isDragging, dragStartY, dragStartPosition, minimapHeight, navigateToPosition, sequenceLength]
    );

    const handleMouseUp = useCallback(() => {
      setIsDragging(false);
    }, []);

    React.useEffect(() => {
      if (isDragging) {
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
          window.removeEventListener('mousemove', handleMouseMove);
          window.removeEventListener('mouseup', handleMouseUp);
        };
      }
    }, [isDragging, handleMouseMove, handleMouseUp]);

    useLayoutEffect(() => {
      const el = viewportRectRef.current;
      if (!el) return;
      const { startPos, endPos } = viewportPositionsRef.current;
      const seqLen = sequenceLength;

      let startPercent = 0;
      let heightPercent = 2;
      let computed = false;

      if (seqLen > 0 && (startPos > 0 || endPos > 0)) {
        const viewportSize = startPos <= endPos ? endPos - startPos : seqLen - startPos + endPos;
        startPercent = (startPos / seqLen) * 100;
        heightPercent = Math.max(2, (viewportSize / seqLen) * 100);
        computed = true;
      } else if (totalHeight > 0 && viewportHeight > 0) {
        startPercent = (viewportScrollTop / totalHeight) * 100;
        heightPercent = Math.max(2, (viewportHeight / totalHeight) * 100);
        computed = true;
      }

      if (!computed) return;

      el.setAttribute('y', `${startPercent}%`);
      el.setAttribute('height', `${heightPercent}%`);

      if (layout.isCircular && viewportRectWrapRef.current) {
        const mainEndPercent = startPercent + heightPercent;
        if (mainEndPercent > 100) {
          const overflowPercent = mainEndPercent - 100;
          viewportRectWrapRef.current.setAttribute('y', '0%');
          viewportRectWrapRef.current.setAttribute('height', `${overflowPercent}%`);
          viewportRectWrapRef.current.setAttribute('opacity', '1');
        } else {
          viewportRectWrapRef.current.setAttribute('opacity', '0');
        }
      }
    });

    return (
      <div
        ref={containerDivRef}
        style={{
          width,
          height: '100%',
          flexShrink: 0,
          backgroundColor: 'hsl(var(--color-bg-subtle))',
          borderRight: '1px solid hsl(var(--color-border))',
          position: 'relative',
        }}
      >
        <svg
          width={width}
          height={minimapHeight}
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'block',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        >
          {}
          {selectionMarkers?.map((marker, idx) => (
            <rect
              key={idx}
              x="0"
              y={marker.y}
              width={width}
              height={marker.height}
              fill="var(--color-selection-fill)"
            />
          ))}
        </svg>

        <SequenceScrollbarAnnotationCanvas
          markers={annotationMarkers}
          reservedHeight={reservedHeight}
          width={width}
          height={minimapHeight}
        />

        <svg
          ref={svgRef}
          onPointerDownCapture={onNavigationStart}
          width={width}
          height={minimapHeight}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'block',
            cursor: isDragging ? 'grabbing' : 'pointer',
            zIndex: 2,
          }}
          onClick={handleSvgClick}
          onMouseMove={handleSvgMouseMove}
          onMouseLeave={() => setHoveredAnnotationName(null)}
        >
          {hoveredAnnotationName ? <title>{hoveredAnnotationName}</title> : null}

          {}
          <defs>
            <clipPath id={`minimap-clip-${clipId}`}>
              <rect x="0" y="0" width={width} height={minimapHeight} />
            </clipPath>
          </defs>

          {}
          <rect
            x="0"
            y="0"
            width={width}
            height={minimapHeight}
            fill="transparent"
            pointerEvents="all"
          />

          {}
          {scannedCutSiteMarkers.map((marker, idx) => (
            <line
              key={`scanned-${idx}`}
              x1="0"
              y1={marker.y}
              x2="5"
              y2={marker.y}
              stroke={marker.color}
              strokeWidth="1.5"
              opacity="0.9"
            >
              <title>
                {marker.site.enzyme.name} @ {marker.site.cutPositionTop}
              </title>
            </line>
          ))}

          {}
          {cutSiteMarkers.map((marker, idx) => (
            <line
              key={`cut-${idx}`}
              x1="0"
              y1={marker.y}
              x2="5"
              y2={marker.y}
              stroke={marker.color}
              strokeWidth="1.5"
              opacity="0.9"
            >
              <title>
                {marker.site.enzyme.name} @ {marker.site.cutPositionTop}
              </title>
            </line>
          ))}

          {}
          {searchMatchMarkers.map((marker, idx) => (
            <rect
              key={`search-${idx}`}
              x={width - 5}
              y={marker.y}
              width={4}
              height={marker.height}
              fill="hsl(35, 85%, 52%)"
              opacity={marker.isActive ? 1 : 0.5}
              rx={1}
              style={{ pointerEvents: 'none' }}
            />
          ))}

          {}
          {}
          <g clipPath={`url(#minimap-clip-${clipId})`}>
            {}
            <rect
              ref={viewportRectRef}
              x="1"
              y="0%"
              width={width - 2}
              height="0%"
              fill="hsl(var(--color-fg-subtle) / 0.5)"
              rx="4"
              ry="4"
              style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
              onMouseDown={handleViewportMouseDown}
            />

            {}
            <rect
              ref={viewportRectWrapRef}
              x="1"
              y="0%"
              width={width - 2}
              height="0%"
              fill="hsl(var(--color-fg-subtle) / 0.5)"
              rx="4"
              ry="4"
              opacity="0"
              style={{ cursor: isDragging ? 'grabbing' : 'grab', pointerEvents: 'none' }}
            />
          </g>
        </svg>
      </div>
    );
  }
);

const arePropsEqual = (
  prevProps: SequenceScrollbarProps,
  nextProps: SequenceScrollbarProps
): boolean => {
  return (
    prevProps.layout === nextProps.layout &&
    prevProps.sequenceLength === nextProps.sequenceLength &&
    prevProps.annotations === nextProps.annotations &&
    prevProps.annotationColorMode === nextProps.annotationColorMode &&
    prevProps.cutSites === nextProps.cutSites &&
    prevProps.scannedCutSites === nextProps.scannedCutSites &&
    prevProps.selection === nextProps.selection &&
    prevProps.width === nextProps.width &&
    prevProps.reservedHeight === nextProps.reservedHeight &&
    prevProps.onNavigationStart === nextProps.onNavigationStart &&
    prevProps.searchMatches === nextProps.searchMatches &&
    prevProps.activeSearchIndex === nextProps.activeSearchIndex
  );
};

export const SequenceScrollbar = React.memo(
  SequenceScrollbarInner,
  arePropsEqual
) as typeof SequenceScrollbarInner;

SequenceScrollbar.displayName = 'SequenceScrollbar';
