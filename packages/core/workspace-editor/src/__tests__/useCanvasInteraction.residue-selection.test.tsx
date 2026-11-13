/**
 * @vitest-environment jsdom
 */

import { useMemo, useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseGenBankFull } from '@waypoint/sequence-utils';
import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import {
  createResidueSelectionsStore,
  ResidueSelectionsProvider,
  residueSelectionsToCodingDnaRanges,
} from '../residue-selection-store';
import { TRANSLATION_LABEL_HEIGHT } from '../layout-constants';
import { calculateLinePositions } from '../line-positions';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { isApplePlatform } from '../platform-modifiers';
import type {
  DeletedRange,
  InsertedRange,
  LayoutSnapshot2D,
  PrimerDisplay,
  RenderedGGProductLabel,
  Selection,
  WorkspaceEditorConfig,
} from '../types';
import type { RenderedCutSite } from '../restriction-enzymes/drawCutSites';
import type { CdsExtensionArrowBounds } from '../cds-extension-affordance';
import {
  CdsExtensionHoverProvider,
  createCdsExtensionHoverStore,
} from '../cds-extension-hover-store';

const FIXTURES_DIR = join(__dirname, '../../../../../test-fixtures');
const SFGFP_FIXTURE = join(FIXTURES_DIR, 'sequences/linear/sfgfp-cds.gb');
const SFGFP = parseGenBankFull(readFileSync(SFGFP_FIXTURE, 'utf8'));
const SFGFP_CDS = SFGFP.annotations?.find((annotation) => annotation.type === 'CDS');
if (!SFGFP_CDS) throw new Error('sfGFP fixture must contain a CDS');

const TEST_REFERENCE_ID = '/fixtures/sfgfp-cds.gb';
const COMMAND_MODIFIER = isApplePlatform() ? { metaKey: true } : { ctrlKey: true };
const TEST_CONFIG: WorkspaceEditorConfig = {
  ...DEFAULT_EDITOR_CONFIG,
  charsPerLine: 60,
  charWidth: 9,
  rowHeight: 20,
  marginLeft: 8,
  showAnnotations: true,
  showTranslation: true,
  showReverseComplement: false,
  showPrimers: false,
};

const TEST_LINE: LayoutSnapshot2D['lines'][0] = {
  lineIndex: 0,
  startPos: 0,
  endPos: 60,
  sequence: SFGFP.sequence.slice(0, 60),
  complementSequence: 'T'.repeat(60),
  y: 0,
  annotations: [],
  annotationLaneCount: 0,
  translationLaneCount: 1,
  classifiedCDSs: [
    {
      ...SFGFP_CDS,
      translationLane: 0,
      cdsType: 'full',
    },
  ],
};

const TEST_LAYOUT: LayoutSnapshot2D = {
  lines: [TEST_LINE],
  totalHeight: 80,
  totalWidth: 700,
  sequenceLength: SFGFP.sequence.length,
  isCircular: false,
};

interface HookHarnessProps {
  editable?: boolean;
  layout?: LayoutSnapshot2D;
  onSelectionChange: (selection: Selection | null) => void;
  onCursorChange: (position: number) => void;
  onHighlightedRangeChange: (selection: Selection | null) => void;
  onViewCursorChange: (position: number | null) => void;

  extensionArrows?: CdsExtensionArrowBounds[];
  onCdsExtensionAnchor?: (bp: number | null) => void;
}

