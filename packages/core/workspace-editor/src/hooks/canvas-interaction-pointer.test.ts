import { describe, expect, it, vi } from 'vitest';
import {
  annotationHitRange,
  applyCanvasHandleDrag,
  applyNonEdgeCanvasHover,
  canvasAnnotationPointer,
  canvasFallbackCursor,
  commitCanvasRange,
  tryCommitCanvasLabelHit,
  commitShiftClickCanvasRange,
  ggLabelScarSelection,
  hoverCursorChanged,
  hoverCursorForMove,
  nextHoveredCodon,
  nucleotideShiftClickSelection,
  primerHitAtPoint,
  resolveOptionalHover,
  sameAnnotationIdentity,
  sameIntervalStrand,
  selectionFromHandleDrag,
  shiftPreviewForMove,
} from './canvas-interaction-pointer';

describe('selectionFromHandleDrag', () => {
  it('builds a linear range from the moving edge', () => {
    expect(selectionFromHandleDrag('start', 4, 10, false)).toEqual({ start: 4, end: 10 });
    expect(selectionFromHandleDrag('end', 12, 3, false)).toEqual({ start: 3, end: 12 });
  });

  it('marks a wrap when the circular range crosses the origin', () => {
    expect(selectionFromHandleDrag('end', 2, 8, true)).toEqual({
      start: 8,
      end: 2,
      wraps: true,
    });
  });
});

