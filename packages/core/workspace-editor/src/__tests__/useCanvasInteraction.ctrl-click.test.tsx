/**
 * @vitest-environment jsdom
 */

import { useMemo, useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import { DEFAULT_EDITOR_CONFIG } from '../types';
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

const TEST_SEQUENCE = 'A'.repeat(20);
const TEST_CONFIG: WorkspaceEditorConfig = {
  ...DEFAULT_EDITOR_CONFIG,
  charsPerLine: 20,
  charWidth: 8,
  rowHeight: 20,
  marginLeft: 4,
  showAnnotations: false,
  showTranslation: false,
  showReverseComplement: false,
  showPrimers: false,
};

const TEST_LINE: LayoutSnapshot2D['lines'][0] = {
  lineIndex: 0,
  startPos: 0,
  endPos: TEST_SEQUENCE.length,
  sequence: TEST_SEQUENCE,
  complementSequence: 'T'.repeat(TEST_SEQUENCE.length),
  y: 0,
  annotations: [],
  annotationLaneCount: 0,
  translationLaneCount: 0,
};

const TEST_LAYOUT: LayoutSnapshot2D = {
  lines: [TEST_LINE],
  totalHeight: 40,
  totalWidth: 180,
  sequenceLength: TEST_SEQUENCE.length,
  isCircular: false,
};

interface HookHarnessProps {
  editable?: boolean;
  selection: Selection | null;
  highlightedRange?: Selection | null;
  viewCursor?: number | null;
  onSelectionChange: (selection: Selection | null) => void;
  onCursorChange: (position: number) => void;
  onHighlightedRangeChange?: (selection: Selection | null) => void;
  onViewCursorChange?: (position: number | null) => void;
  onContextMenu: Parameters<typeof useCanvasInteraction>[0]['onContextMenu'];
}

function HookHarness({
  editable = true,
  selection,
  highlightedRange = null,
  viewCursor = null,
  onSelectionChange,
  onCursorChange,
  onHighlightedRangeChange,
  onViewCursorChange,
  onContextMenu,
}: HookHarnessProps) {
  const selectionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef({ scrollTop: 0, height: TEST_LAYOUT.totalHeight });
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

  highlightedRangeRef.current = highlightedRange;

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
    renderedCdsExtensionArrowsRef: { current: [] },
    renderedCutSitesRef,
    layout: TEST_LAYOUT,
    config: TEST_CONFIG,
    precomputedLinePositions: [],
    linePrimerFlagsMap,
    sequenceLength: TEST_SEQUENCE.length,
    editable,
    selection,
    cursor: undefined,
    viewCursor,
    highlightedRange,
    showCutSites: false,
    fullSequence: TEST_SEQUENCE,
    onSelectionChange,
    onCursorChange,
    onHighlightedRangeChange,
    onViewCursorChange,
    onContextMenu,
    shiftPreviewRef,
  });

  return (
    <canvas
      ref={selectionCanvasRef}
      data-testid="sequence-canvas-interactive"
      onMouseDown={handlers.handleMouseDown}
      onMouseUp={handlers.handleMouseUp}
      onClick={handlers.handleClick}
      onContextMenu={handlers.handleContextMenu}
    />
  );
}

function clientXForPosition(position: number): number {
  return TEST_CONFIG.marginLeft + position * TEST_CONFIG.charWidth + 1;
}

const LINE_WHITESPACE_Y = 35;
const ORIGINAL_PLATFORM = navigator.platform;

function mockNavigatorPlatform(platform: string): void {
  Object.defineProperty(navigator, 'platform', {
    value: platform,
    configurable: true,
  });
}

