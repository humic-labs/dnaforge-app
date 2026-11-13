import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  compute1DLayout,
  DEFAULT_EDITOR_CONFIG,
  HORIZONTAL_PADDING_1D,
  MAX_PX_PER_BASE_1D,
  MIN_PX_PER_BASE_1D,
  SequenceViewer1D,
} from '@waypoint/workspace-editor';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';

const PAD_COLS = 3;
const PREVIEW_HEIGHT = 56;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface PrimerRenderPreviewProps {
  display: PrimerDisplay | null;
  referenceWindow?: { seq: string; primerOffset: number } | null;
}

export function PrimerRenderPreview({ display, referenceWindow }: PrimerRenderPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth;
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rebased = useMemo(() => {
    if (!display || width <= 0 || display.bases.length === 0) return null;
    const baseLen = display.bases.length;
    let sequence: string;
    let primerStart: number;
    if (referenceWindow && referenceWindow.seq.length > 0) {
      sequence = referenceWindow.seq;
      primerStart = clamp(referenceWindow.primerOffset, 0, Math.max(0, sequence.length - baseLen));
    } else {
      sequence = 'N'.repeat(PAD_COLS + baseLen + PAD_COLS);
      primerStart = PAD_COLS;
    }
    const columnCount = sequence.length;
    const primer: PrimerDisplay = { ...display, start: primerStart, end: primerStart + baseLen };
    const layoutInput = {
      columnCount,
      annotations: [],
      primers: [primer],
      showPrimers: true,
      showReverseComplement: true,
      showRuler: false,
    };
    const minHeight = compute1DLayout({
      ...layoutInput,
      pxPerBase: MIN_PX_PER_BASE_1D,
    }).totalHeight;
    const maxHeight = compute1DLayout({
      ...layoutInput,
      pxPerBase: MAX_PX_PER_BASE_1D,
    }).totalHeight;
    const heightLimit =
      MIN_PX_PER_BASE_1D +
      ((PREVIEW_HEIGHT - minHeight) / (maxHeight - minHeight)) *
        (MAX_PX_PER_BASE_1D - MIN_PX_PER_BASE_1D);
    const pxPerBase = clamp(
      (width - HORIZONTAL_PADDING_1D * 2) / columnCount,
      MIN_PX_PER_BASE_1D,
      Math.min(MAX_PX_PER_BASE_1D, heightLimit)
    );
    const zoomPercent = (pxPerBase / DEFAULT_EDITOR_CONFIG.charWidth) * 100;
    const annotatedSequence: AnnotatedSequence = {
      id: '__primer_ref_window__',
      name: 'reference',
      sequence,
      length: columnCount,
      annotations: [],
      circular: false,
    };
    return { annotatedSequence, primer, zoomPercent };
  }, [display, width, referenceWindow]);

  return (
    <div
      ref={containerRef}
      data-testid="primer-render-preview"
      data-reference-window={rebased ? rebased.annotatedSequence.sequence : ''}
      className="flex w-full min-w-0 shrink-0 items-center"
      style={{ height: PREVIEW_HEIGHT }}
    >
      {rebased ? (
        <SequenceViewer1D
          key={rebased.zoomPercent}
          sequence={rebased.annotatedSequence}
          primers={[rebased.primer]}
          showPrimers
          showReverseComplement
          showRuler={false}
          showScrollbar={false}
          wheelScrollEnabled={false}
          pointerInteractionsEnabled={false}
          primerHoverEnabled
          zoomPercent={rebased.zoomPercent}
          scrollLeft={0}
          transparentBackground
          style={{ width: '100%' }}
        />
      ) : (
        <div className="w-full text-center text-xs text-fg-muted">
          Enter a primer sequence to preview
        </div>
      )}
    </div>
  );
}