describe('commitCanvasRange', () => {
  it('writes the range to selection in edit mode and highlight otherwise', () => {
    const range = { start: 2, end: 8 };
    const onSelectionChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    commitCanvasRange({
      editable: true,
      range,
      onSelectionChange,
      onHighlightedRangeChange,
    });
    expect(onSelectionChange).toHaveBeenCalledWith(range);
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    onSelectionChange.mockClear();
    commitCanvasRange({
      editable: false,
      range,
      onSelectionChange,
      onHighlightedRangeChange,
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).toHaveBeenCalledWith(range);
  });
});

describe('applyNonEdgeCanvasHover', () => {
  it('clears hover targets when the pointer is not on a line', () => {
    expect(
      applyNonEdgeCanvasHover({
        linePresent: false,
        annotationPointer: true,
        codon: { start: 1, end: 3, strand: 1 },
        orfHover: { start: 1, end: 3, strand: 1 },
        nextHoveredAnn: { type: 'CDS', name: 'lacZ', start: 1, end: 3 },
        clientX: 10,
        clientY: 20,
      })
    ).toEqual({
      showPointer: false,
      codon: null,
      orfHover: null,
      nextHoveredAnn: null,
      tooltipPos: null,
    });
  });

  it('shows a pointer for a codon hit and follows the annotation tooltip', () => {
    const nextHoveredAnn = { type: 'CDS', name: 'lacZ', start: 1, end: 3 };
    expect(
      applyNonEdgeCanvasHover({
        linePresent: true,
        annotationPointer: false,
        codon: { start: 4, end: 6, strand: -1 },
        orfHover: null,
        nextHoveredAnn,
        clientX: 12,
        clientY: 18,
      })
    ).toEqual({
      showPointer: true,
      codon: { start: 4, end: 6, strand: -1 },
      orfHover: null,
      nextHoveredAnn,
      tooltipPos: { x: 12, y: 18 },
    });
  });
});

describe('tryCommitCanvasLabelHit', () => {
  it('commits the hit range and stops propagation', () => {
    const event = { stopPropagation: vi.fn() };
    const onHit = vi.fn();
    const onSelectionChange = vi.fn();
    const committed = tryCommitCanvasLabelHit({
      enabled: true,
      items: [{ id: 'eco' }],
      detectHit: (items) => items[0] ?? null,
      toRange: () => ({ start: 2, end: 8 }),
      onHit,
      event,
      editable: true,
      onSelectionChange,
    });
    expect(committed).toBe(true);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onHit).toHaveBeenCalledWith({ id: 'eco' });
    expect(onSelectionChange).toHaveBeenCalledWith({ start: 2, end: 8 });
  });

  it('does not commit when detection or range mapping misses', () => {
    const event = { stopPropagation: vi.fn() };
    const onSelectionChange = vi.fn();
    expect(
      tryCommitCanvasLabelHit({
        enabled: false,
        items: [{ id: 'eco' }],
        detectHit: () => ({ id: 'eco' }),
        toRange: () => ({ start: 1, end: 2 }),
        event,
        editable: true,
        onSelectionChange,
      })
    ).toBe(false);
    expect(
      tryCommitCanvasLabelHit({
        enabled: true,
        items: [{ id: 'eco' }],
        detectHit: () => null,
        toRange: () => ({ start: 1, end: 2 }),
        event,
        editable: true,
        onSelectionChange,
      })
    ).toBe(false);
    expect(
      tryCommitCanvasLabelHit({
        enabled: true,
        items: [{ id: 'eco' }],
        detectHit: (items) => items[0] ?? null,
        toRange: () => null,
        event,
        editable: true,
        onSelectionChange,
      })
    ).toBe(false);
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe('applyCanvasHandleDrag', () => {
  it('live-updates both ranges and previews highlight only when not editable', () => {
    const range = { start: 3, end: 9 };
    const liveSelectionRef = { current: null as { start: number; end: number } | null };
    const highlightedRangeRef = { current: null as { start: number; end: number } | null };
    const drawRafRef = { current: 7 as number | null };
    const drawFn = vi.fn();
    const drawFnRef = { current: drawFn };
    const drawSelectionDirect = vi.fn();
    const onHighlightedRangePreview = vi.fn();
    const cancel = vi.fn();
    const raf = vi.fn((cb: FrameRequestCallback) => {
      cb(0);
      return 11;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.stubGlobal('requestAnimationFrame', raf);

    applyCanvasHandleDrag({
      newSel: range,
      editable: true,
      liveSelectionRef,
      highlightedRangeRef,
      drawSelectionDirect,
      drawRafRef,
      drawFnRef,
      onHighlightedRangePreview,
    });
    expect(liveSelectionRef.current).toEqual(range);
    expect(highlightedRangeRef.current).toEqual(range);
    expect(drawSelectionDirect).toHaveBeenCalledWith(range);
    expect(cancel).toHaveBeenCalledWith(7);
    expect(drawFn).toHaveBeenCalledOnce();
    expect(onHighlightedRangePreview).not.toHaveBeenCalled();

    onHighlightedRangePreview.mockClear();
    applyCanvasHandleDrag({
      newSel: range,
      editable: false,
      liveSelectionRef,
      highlightedRangeRef,
      drawSelectionDirect,
      drawRafRef,
      drawFnRef,
      onHighlightedRangePreview,
    });
    expect(onHighlightedRangePreview).toHaveBeenCalledWith(range);
    vi.unstubAllGlobals();
  });
});

describe('commitShiftClickCanvasRange', () => {
  it('live-draws in edit mode and optionally clears the view cursor in highlight mode', () => {
    const range = { start: 1, end: 4 };
    const onViewCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    expect(
      commitShiftClickCanvasRange({
        editable: true,
        range,
        onSelectionChange: vi.fn(),
      })
    ).toEqual({ liveDraw: true });
    expect(
      commitShiftClickCanvasRange({
        editable: false,
        range,
        clearViewCursor: true,
        onViewCursorChange,
        onHighlightedRangeChange,
      })
    ).toEqual({ liveDraw: false });
    expect(onViewCursorChange).toHaveBeenCalledWith(null);
    expect(onHighlightedRangeChange).toHaveBeenCalledWith(range);
  });
});

describe('ggLabelScarSelection / annotationHitRange / nucleotideShiftClickSelection', () => {
  it('marks a wrap when the GoldenGate scar crosses the origin', () => {
    expect(ggLabelScarSelection({ scarStart: 18, scarEnd: 2 })).toEqual({
      start: 18,
      end: 1,
      wraps: true,
    });
    expect(ggLabelScarSelection({ scarStart: 4, scarEnd: 8 })).toEqual({ start: 4, end: 7 });
  });

  it('prefers explicit hit bounds on an annotation', () => {
    expect(annotationHitRange({ start: 10, end: 20, hitStart: 9, hitEnd: 19 })).toEqual({
      start: 9,
      end: 19,
    });
    expect(annotationHitRange({ start: 10, end: 20 })).toEqual({ start: 9, end: 19 });
  });

  it('extends the nearer linear edge and uses alt for circular wrap', () => {
    expect(
      nucleotideShiftClickSelection({
        isLinear: true,
        altKey: false,
        current: { start: 2, end: 8 },
        position: 12,
        cursor: 4,
        sequenceLength: 20,
      })
    ).toEqual({ start: 2, end: 12 });
    expect(
      nucleotideShiftClickSelection({
        isLinear: true,
        altKey: false,
        current: null,
        position: 6,
        cursor: 2,
        sequenceLength: 20,
      })
    ).toEqual({ start: 2, end: 6 });
  });
});

describe('canvas hover identity / pointer', () => {
  it('treats matching interval/strand as unchanged', () => {
    expect(
      sameIntervalStrand({ start: 1, end: 3, strand: 1 }, { start: 1, end: 3, strand: 1 })
    ).toBe(true);
    expect(
      sameIntervalStrand({ start: 1, end: 3, strand: 1 }, { start: 1, end: 4, strand: 1 })
    ).toBe(false);
  });

  it('compares annotation identity including type and direction', () => {
    expect(
      sameAnnotationIdentity(
        { type: 'CDS', name: 'lacZ', start: 1, end: 9, direction: 'forward' },
        { type: 'CDS', name: 'lacZ', start: 1, end: 9, direction: 'forward' }
      )
    ).toBe(true);
    expect(
      sameAnnotationIdentity(
        { type: 'CDS', name: 'lacZ', start: 1, end: 9, direction: 'forward' },
        { type: 'gene', name: 'lacZ', start: 1, end: 9, direction: 'forward' }
      )
    ).toBe(false);
  });

  it('builds a line hover cursor unless a label owns the pointer', () => {
    expect(
      hoverCursorForMove({ isOverCutSiteLabel: false, isOverGGLabel: false, lineIdx: 2, x: 12 })
    ).toEqual({ x: 12, lineIdx: 2 });
    expect(
      hoverCursorForMove({ isOverCutSiteLabel: true, isOverGGLabel: false, lineIdx: 2, x: 12 })
    ).toBeNull();
    expect(hoverCursorChanged({ x: 1, lineIdx: 0 }, { x: 1, lineIdx: 0 })).toBe(false);
    expect(hoverCursorChanged({ x: 1, lineIdx: 0 }, { x: 2, lineIdx: 0 })).toBe(true);
  });

  it('clears overlay codon hover and keeps an unchanged codon', () => {
    const codon = { start: 3, end: 5, strand: 1 as const };
    expect(nextHoveredCodon(codon, codon)).toBe(codon);
    expect(nextHoveredCodon({ ...codon, isOverlayClick: true }, codon)).toBeNull();
    expect(nextHoveredCodon(null, codon)).toBeNull();
    expect(canvasFallbackCursor('pointer', 4)).toBeNull();
    expect(canvasFallbackCursor('', 4)).toBe('text');
    expect(canvasFallbackCursor('', null)).toBe('default');
  });

  it('shows a pointer for annotation or intron hits only when annotations are on', () => {
    expect(
      canvasAnnotationPointer({
        showAnnotations: true,
        annotationHit: true,
        showTranslation: false,
        hasPosition: false,
        intronHit: false,
      })
    ).toBe(true);
    expect(
      canvasAnnotationPointer({
        showAnnotations: true,
        annotationHit: false,
        showTranslation: true,
        hasPosition: true,
        intronHit: true,
      })
    ).toBe(true);
    expect(
      canvasAnnotationPointer({
        showAnnotations: false,
        annotationHit: false,
        showTranslation: true,
        hasPosition: true,
        intronHit: true,
      })
    ).toBe(false);
  });
});

describe('shiftPreviewForMove', () => {
  it('returns null without shift, a position, or an anchor', () => {
    expect(
      shiftPreviewForMove({
        shiftKey: false,
        altKey: false,
        position: 5,
        currentSelection: { start: 1, end: 3 },
        currentCursor: 0,
        isCircular: false,
      })
    ).toBeNull();
  });

  it('extends the nearer end of a linear selection', () => {
    expect(
      shiftPreviewForMove({
        shiftKey: true,
        altKey: false,
        position: 9,
        currentSelection: { start: 2, end: 6 },
        currentCursor: null,
        isCircular: false,
      })
    ).toEqual({ hoverPosition: 9, anchorPosition: 2, isOptionHeld: false });
  });

  it('uses alt as the circular wrap toggle', () => {
    expect(
      shiftPreviewForMove({
        shiftKey: true,
        altKey: true,
        position: 1,
        currentSelection: { start: 2, end: 8 },
        currentCursor: null,
        isCircular: true,
      })
    ).toEqual({ hoverPosition: 1, anchorPosition: 8, isOptionHeld: true });
  });
});

describe('primerHitAtPoint', () => {
  const primers = [
    { id: 'a', x: 10, y: 20, width: 8, height: 4 },
    { id: 'b', x: 40, y: 20, width: 8, height: 4 },
  ];

  it('hits the primer whose box contains the point', () => {
    expect(primerHitAtPoint(primers, 12, 22)?.id).toBe('a');
    expect(primerHitAtPoint(primers, 0, 0)).toBeUndefined();
  });
});

describe('resolveOptionalHover', () => {
  it('detects when inspect is on and items exist', () => {
    expect(
      resolveOptionalHover({
        inspect: true,
        clearWhenIdle: true,
        items: [1],
        detect: () => 'hit',
      })
    ).toEqual({ value: 'hit', isOver: true, apply: true });
  });

  it('clears when idle and not inspecting', () => {
    expect(
      resolveOptionalHover({
        inspect: false,
        clearWhenIdle: true,
        items: [1],
        detect: () => 'hit',
      })
    ).toEqual({ value: null, isOver: false, apply: true });
  });

  it('leaves the previous hover untouched while dragging', () => {
    expect(
      resolveOptionalHover({
        inspect: false,
        clearWhenIdle: false,
        items: [1],
        detect: () => 'hit',
      })
    ).toEqual({ value: null, isOver: false, apply: false });
  });
});