describe('useCanvasInteraction secondary-click handling', () => {
  afterEach(() => {
    cleanup();
    mockNavigatorPlatform(ORIGINAL_PLATFORM);
  });

  it('opens the context menu for ctrl+primary click, places the cursor, and preserves the selection payload', () => {
    mockNavigatorPlatform('MacIntel');
    const selection = { start: 2, end: 4 };
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        selection={selection}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = { button: 0, ctrlKey: true, clientX: clientXForPosition(7), clientY: 10 };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);
    fireEvent.contextMenu(canvas, eventInit);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).toHaveBeenCalledOnce();
    expect(onCursorChange).toHaveBeenCalledWith(7);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toEqual(selection);
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({ position: 7 });
  });

  it('preserves the existing right-click context-menu path and places the cursor', () => {
    const selection = { start: 2, end: 4 };
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        selection={selection}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = { button: 2, clientX: clientXForPosition(7), clientY: 10 };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.contextMenu(canvas, eventInit);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).toHaveBeenCalledOnce();
    expect(onCursorChange).toHaveBeenCalledWith(7);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toEqual(selection);
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({ position: 7 });
  });

  it('places the view cursor for ctrl+primary click in read mode', () => {
    mockNavigatorPlatform('MacIntel');
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={false}
        selection={null}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onHighlightedRangeChange={onHighlightedRangeChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = { button: 0, ctrlKey: true, clientX: clientXForPosition(7), clientY: 10 };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);
    fireEvent.contextMenu(canvas, eventInit);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).toHaveBeenCalledOnce();
    expect(onViewCursorChange).toHaveBeenCalledWith(7);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toBeNull();
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({ position: 7 });
  });

  it('extends selection for Ctrl+Shift primary click on Windows instead of treating it as secondary click', () => {
    mockNavigatorPlatform('Win32');
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={false}
        selection={null}
        viewCursor={2}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onHighlightedRangeChange={onHighlightedRangeChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = {
      button: 0,
      ctrlKey: true,
      shiftKey: true,
      clientX: clientXForPosition(7),
      clientY: 10,
    };

    fireEvent.mouseDown(canvas, eventInit);

    expect(onHighlightedRangeChange).toHaveBeenCalledOnce();
    expect(onHighlightedRangeChange).toHaveBeenCalledWith({ start: 2, end: 7 });
    expect(onViewCursorChange).not.toHaveBeenCalled();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it('passes a fresh active highlight range when opening the context menu in read mode', () => {
    const highlightedRange = { start: 2, end: 8 };
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={false}
        selection={null}
        highlightedRange={highlightedRange}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onHighlightedRangeChange={onHighlightedRangeChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = { button: 2, clientX: clientXForPosition(5), clientY: 10 };

    fireEvent.contextMenu(canvas, eventInit);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).toHaveBeenCalledOnce();
    expect(onViewCursorChange).toHaveBeenCalledWith(5);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][1]).toEqual(highlightedRange);
    expect(onContextMenu.mock.calls[0][1]).not.toBe(highlightedRange);
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({ position: 5 });
  });

  it('places the view cursor for right-clicks in whitespace attributed to a sequence line', () => {
    const onSelectionChange = vi.fn();
    const onCursorChange = vi.fn();
    const onHighlightedRangeChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={false}
        selection={null}
        onSelectionChange={onSelectionChange}
        onCursorChange={onCursorChange}
        onHighlightedRangeChange={onHighlightedRangeChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = {
      button: 2,
      clientX: clientXForPosition(7),
      clientY: LINE_WHITESPACE_Y,
    };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.contextMenu(canvas, eventInit);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onCursorChange).not.toHaveBeenCalled();
    expect(onHighlightedRangeChange).not.toHaveBeenCalled();
    expect(onViewCursorChange).toHaveBeenCalledOnce();
    expect(onViewCursorChange).toHaveBeenCalledWith(7);
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({
      isOnNucleotideRow: false,
      position: 7,
    });
  });
});

describe.each([false, true])('Canvas cursor positioning (editable=%s)', (editable) => {
  afterEach(cleanup);

  it.each([
    [5.25, 5],
    [5.49, 5],
    [5.5, 6],
    [5.75, 6],
    [19.75, 20],
    [25, 20],
  ])('places a clicked cursor at the nearer boundary (%s -> %s)', (column, boundary) => {
    const onCursorChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={editable}
        selection={null}
        onSelectionChange={vi.fn()}
        onCursorChange={onCursorChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={vi.fn()}
      />
    );
    const canvas = getByTestId('sequence-canvas-interactive');
    const eventInit = {
      button: 0,
      clientX: TEST_CONFIG.marginLeft + column * TEST_CONFIG.charWidth,
      clientY: 10,
    };

    fireEvent.mouseDown(canvas, eventInit);
    fireEvent.mouseUp(canvas, eventInit);
    fireEvent.click(canvas, eventInit);

    const placedCursor = editable ? onCursorChange : onViewCursorChange;
    expect(placedCursor).toHaveBeenCalledOnce();
    expect(placedCursor).toHaveBeenCalledWith(boundary);
  });

  it('uses the nearer boundary for a context-menu cursor while retaining the clicked base', () => {
    const onCursorChange = vi.fn();
    const onViewCursorChange = vi.fn();
    const onContextMenu = vi.fn();
    const { getByTestId } = render(
      <HookHarness
        editable={editable}
        selection={null}
        onSelectionChange={vi.fn()}
        onCursorChange={onCursorChange}
        onViewCursorChange={onViewCursorChange}
        onContextMenu={onContextMenu}
      />
    );
    fireEvent.contextMenu(getByTestId('sequence-canvas-interactive'), {
      button: 2,
      clientX: TEST_CONFIG.marginLeft + 5.75 * TEST_CONFIG.charWidth,
      clientY: 10,
    });

    expect(editable ? onCursorChange : onViewCursorChange).toHaveBeenCalledWith(6);
    expect(onContextMenu.mock.calls[0][2]).toMatchObject({ position: 5 });
  });
});