function HookHarness({
  editable = true,
  layout = TEST_LAYOUT,
  onSelectionChange,
  onCursorChange,
  onHighlightedRangeChange,
  onViewCursorChange,
  extensionArrows,
  onCdsExtensionAnchor,
}: HookHarnessProps) {
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef({ scrollTop: 0, height: layout.totalHeight });
  const drawFnRef = useRef<(() => void) | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const canvasRectRef = useRef<DOMRect | null>(null);
  const hoverCursorRef = useRef<{ x: number; lineIdx: number } | null>(null);
  const drawSelectionAndCursorRef = useRef<
    (
      sel: Selection | null,
      cursorPos: number | undefined,
      showCursor: boolean,
      ranges?: InsertedRange[],
      delRanges?: DeletedRange[],
      hoverCursor?: { x: number; lineIdx: number } | null
    ) => void
  >(() => {});
  const isSelectingRef = useRef(false);
  const selectionAnchorRef = useRef<number | null>(null);
  const liveSelectionRef = useRef<Selection | null>(null);
  const editLastDragPositionRef = useRef<number | null>(null);
  const editCumulativeDragDeltaRef = useRef(0);
  const isHighlightingRef = useRef(false);
  const highlightAnchorRef = useRef<number | null>(null);
  const lastDragPositionRef = useRef<number | null>(null);
  const cumulativeDragDeltaRef = useRef(0);
  const highlightedRangeRef = useRef<Selection | null>(null);
  const isDraggingHandleRef = useRef<'start' | 'end' | null>(null);
  const handleDragAnchorRef = useRef<number | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const cursorRef = useRef<number | undefined>(undefined);
  const cursorVisibleRef = useRef(true);
  const insertedRangesRef = useRef<InsertedRange[]>([]);
  const deletedRangesRef = useRef<DeletedRange[]>([]);
  const renderedPrimersRef = useRef<
    Array<{ primer: PrimerDisplay; x: number; y: number; width: number; height: number }>
  >([]);
  const renderedGGLabelsRef = useRef<RenderedGGProductLabel[]>([]);
  const renderedCutSitesRef = useRef<RenderedCutSite[]>([]);
  const shiftPreviewRef = useRef<{
    hoverPosition: number;
    anchorPosition: number;
    isOptionHeld: boolean;
  } | null>(null);
  const linePrimerFlagsMap = useMemo(
    () =>
      new Map<
        LayoutSnapshot2D['lines'][0],
        { hasForwardPrimers: boolean; hasReversePrimers: boolean }
      >(),
    []
  );

  const handlers = useCanvasInteraction({
    selectionCanvasRef,
    viewportRef,
    drawFnRef,
    drawRafRef,
    canvasRectRef,
    hoverCursorRef,
    drawSelectionAndCursorRef,
    drawSelectionDirect: () => {},
    isSelectingRef,
    selectionAnchorRef,
    liveSelectionRef,
    editLastDragPositionRef,
    editCumulativeDragDeltaRef,
    isHighlightingRef,
    highlightAnchorRef,
    lastDragPositionRef,
    cumulativeDragDeltaRef,
    highlightedRangeRef,
    isDraggingHandleRef,
    handleDragAnchorRef,
    mouseDownPosRef,
    cursorRef,
    cursorVisibleRef,
    insertedRangesRef,
    deletedRangesRef,
    renderedPrimersRef,
    renderedGGLabelsRef,
    renderedCdsExtensionArrowsRef: { current: extensionArrows ?? [] },
    onCdsExtensionAnchor,
    renderedCutSitesRef,
    layout,
    config: TEST_CONFIG,
    precomputedLinePositions: [],
    linePrimerFlagsMap,
    sequenceLength: SFGFP.sequence.length,
    editable,
    selection: null,
    cursor: undefined,
    viewCursor: null,
    highlightedRange: null,
    showCutSites: false,
    fullSequence: SFGFP.sequence,
    residueSelectionReferenceId: TEST_REFERENCE_ID,
    onSelectionChange,
    onCursorChange,
    onHighlightedRangeChange,
    onViewCursorChange,
    shiftPreviewRef,
  });

  return (
    <canvas
      ref={selectionCanvasRef}
      data-testid="sequence-canvas-interactive"
      onMouseDown={handlers.handleMouseDown}
      onMouseMove={handlers.handleMouseMove}
      onMouseUp={handlers.handleMouseUp}
      onClick={handlers.handleClick}
    />
  );
}

function clientXForPosition(position: number): number {
  return TEST_CONFIG.marginLeft + position * TEST_CONFIG.charWidth + 1;
}

const CODON_Y = TRANSLATION_LABEL_HEIGHT + 2;

