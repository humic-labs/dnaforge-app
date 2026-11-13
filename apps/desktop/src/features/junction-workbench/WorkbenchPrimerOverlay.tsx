import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import {
  DEFAULT_EDITOR_CONFIG,
  compute1DLayout,
  render1DPrimers,
} from '@waypoint/workspace-editor';
import type { Annotation } from '@waypoint/sequence-utils';
import type { PrimerDisplay, SequenceExtraLane } from '@waypoint/workspace-editor';

export interface WorkbenchPrimerOverlayProps {
  sequence: string;
  annotations: Annotation[];
  primers: PrimerDisplay[];
  pxPerBase: number;
  isCircular: boolean;
  showReverseComplement: boolean;
  showPrimers: boolean;
  scrollLeft: number;
  extraLanes?: SequenceExtraLane[];
  rowId?: string;
}

export interface WorkbenchPrimerOverlayHandle {
  applyLiveOverride(primers: PrimerDisplay[] | null): void;
}

export const WorkbenchPrimerOverlay = forwardRef<
  WorkbenchPrimerOverlayHandle,
  WorkbenchPrimerOverlayProps
>(function WorkbenchPrimerOverlay(
  {
    sequence,
    annotations,
    primers,
    pxPerBase,
    isCircular,
    showReverseComplement,
    showPrimers,
    scrollLeft,
    extraLanes,
    rowId,
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const livePrimersRef = useRef<PrimerDisplay[] | null>(null);

  const layout = useMemo(
    () =>
      compute1DLayout({
        columnCount: sequence.length,
        annotations,
        selectedIds: new Set(),
        pxPerBase,
        isCircular,
        fullSequence: sequence,
        orfs: [],
        primers,
        showPrimers,
        showReverseComplement,
        showRuler: false,
      }),
    [sequence, annotations, pxPerBase, isCircular, primers, showPrimers, showReverseComplement]
  );

  const extrasHeight = useMemo(
    () =>
      extraLanes && extraLanes.length > 0
        ? extraLanes.reduce((sum, lane) => sum + Math.max(0, lane.height), 0)
        : 0,
    [extraLanes]
  );
  const cssHeight = layout.totalHeight + extrasHeight;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const cssWidth = container.clientWidth;
    if (cssWidth <= 0) return;

    const zoomScale = pxPerBase / DEFAULT_EDITOR_CONFIG.charWidth;
    const sharedConfig = {
      ...DEFAULT_EDITOR_CONFIG,
      charWidth: pxPerBase,
      rowHeight: DEFAULT_EDITOR_CONFIG.rowHeight * zoomScale,
      fontSize: Math.max(
        1,
        (DEFAULT_EDITOR_CONFIG.fontSize * pxPerBase) / DEFAULT_EDITOR_CONFIG.charWidth
      ),
    };

    const dpr = window.devicePixelRatio || 1;
    const desiredW = Math.round(cssWidth * dpr);
    const desiredH = Math.round(cssHeight * dpr);
    if (canvas.width !== desiredW || canvas.height !== desiredH) {
      canvas.width = desiredW;
      canvas.height = desiredH;
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const drawnPrimers = livePrimersRef.current ?? primers;

    container.dataset.workbenchPrimerOverlayDrawnBases = JSON.stringify(
      drawnPrimers.map((p) => ({ id: p.id, dir: p.direction, bases: p.bases }))
    );
    container.dataset.workbenchPrimerOverlayDrawnPrimers = JSON.stringify(
      drawnPrimers.map((p) => ({
        id: p.id,
        sourcePrimerId: p.sourcePrimerId,
        dir: p.direction,
        start: p.start,
        end: p.end,
        overhangLength: p.overhangLength,
        junctionIndex: p.junctionIndex,
        isScarMarkerOnly: p.isScarMarkerOnly,
        bases: p.bases,
      }))
    );

    ctx.save();
    ctx.translate(-scrollLeft, 0);
    const renderedSegments = render1DPrimers({
      ctx,
      primers: drawnPrimers,
      showPrimers: showPrimers || drawnPrimers.length > 0,
      columnCount: sequence.length,
      pxPerBase,
      isCircular,
      sharedConfig,
      forwardPrimerLaneCount: layout.forwardPrimerLaneCount,
      forwardPrimerBandTop: layout.forwardPrimerBandTop,
      reversePrimerLaneCount: layout.reversePrimerLaneCount,
      reversePrimerBandTop: layout.reversePrimerBandTop,
      scrollLeft,
      cssWidth,
      hoveredPrimerId: null,
      suppressDrawing: false,
    });
    container.dataset.workbenchPrimerOverlayDrawnSegments = JSON.stringify(
      renderedSegments.map((segment) => ({
        primerId: segment.primerId,
        sourcePrimerId: segment.sourcePrimerId,
        direction: segment.direction,
        role: segment.role,
        start: segment.start,
        end: segment.end,
        x: round2(segment.x),
        y: round2(segment.y),
        width: round2(segment.width),
        height: round2(segment.height),
        lane: segment.lane,
      }))
    );
    ctx.restore();
  }, [sequence, primers, pxPerBase, isCircular, showPrimers, scrollLeft, layout, cssHeight]);

  useImperativeHandle(
    ref,
    () => ({
      applyLiveOverride(next) {
        livePrimersRef.current = next;
        draw();
      },
    }),
    [draw]
  );

  useEffect(() => {
    draw();
  }, [draw]);

  return (
    <div
      ref={containerRef}
      data-testid={rowId ? `workbench-primer-overlay-${rowId}` : 'workbench-primer-overlay'}
      data-workbench-primer-overlay="true"
      data-workbench-primer-overlay-css-height={String(cssHeight)}
      data-workbench-primer-overlay-scroll-left={String(scrollLeft)}
      className="pointer-events-none absolute inset-0"
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: cssHeight,
          flex: '0 0 auto',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', left: 0, top: 0, display: 'block' }}
        />
      </div>
    </div>
  );
});

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