describe('useCanvasInteraction residue selection', () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as { __test?: Record<string, unknown> }).__test;
  });

  it.each([false, true])(
    'anchors a right-half drag at the visible cursor (editable=%s)',
    (editable) => {
      const onSelectionChange = vi.fn();
      const onHighlightedRangeChange = vi.fn();
      const onCursorChange = vi.fn();
      const onViewCursorChange = vi.fn();
      const { getByTestId } = render(
        <HookHarness
          editable={editable}
          onSelectionChange={onSelectionChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onCursorChange={onCursorChange}
          onViewCursorChange={onViewCursorChange}
        />
      );
      const canvas = getByTestId('sequence-canvas-interactive');
      const y =
        calculateLinePositions(TEST_LINE, TEST_CONFIG, [], SFGFP.sequence.length).sequenceY + 5;
      const startX = TEST_CONFIG.marginLeft + 10.8 * TEST_CONFIG.charWidth;
      const endX = TEST_CONFIG.marginLeft + 20.2 * TEST_CONFIG.charWidth;
      fireEvent.mouseDown(canvas, { button: 0, clientX: startX, clientY: y });
      expect(editable ? onCursorChange : onViewCursorChange).toHaveBeenLastCalledWith(11);
      fireEvent.mouseMove(canvas, { buttons: 1, clientX: endX, clientY: y });
      fireEvent.mouseUp(canvas, { button: 0, clientX: endX, clientY: y });
      expect(editable ? onSelectionChange : onHighlightedRangeChange).toHaveBeenLastCalledWith({
        start: 11,
        end: 20,
      });
    }
  );

  it.each([false, true])(
    'commits the painted drag when released outside the canvas (editable=%s)',
    (editable) => {
      const onSelectionChange = vi.fn();
      const onHighlightedRangeChange = vi.fn();
      const { getByTestId } = render(
        <HookHarness
          editable={editable}
          onSelectionChange={onSelectionChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onCursorChange={vi.fn()}
          onViewCursorChange={vi.fn()}
        />
      );
      const canvas = getByTestId('sequence-canvas-interactive');
      const y =
        calculateLinePositions(TEST_LINE, TEST_CONFIG, [], SFGFP.sequence.length).sequenceY + 5;
      const startX = TEST_CONFIG.marginLeft + 10.8 * TEST_CONFIG.charWidth;
      const endX = TEST_CONFIG.marginLeft + 20.2 * TEST_CONFIG.charWidth;
      fireEvent.mouseDown(canvas, { button: 0, clientX: startX, clientY: y });
      fireEvent.mouseMove(canvas, { buttons: 1, clientX: endX, clientY: y });
      fireEvent.mouseUp(window, { button: 0, clientX: endX, clientY: y });
      expect(editable ? onSelectionChange : onHighlightedRangeChange).toHaveBeenLastCalledWith({
        start: 11,
        end: 20,
      });
    }
  );

  it.each([
    [false, 0],
    [true, 0],
    [false, 1],
    [true, 1],
  ] as const)(
    'ends a backward origin drag at the preceding base (editable=%s, cursor=%s)',
    (editable, cursor) => {
      const sequenceLength = SFGFP.sequence.length;
      const originLine: LayoutSnapshot2D['lines'][0] = {
        ...TEST_LINE,
        startPos: sequenceLength - 20,
        endPos: 20,
        preOriginLength: 20,
        sequence: SFGFP.sequence.slice(-20) + SFGFP.sequence.slice(0, 20),
        complementSequence: 'T'.repeat(40),
        translationLaneCount: 0,
        classifiedCDSs: [],
      };
      const onSelectionChange = vi.fn();
      const onHighlightedRangeChange = vi.fn();
      const onCursorChange = vi.fn();
      const onViewCursorChange = vi.fn();
      const { getByTestId } = render(
        <HookHarness
          editable={editable}
          layout={{ ...TEST_LAYOUT, lines: [originLine], isCircular: true }}
          onSelectionChange={onSelectionChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onCursorChange={onCursorChange}
          onViewCursorChange={onViewCursorChange}
        />
      );
      const canvas = getByTestId('sequence-canvas-interactive');
      const y = calculateLinePositions(originLine, TEST_CONFIG, [], sequenceLength).sequenceY + 5;
      const startX = TEST_CONFIG.marginLeft + (20.2 + cursor) * TEST_CONFIG.charWidth;
      const endX = TEST_CONFIG.marginLeft + 15.2 * TEST_CONFIG.charWidth;
      fireEvent.mouseDown(canvas, { button: 0, clientX: startX, clientY: y });
      expect(editable ? onCursorChange : onViewCursorChange).toHaveBeenLastCalledWith(cursor);
      fireEvent.mouseMove(canvas, { buttons: 1, clientX: endX, clientY: y });
      fireEvent.mouseUp(canvas, { button: 0, clientX: endX, clientY: y });
      expect(editable ? onSelectionChange : onHighlightedRangeChange).toHaveBeenLastCalledWith({
        start: sequenceLength - 5,
        end: cursor === 0 ? sequenceLength - 1 : 0,
        ...(cursor === 1 ? { wraps: true } : {}),
      });
    }
  );

  it('Cmd-clicking a CDS amino-acid cell toggles a residue selection without committing a nucleotide range', () => {
    (window as unknown as { __test?: Record<string, unknown> }).__test = {};
    const store = createResidueSelectionsStore();
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const { getByTestId } = render(
      <ResidueSelectionsProvider value={store}>
        <HookHarness
          onSelectionChange={onSelectionChange}
          onCursorChange={onCursorChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onViewCursorChange={onViewCursorChange}
        />
      </ResidueSelectionsProvider>
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = {
      button: 0,
      ...COMMAND_MODIFIER,
      clientX: clientXForPosition(13),
      clientY: CODON_Y,
    };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);

    const snapshot = store.getSnapshot();
    const pointerDebug = (
      window as unknown as { __test?: { residueSelectionPointerDebug?: unknown } }
    ).__test?.residueSelectionPointerDebug;
    expect(snapshot).toHaveLength(1);
    expect(pointerDebug).toMatchObject({
      stage: 'toggle',
      result: true,
      referenceId: TEST_REFERENCE_ID,
      coordinateMode: null,
      hasStore: true,
      selectionId: snapshot[0]?.selectionId ?? null,
      snapshotLength: 1,
    });
    expect(snapshot[0]).toMatchObject({
      source: { kind: 'translation-track', id: TEST_REFERENCE_ID, surface: 'sequence-cds' },
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 4, end: 4 }],
      },
    });
    expect(snapshot[0] && 'start' in snapshot[0]).toBe(false);
    expect(snapshot[0] && 'strand' in snapshot[0]).toBe(false);
    expect(residueSelectionsToCodingDnaRanges(snapshot, TEST_REFERENCE_ID)).toEqual([
      { start: 12, end: 14, strand: 1 },
    ]);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).not.toHaveBeenCalled();

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);

    expect(store.getSnapshot()).toEqual([]);
  });

  it('Cmd-Shift-clicking a second CDS amino-acid cell range-selects residues in protein order', () => {
    (window as unknown as { __test?: Record<string, unknown> }).__test = {};
    const store = createResidueSelectionsStore();
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const { getByTestId } = render(
      <ResidueSelectionsProvider value={store}>
        <HookHarness
          onSelectionChange={onSelectionChange}
          onCursorChange={onCursorChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onViewCursorChange={onViewCursorChange}
        />
      </ResidueSelectionsProvider>
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const first = {
      button: 0,
      ...COMMAND_MODIFIER,
      clientX: clientXForPosition(13),
      clientY: CODON_Y,
    };
    const second = {
      button: 0,
      ...COMMAND_MODIFIER,
      shiftKey: true,
      clientX: clientXForPosition(22),
      clientY: CODON_Y,
    };

    fireEvent.mouseDown(canvas, first);
    fireEvent.mouseUp(canvas, first);
    fireEvent.click(canvas, first);
    fireEvent.mouseDown(canvas, second);
    fireEvent.mouseUp(canvas, second);
    fireEvent.click(canvas, second);

    const snapshot = store.getSnapshot();
    const pointerDebug = (
      window as unknown as { __test?: { residueSelectionPointerDebug?: unknown } }
    ).__test?.residueSelectionPointerDebug;
    expect(snapshot).toHaveLength(1);
    expect(pointerDebug).toMatchObject({
      stage: 'range',
      result: true,
      referenceId: TEST_REFERENCE_ID,
      coordinateMode: null,
      hasStore: true,
      snapshotLength: 1,
    });
    expect(snapshot[0]).toMatchObject({
      source: { kind: 'translation-track', id: TEST_REFERENCE_ID, surface: 'sequence-cds' },
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 4, end: 7 }],
      },
    });
    expect(residueSelectionsToCodingDnaRanges(snapshot, TEST_REFERENCE_ID)).toEqual([
      { start: 12, end: 14, strand: 1 },
      { start: 15, end: 17, strand: 1 },
      { start: 18, end: 20, strand: 1 },
      { start: 21, end: 23, strand: 1 },
    ]);

    const oppositeDirectionTarget = {
      button: 0,
      ...COMMAND_MODIFIER,
      shiftKey: true,
      clientX: clientXForPosition(7),
      clientY: CODON_Y,
    };
    fireEvent.mouseDown(canvas, oppositeDirectionTarget);
    fireEvent.mouseUp(canvas, oppositeDirectionTarget);
    fireEvent.click(canvas, oppositeDirectionTarget);

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.getSnapshot()[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 7 }],
      },
    });
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot(), TEST_REFERENCE_ID)).toEqual([
      { start: 6, end: 8, strand: 1 },
      { start: 9, end: 11, strand: 1 },
      { start: 12, end: 14, strand: 1 },
      { start: 15, end: 17, strand: 1 },
      { start: 18, end: 20, strand: 1 },
      { start: 21, end: 23, strand: 1 },
    ]);

    const insideSelectedTarget = {
      button: 0,
      ...COMMAND_MODIFIER,
      shiftKey: true,
      clientX: clientXForPosition(16),
      clientY: CODON_Y,
    };
    fireEvent.mouseDown(canvas, insideSelectedTarget);
    fireEvent.mouseUp(canvas, insideSelectedTarget);
    fireEvent.click(canvas, insideSelectedTarget);

    expect(store.getSnapshot()[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 2, end: 7 }],
      },
    });
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot(), TEST_REFERENCE_ID)).toEqual([
      { start: 6, end: 8, strand: 1 },
      { start: 9, end: 11, strand: 1 },
      { start: 12, end: 14, strand: 1 },
      { start: 15, end: 17, strand: 1 },
      { start: 18, end: 20, strand: 1 },
      { start: 21, end: 23, strand: 1 },
    ]);

    store.set([]);
    fireEvent.mouseDown(canvas, second);
    fireEvent.mouseUp(canvas, second);
    fireEvent.click(canvas, second);

    expect(store.getSnapshot()).toHaveLength(1);
    expect(
      (window as unknown as { __test?: { residueSelectionPointerDebug?: unknown } }).__test
        ?.residueSelectionPointerDebug
    ).toMatchObject({
      stage: 'toggle',
      result: true,
      extendRange: true,
      hasRangeAnchor: true,
      snapshotLength: 1,
    });
    expect(store.getSnapshot()[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 7, end: 7 }],
      },
    });
    expect(residueSelectionsToCodingDnaRanges(store.getSnapshot(), TEST_REFERENCE_ID)).toEqual([
      { start: 21, end: 23, strand: 1 },
    ]);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).not.toHaveBeenCalled();
  });

  it('Cmd-clicking the CDS label strip resolves the residue at that x-position', () => {
    (window as unknown as { __test?: Record<string, unknown> }).__test = {};
    const store = createResidueSelectionsStore();
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const { getByTestId } = render(
      <ResidueSelectionsProvider value={store}>
        <HookHarness
          onSelectionChange={onSelectionChange}
          onCursorChange={onCursorChange}
          onHighlightedRangeChange={onHighlightedRangeChange}
          onViewCursorChange={onViewCursorChange}
        />
      </ResidueSelectionsProvider>
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = {
      button: 0,
      ...COMMAND_MODIFIER,
      clientX: clientXForPosition(13),
      clientY: TRANSLATION_LABEL_HEIGHT - 2,
    };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);

    const snapshot = store.getSnapshot();
    const pointerDebug = (
      window as unknown as { __test?: { residueSelectionPointerDebug?: unknown } }
    ).__test?.residueSelectionPointerDebug;
    expect(snapshot).toHaveLength(1);
    expect(pointerDebug).toMatchObject({
      stage: 'toggle',
      result: true,
      referenceId: TEST_REFERENCE_ID,
      coordinateMode: null,
      hasStore: true,
      selectionId: snapshot[0]?.selectionId ?? null,
      snapshotLength: 1,
    });
    expect(snapshot[0]).toMatchObject({
      target: {
        moleculeKind: 'translated-cds',
        coordinateSystem: 'residue',
        intervals: [{ start: 4, end: 4 }],
      },
      mappings: [
        {
          kind: 'coding-dna',
          referenceId: TEST_REFERENCE_ID,
          featureId: 'superfolder GFP',
          strand: 1,
          intervals: [{ start: 12, end: 14 }],
        },
      ],
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).not.toHaveBeenCalled();
  });
});

describe(' clicking an extension arrow pins a scroll anchor', () => {
  const arrow = (overrides: Partial<CdsExtensionArrowBounds> = {}): CdsExtensionArrowBounds => ({
    cdsKey: 'subject|CDS|10|60',
    direction: 'five-prime',
    kind: 'undo',
    pointsRight: true,
    anchorBp: 2553,
    x: 100,
    y: 10,
    width: 12,
    height: 9,
    ...overrides,
  });

  function renderWithArrows(
    arrows: CdsExtensionArrowBounds[],
    onCdsExtensionAnchor: (bp: number | null) => void
  ) {
    const store = createCdsExtensionHoverStore();
    const result = render(
      <CdsExtensionHoverProvider value={store}>
        <HookHarness
          onSelectionChange={vi.fn()}
          onCursorChange={vi.fn()}
          onHighlightedRangeChange={vi.fn()}
          onViewCursorChange={vi.fn()}
          extensionArrows={arrows}
          onCdsExtensionAnchor={onCdsExtensionAnchor}
        />
      </CdsExtensionHoverProvider>
    );
    return { store, result };
  }

  function pressArrow(bounds: CdsExtensionArrowBounds) {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('harness canvas missing');
    canvas.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 700, height: 80, right: 700, bottom: 80, x: 0, y: 0 }) as DOMRect;
    fireEvent.mouseDown(canvas, {
      clientX: bounds.x + bounds.width / 2,
      clientY: bounds.y + bounds.height / 2,
      button: 0,
    });
  }

  it('pins the arrow base when nothing is hovered — the collapse case', () => {
    const onCdsExtensionAnchor = vi.fn();
    const undo = arrow();
    renderWithArrows([undo], onCdsExtensionAnchor);
    pressArrow(undo);
    expect(onCdsExtensionAnchor).toHaveBeenCalledWith(2553);
  });

  it('does not pin again when a hover preview is already showing', () => {
    const onCdsExtensionAnchor = vi.fn();
    const extend = arrow({ kind: 'extend', pointsRight: false, anchorBp: 2568 });
    const { store } = renderWithArrows([extend], onCdsExtensionAnchor);
    store.setHovered({
      cdsKey: extend.cdsKey,
      direction: 'five-prime',
      kind: 'extend',
    });
    pressArrow(extend);
    expect(onCdsExtensionAnchor).not.toHaveBeenCalled();
  });

  it('still requests the draft either way', () => {
    const undo = arrow();
    const { store } = renderWithArrows([undo], vi.fn());
    pressArrow(undo);
    expect(store.takeDraftRequest()).toEqual({
      cdsKey: undo.cdsKey,
      direction: 'five-prime',
      kind: 'undo',
    });
  });
});
