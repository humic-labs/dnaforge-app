/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDITOR_CONFIG } from '@waypoint/workspace-editor';
import { LinkedCameraGroup } from './LinkedCameraGroup';
import {
  createCoordMapping,
  JUNCTION_WORKBENCH_HORIZONTAL_PADDING,
  makeMappingPoint,
  type CoordMappingRow,
} from './coord-mapping';
import { buildJunctionWorkbenchModels, type JunctionWorkbenchRow } from './model';
import {
  type CanvasOp,
  countOp,
  getRecordingLog,
  installRecordingCanvas,
  opsOf,
  uninstallRecordingCanvas,
} from '../../../../../packages/core/workspace-editor/src/testing/recording-canvas-context';
import type { DesignRegion, SequenceDesign } from '../design/types';
import { computeDraftAssembly } from '../design/algorithms/draft-assembly';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';

const VIEWPORT_WIDTH = 720;
const VIEWPORT_HEIGHT = 420;
const SPACER_TEST_COLOR = '#6b7280';

class ImmediateResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width: VIEWPORT_WIDTH,
            height: VIEWPORT_HEIGHT,
            top: 0,
            left: 0,
            bottom: VIEWPORT_HEIGHT,
            right: VIEWPORT_WIDTH,
            toJSON() {
              return {};
            },
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver
    );
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ImmediateResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH;
    },
  });
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 1,
  });
});

beforeEach(() => {
  installRecordingCanvas();
});

afterEach(() => {
  cleanup();
  uninstallRecordingCanvas();
});

describe('LinkedCameraGroup', () => {
  it('renders passive viewers driven by one linked camera scroll object', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const linkedScroll = vi.fn();

    render(<LinkedCameraGroup rows={rows} mapping={mapping} onLinkedScroll={linkedScroll} />);

    await act(async () => {
      await flushFrames();
    });

    expect(screen.getAllByTestId('sequence-viewer-1d')).toHaveLength(3);
    expect(screen.queryAllByTestId('sequence-scrollbar-1d')).toHaveLength(0);
    expect(screen.getByTestId('linked-camera-scrollbar')).toBeVisible();
    const canvases = Array.from(document.querySelectorAll('canvas'));
    expect(canvases).toHaveLength(3);
    for (const canvas of canvases) {
      expect(getRecordingLog(canvas as HTMLCanvasElement).length).toBeGreaterThan(10);
    }

    const before = readLinkedScrollLefts();
    const beforeClearCounts = canvases.map((canvas) =>
      countOp(getRecordingLog(canvas as HTMLCanvasElement), 'clearRect')
    );
    const productViewer = screen.getByTestId('linked-camera-pan-surface-product');
    fireEvent.wheel(productViewer, { deltaY: 60 });

    await act(async () => {
      await flushFrames();
    });

    expect(Number(screen.getByTestId('linked-camera-group').dataset.linkedInputCount)).toBe(0);

    for (let i = 0; i < 120; i++) {
      fireEvent.wheel(productViewer, { deltaX: 2 });
    }

    await act(async () => {
      await flushFrames();
    });
    await act(async () => {
      await flushFrames();
    });

    const after = readLinkedScrollLefts();
    const afterClearCounts = canvases.map((canvas) =>
      countOp(getRecordingLog(canvas as HTMLCanvasElement), 'clearRect')
    );
    const redrawDelta = afterClearCounts.reduce(
      (total, afterCount, index) => total + afterCount - beforeClearCounts[index],
      0
    );
    expect(linkedScroll).toHaveBeenCalled();
    expect(Math.max(...linkedScroll.mock.calls.map((call) => call[0]))).toBeLessThanOrEqual(3);
    expect(Number(screen.getByTestId('linked-camera-group').dataset.linkedFrameCount)).toBe(1);
    expect(Number(screen.getByTestId('linked-camera-group').dataset.linkedInputCount)).toBe(120);
    expect(redrawDelta).toBeLessThanOrEqual(3);
    expect(after.product).toBeGreaterThan(before.product);
    expect(after.left).toBe(after.product);
    expect(after.right).toBe(after.product);
    expect(screen.getByTestId('junction-row-left-source').dataset.rowBp).toBe(
      screen.getByTestId('junction-row-product').dataset.rowBp
    );
    expect(screen.getByTestId('junction-row-right-source').dataset.rowBp).toBe(
      screen.getByTestId('junction-row-product').dataset.rowBp
    );
    expect(screen.getByTestId('junction-row-left-source').dataset.strandCount).toBe('2');
    expect(screen.getByTestId('junction-row-product').dataset.strandCount).toBe('2');
    expect(screen.getByTestId('junction-row-product').dataset.primerCount).toBe('1');
    expect(Number(screen.getByTestId('junction-row-left-source').dataset.mutedColumnCount)).toBe(
      156
    );
    expect(
      hasFillTextPaintedWithColor(getRecordingLog(canvases[0] as HTMLCanvasElement), '#9ca3af')
    ).toBe(true);
  });

  it('does not advance the linked scroll object past the 1D viewer extent', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });

    render(<LinkedCameraGroup rows={rows} mapping={mapping} />);

    await act(async () => {
      await flushFrames();
    });

    const productViewer = screen.getByTestId('linked-camera-pan-surface-product');
    for (let i = 0; i < 60; i++) {
      fireEvent.wheel(productViewer, { deltaX: 100 });
    }

    await act(async () => {
      await flushFrames();
    });

    const group = screen.getByTestId('linked-camera-group');
    const expectedMax =
      rows[0].sequence.length * DEFAULT_EDITOR_CONFIG.charWidth +
      JUNCTION_WORKBENCH_HORIZONTAL_PADDING * 2 -
      VIEWPORT_WIDTH;

    expect(Number(group.dataset.linkedPxPerBase)).toBe(DEFAULT_EDITOR_CONFIG.charWidth);
    expect(Number(group.dataset.linkedMaxSharedScrollLeft)).toBe(expectedMax);
    expect(readLinkedScrollLefts()).toEqual({
      left: expectedMax,
      product: expectedMax,
      right: expectedMax,
    });

    for (let i = 0; i < 10; i++) {
      fireEvent.wheel(productViewer, { deltaX: 100 });
    }

    await act(async () => {
      await flushFrames();
    });

    expect(readLinkedScrollLefts()).toEqual({
      left: expectedMax,
      product: expectedMax,
      right: expectedMax,
    });
  });

  it('paints the spacer band on the product row only — source lanes run through the junction', async () => {
    const design = createSpacerDesign();
    const draft = computeDraftAssembly(design);
    const model = buildJunctionWorkbenchModels(
      {
        ...design,
        homologyRegions: draft.homologyRegions,
        designPrimers: draft.designPrimers,
      },
      { maxWindowBp: 500 }
    )[0];
    const rows = model.rows.map((modelRow) => ({ ...modelRow, primers: [] }));
    const [leftRow, rightRow, productRow] = rows;
    const anchor = productRow.anchorRowPosition;

    render(<LinkedCameraGroup rows={rows} mapping={model.mapping} />);

    await act(async () => {
      await flushFrames();
    });

    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
    expect(canvases).toHaveLength(3);
    const leftLog = getRecordingLog(canvases[0]);
    const rightLog = getRecordingLog(canvases[1]);
    const productLog = getRecordingLog(canvases[2]);

    expect(productRow.spacerColumns).toEqual([anchor, anchor + 1, anchor + 2, anchor + 3]);
    expect(productRow.sequence.slice(anchor, anchor + 4)).toBe('AAGC');

    expect(leftRow.spacerColumns).toEqual([]);
    expect(rightRow.spacerColumns).toEqual([]);
    expect(
      hasColumnRectPaintedWithColor(leftLog, rowPositionAtBioCol(leftRow, 0), SPACER_TEST_COLOR)
    ).toBe(false);
    expect(
      hasColumnRectPaintedWithColor(rightLog, rowPositionAtBioCol(rightRow, 0), SPACER_TEST_COLOR)
    ).toBe(false);

    expect(sequenceSliceByBioCol(leftRow, 0, 4)).toBe('G'.repeat(4));
    expect(sequenceSliceByBioCol(rightRow, 0, 4)).toBe('C'.repeat(4));
    expect(sequenceSliceByBioCol(rightRow, 4, 8)).toBe(design.regions[1].sequence.slice(0, 4));

    expect(textsAtColumn(productLog, anchor, 'A')).toContain('A');
    expect(textsAtColumn(productLog, anchor + 1, 'A')).toContain('A');
    expect(textsAtColumn(productLog, anchor + 2, 'G')).toContain('G');
    expect(textsAtColumn(productLog, anchor + 3, 'C')).toContain('C');

    expect(textsAtColumn(leftLog, rowPositionAtBioCol(leftRow, 0), 'G')).toContain('G');
    expect(textsAtColumn(rightLog, rowPositionAtBioCol(rightRow, 0), 'C')).toContain('C');
    expect(
      textsAtColumn(rightLog, rowPositionAtBioCol(rightRow, 4), design.regions[1].sequence[0])
    ).toContain(design.regions[1].sequence[0]);
  });

  it('renders manifest handles on source rows and primer bars', async () => {
    const rows = makeRows();
    rows[1] = {
      ...rows[1],
      primers: [
        {
          id: 'right-row-primer',
          sourcePrimerId: 'primer-source',
          name: 'Right primer',
          start: 44,
          end: 64,
          direction: 'forward',
          bases: 'A'.repeat(20),
          tm: 60,
          gc: 50,
          mismatches: [],
          overhangLength: 4,
        },
      ],
    };
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const fields: AssemblyWorkbenchEditableField[] = [
      {
        id: 'source-field',
        kind: 'sourceContributionBoundary',
        label: 'Source boundary',
        target: { junctionIndex: 0, regionId: 'r1', side: 'downstream' },
        value: 120,
        units: 'bp',
        range: { min: 80, max: 180, step: 1, largeStep: 10 },
        anchors: [{ rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'boundary' }],
        command: {
          type: 'setSourceContributionBoundary',
          payload: { regionId: 'r1', side: 'downstream', sourcePosition: 120 },
          valueKey: 'sourcePosition',
        },
        constraints: [],
      },
      {
        id: 'primer-field',
        kind: 'primerPbs',
        label: 'Right primer PBS',
        target: {
          junctionIndex: 0,
          primerId: 'primer-source',
          fragmentIndex: 1,
          direction: 'forward',
          side: 'right',
        },
        value: 16,
        units: 'bp',
        range: { min: 10, max: 60, step: 1, largeStep: 5 },
        anchors: [
          { rowId: 'right', rowKind: 'right-source', bioCol: 4, role: 'pbs-start' },
          { rowId: 'right', rowKind: 'right-source', bioCol: 20, role: 'pbs-end' },
        ],
        command: {
          type: 'setPrimerPbsLength',
          payload: { primerId: 'primer-source', length: 16 },
          valueKey: 'length',
        },
        constraints: [],
      },
    ];

    render(<LinkedCameraGroup rows={rows} mapping={mapping} editableFields={fields} />);

    await act(async () => {
      await flushFrames();
    });
    await act(async () => {
      await flushFrames();
    });

    expect(screen.queryByTestId('junction-field-handle-sourceContributionBoundary-boundary')).toBe(
      null
    );
    const primerHandle = screen.getByTestId('junction-field-handle-primerPbs-pbs-end');
    expect(primerHandle).toBeVisible();
    expect(primerHandle).toHaveAttribute('data-field-id', 'primer-field');
    expect(screen.queryByTestId('junction-primer-preview-primerPbs-pbs-end')).toBeNull();
  });

  it('uses the product non-handle viewer surface as the shared-camera drag surface', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const fields = [sourceBoundaryField()];

    render(<LinkedCameraGroup rows={rows} mapping={mapping} editableFields={fields} />);

    await act(async () => {
      await flushFrames();
    });

    const surface = screen.getByTestId('linked-camera-pan-surface-product');
    const before = readLinkedScrollLefts();
    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: 320 });
    fireEvent.mouseMove(surface, { buttons: 1, clientX: 260 });
    fireEvent.mouseUp(surface, { button: 0, buttons: 0, clientX: 260 });

    await act(async () => {
      await flushFrames();
    });

    const after = readLinkedScrollLefts();
    expect(surface).toHaveAttribute('data-linked-pan-dragging', 'false');
    expect(Number(screen.getByTestId('linked-camera-group').dataset.linkedInputCount)).toBe(1);
    expect(after.product).toBeGreaterThan(before.product);
    expect(after.left).toBe(after.product);
    expect(after.right).toBe(after.product);

    expect(screen.queryByTestId('junction-field-handle-sourceContributionBoundary-boundary')).toBe(
      null
    );
  });

  it('drags a source template viewport as a source-boundary preview without moving fixed axis chrome', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const preview = vi.fn();
    const commit = vi.fn();
    const fields = [sourceBoundaryField()];

    render(
      <LinkedCameraGroup
        rows={rows}
        mapping={mapping}
        editableFields={fields}
        onFieldPreview={preview}
        onFieldCommit={commit}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const group = screen.getByTestId('linked-camera-group');
    const surface = screen.getByTestId('linked-camera-pan-surface-left-source');
    const visualLayers = {
      left: screen.getByTestId('linked-camera-source-register-visual-layer-left-source'),
      right: screen.getByTestId('linked-camera-source-register-visual-layer-right-source'),
      product: screen.getByTestId('linked-camera-source-register-visual-layer-product'),
    };
    const contentLayers = {
      left: screen.getByTestId('linked-camera-source-register-content-layer-left-source'),
      right: screen.getByTestId('linked-camera-source-register-content-layer-right-source'),
      product: screen.getByTestId('linked-camera-source-register-content-layer-product'),
    };
    const productOwnerLayers = {
      left: screen.getByTestId('linked-camera-source-register-product-owner-layer-left'),
      right: screen.getByTestId('linked-camera-source-register-product-owner-layer-right'),
    };
    const before = readLinkedScrollLefts();
    const inputCountBefore = Number(group.dataset.linkedInputCount);
    const pxPerBase = Number(group.dataset.linkedPxPerBase);

    expect(surface).toHaveAttribute('data-linked-drag-action', 'source-boundary');
    expect(surface).toHaveAttribute('data-linked-source-register-field-id', 'source-field');
    expect(surface).toHaveClass('cursor-grab');
    const sourcePointer = surface.querySelector('[data-testid="sequence-viewer-1d-pointer"]');
    expect(sourcePointer).toBeInstanceOf(HTMLDivElement);
    expect((sourcePointer as HTMLDivElement).style.cursor).toBe('inherit');
    fireEvent.pointerMove(sourcePointer!, { pointerId: 4, clientX: 320, clientY: 64 });
    expect((sourcePointer as HTMLDivElement).style.cursor).toBe('inherit');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: 320, clientY: 64 });
    expect(surface).toHaveAttribute('data-linked-source-register-dragging', 'true');
    expect(visualLayers.left.style.transform).toBe('');
    expect(visualLayers.right.style.transform).toBe('');
    expect(visualLayers.product.style.transform).toBe('');
    expectSourceRegisterContentOffsets(contentLayers, { left: '0', right: '0', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: 320 + pxPerBase * 2 + 3,
      clientY: 64,
    });
    expect(preview).toHaveBeenLastCalledWith(fields[0], 118);
    expect(surface).toHaveAttribute('data-linked-source-register-value', '118');
    expect(surface).toHaveAttribute('data-linked-source-register-rendered-value', '120');
    expect(surface).toHaveAttribute('data-linked-source-register-visual-offset-px', '19');
    expect(surface).toHaveAttribute('data-linked-source-register-presentation-offset-px', '19');
    expect(visualLayers.left.style.transform).toBe('');
    expect(visualLayers.right.style.transform).toBe('');
    expect(visualLayers.product.style.transform).toBe('');
    expectSourceRegisterContentOffsets(contentLayers, { left: '19', right: '0', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '19', right: '0' });

    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: 320 - pxPerBase * 4 - 3,
      clientY: 64,
    });
    expect(preview).toHaveBeenLastCalledWith(fields[0], 124);
    expect(surface).toHaveAttribute('data-linked-source-register-move-count', '2');
    expect(surface).toHaveAttribute('data-linked-source-register-value', '124');
    expect(surface).toHaveAttribute('data-linked-source-register-rendered-value', '120');
    expect(surface).toHaveAttribute('data-linked-source-register-visual-offset-px', '-35');
    expect(surface).toHaveAttribute('data-linked-source-register-presentation-offset-px', '-35');
    expect(visualLayers.left.style.transform).toBe('');
    expect(visualLayers.right.style.transform).toBe('');
    expect(visualLayers.product.style.transform).toBe('');
    expectSourceRegisterContentOffsets(contentLayers, { left: '-35', right: '0', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '-35', right: '0' });

    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: 320 - pxPerBase * 4,
      clientY: 64,
    });

    expect(commit).toHaveBeenCalledWith(fields[0], 124);
    expect(surface).toHaveAttribute('data-linked-source-register-dragging', 'false');
    expect(surface).toHaveAttribute('data-linked-source-register-visual-offset-px', '0');
    expectVisualTransforms(visualLayers, '');
    expectSourceRegisterContentOffsets(contentLayers, { left: '0', right: '0', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });
    expect(Number(group.dataset.linkedInputCount)).toBe(inputCountBefore);
    expect(readLinkedScrollLefts()).toEqual(before);
  });

  it('scopes right-template viewport drag to the right source and right product owner', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const commit = vi.fn();
    const fields = [
      sourceBoundaryField({
        id: 'right-source-field',
        rowId: 'right',
        value: 220,
        min: 180,
        max: 260,
      }),
    ];

    render(
      <LinkedCameraGroup
        rows={rows}
        mapping={mapping}
        editableFields={fields}
        onFieldCommit={commit}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const group = screen.getByTestId('linked-camera-group');
    const surface = screen.getByTestId('linked-camera-pan-surface-right-source');
    const contentLayers = {
      left: screen.getByTestId('linked-camera-source-register-content-layer-left-source'),
      right: screen.getByTestId('linked-camera-source-register-content-layer-right-source'),
      product: screen.getByTestId('linked-camera-source-register-content-layer-product'),
    };
    const productOwnerLayers = {
      left: screen.getByTestId('linked-camera-source-register-product-owner-layer-left'),
      right: screen.getByTestId('linked-camera-source-register-product-owner-layer-right'),
    };
    const before = readLinkedScrollLefts();
    const inputCountBefore = Number(group.dataset.linkedInputCount);
    const pxPerBase = Number(group.dataset.linkedPxPerBase);

    expect(surface).toHaveAttribute('data-linked-drag-action', 'source-boundary');
    expect(surface).toHaveAttribute('data-linked-source-register-field-id', 'right-source-field');

    fireEvent.mouseDown(surface, { button: 0, buttons: 1, clientX: 320, clientY: 64 });
    fireEvent.mouseMove(surface, {
      buttons: 1,
      clientX: 320 + pxPerBase * 2 + 3,
      clientY: 64,
    });

    expect(surface).toHaveAttribute('data-linked-source-register-value', '218');
    expect(surface).toHaveAttribute('data-linked-source-register-rendered-value', '220');
    expect(surface).toHaveAttribute('data-linked-source-register-presentation-offset-px', '19');
    expectSourceRegisterContentOffsets(contentLayers, { left: '0', right: '19', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '19' });

    fireEvent.mouseUp(surface, {
      button: 0,
      buttons: 0,
      clientX: 320 + pxPerBase * 2 + 3,
      clientY: 64,
    });

    expect(commit).toHaveBeenCalledWith(fields[0], 218);
    expectSourceRegisterContentOffsets(contentLayers, { left: '0', right: '0', product: '0' });
    expectProductOwnerPreviewOffsets(productOwnerLayers, { left: '0', right: '0' });
    expect(Number(group.dataset.linkedInputCount)).toBe(inputCountBefore);
    expect(readLinkedScrollLefts()).toEqual(before);
  });

  it('commits a source-boundary drag even when pointer capture was lost during preview rerender', async () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const commit = vi.fn();
    const fields = [sourceBoundaryField()];

    render(
      <LinkedCameraGroup
        rows={rows}
        mapping={mapping}
        editableFields={fields}
        onFieldCommit={commit}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const surface = screen.getByTestId('linked-camera-pan-surface-left-source');
    const element = surface as HTMLDivElement & {
      setPointerCapture: (pointerId: number) => void;
      hasPointerCapture: (pointerId: number) => boolean;
      releasePointerCapture: (pointerId: number) => void;
    };
    element.setPointerCapture = vi.fn();
    element.hasPointerCapture = vi.fn(() => true);
    element.releasePointerCapture = vi.fn(() => {
      throw new Error('Pointer capture was already lost.');
    });

    const pxPerBase =
      Number(screen.getByTestId('linked-camera-group').dataset.linkedPxPerBase) ||
      DEFAULT_EDITOR_CONFIG.charWidth;
    await act(async () => {
      dispatchPointerEvent(surface, 'pointerdown', {
        pointerId: 9,
        pointerType: 'mouse',
        button: 0,
        buttons: 1,
        clientX: 320,
        clientY: 64,
      });
      dispatchPointerEvent(surface, 'pointermove', {
        pointerId: 9,
        pointerType: 'mouse',
        buttons: 1,
        clientX: 320 + pxPerBase * 2,
        clientY: 64,
      });
      dispatchPointerEvent(surface, 'pointerup', {
        pointerId: 9,
        pointerType: 'mouse',
        button: 0,
        buttons: 0,
        clientX: 320 + pxPerBase * 2,
        clientY: 64,
      });
    });

    expect(commit).toHaveBeenCalledWith(fields[0], 118);
    expect(element.releasePointerCapture).toHaveBeenCalledWith(9);
  });

  it('projects product overlap constraints as selection-style cursor ranges', async () => {
    const rows = makeRows();
    rows[2] = {
      ...rows[2],
      spacerColumns: [40, 41, 42],
      constraints: [
        {
          kind: 'homology-width',
          startBioCol: -2,
          endBioCol: 7,
          editable: true,
          label: '9 bp crossover',
        },
      ],
    };
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const preview = vi.fn();
    const commit = vi.fn();
    const fields = [
      homologyArmField({ id: 'left-homology', side: 'left', value: 5, oppositeValue: 4 }),
      homologyArmField({ id: 'right-homology', side: 'right', value: 4, oppositeValue: 5 }),
    ];

    render(
      <LinkedCameraGroup
        rows={rows}
        mapping={mapping}
        editableFields={fields}
        onFieldPreview={preview}
        onFieldCommit={commit}
      />
    );

    await act(async () => {
      await flushFrames();
    });

    const surface = screen.getByTestId('linked-camera-pan-surface-product');
    expect(surface).toHaveAttribute('data-linked-selection-start', '38');
    expect(surface).toHaveAttribute('data-linked-selection-end', '46');

    expect(screen.queryByTestId('junction-assembly-highlight-segment-product-left')).toBeNull();
    expect(screen.queryByTestId('junction-assembly-highlight-segment-product-right')).toBeNull();
    const highlightStartCursor = screen.getByTestId(
      'junction-assembly-highlight-cursor-product-start'
    );
    const highlightEndCursor = screen.getByTestId('junction-assembly-highlight-cursor-product-end');
    expect(highlightStartCursor).toHaveAttribute('data-highlight-cursor-passive', 'true');
    expect(highlightStartCursor).toHaveAttribute('data-highlight-cursor-hidden', 'true');
    expect(highlightStartCursor).toHaveClass('pointer-events-none');
    expect(highlightStartCursor).toHaveStyle({
      top: '80px',
      width: '0px',
      height: '52px',
    });
    expect(highlightStartCursor.style.backgroundColor).toBe('transparent');
    expect(highlightEndCursor).toHaveAttribute('data-highlight-cursor-hidden', 'true');

    const leftOverlapHandle = screen.getByTestId('junction-field-handle-homologyArm-tail-start');
    const rightOverlapHandle = screen.getByTestId('junction-field-handle-homologyArm-tail-end');
    expect(leftOverlapHandle).toBeVisible();
    expect(rightOverlapHandle).toBeVisible();
    expect(leftOverlapHandle).toHaveAttribute('data-field-id', 'left-homology');
    expect(leftOverlapHandle).toHaveAttribute('data-handle-variant', 'overlap');
    expect(leftOverlapHandle).toHaveAttribute('data-handle-dock', 'bottom');
    expect(leftOverlapHandle).toHaveStyle({
      top: '110px',
      height: '22px',
      color: 'color-mix(in srgb, hsl(var(--color-fg)) 80%, hsl(var(--color-fg-muted)) 20%)',
    });
    expect(screen.getByTestId('junction-field-handle-line-homologyArm-tail-start')).toHaveStyle({
      width: '1px',
      top: '-30px',
      height: '40px',
      boxShadow: 'none',
    });
    expect(screen.getByTestId('junction-field-handle-grip-homologyArm-tail-start')).toBeVisible();

    const pxPerBase = Number(screen.getByTestId('linked-camera-group').dataset.linkedPxPerBase);
    const initialStartLeft = Number.parseFloat(highlightStartCursor.style.left);
    const initialEndLeft = Number.parseFloat(highlightEndCursor.style.left);
    fireEvent.mouseDown(leftOverlapHandle, { button: 0, buttons: 1, clientX: 200 });
    fireEvent.mouseMove(window, { buttons: 1, clientX: 200 - pxPerBase * 2 });
    expect(preview).not.toHaveBeenCalled();
    expect(surface).toHaveAttribute('data-live-overlap-start-bio-col', '-4');
    expect(surface).toHaveAttribute('data-live-overlap-end-bio-col', '7');
    expect(surface).toHaveAttribute('data-live-overlap-spacer-length', '3');
    expect(surface).toHaveAttribute('data-live-overlap-crossover-length', '11');
    expect(highlightStartCursor).toHaveAttribute('data-live-overlap-bio-col', '-4');
    expect(highlightStartCursor.style.left).toBe(`${initialStartLeft - pxPerBase * 2}px`);
    expect(highlightEndCursor).toHaveAttribute('data-live-overlap-bio-col', '7');
    expect(highlightEndCursor.style.left).toBe(`${initialEndLeft}px`);
    fireEvent.mouseUp(window, { button: 0, buttons: 0, clientX: 200 - pxPerBase * 2 });

    expect(commit).toHaveBeenCalledWith(fields[0], 7);
    await act(async () => {
      await flushFrames();
    });
    expect(surface).not.toHaveAttribute('data-live-overlap-preview-active');

    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
    const productLog = getRecordingLog(canvases[2]);
    expect(hasFillRectPaintedWithColor(productLog, 'rgb(255, 255, 200)')).toBe(false);
  });
});

function readLinkedScrollLefts() {
  return {
    left: Number(screen.getByTestId('junction-row-left-source').dataset.linkedScrollLeft),
    product: Number(screen.getByTestId('junction-row-product').dataset.linkedScrollLeft),
    right: Number(screen.getByTestId('junction-row-right-source').dataset.linkedScrollLeft),
  };
}

function expectVisualTransforms(
  layers: Record<string, HTMLElement>,
  expectedTransform: string
): void {
  for (const layer of Object.values(layers)) {
    if (expectedTransform === '') {
      expect(layer.style.transform).toBe('');
    } else {
      expect(layer.style.transform).toBe(expectedTransform);
    }
  }
}

function expectSourceRegisterContentOffsets(
  layers: Record<string, HTMLElement>,
  expectedOffsetPxByLayer: Record<string, string>
): void {
  for (const [name, layer] of Object.entries(layers)) {
    const expectedOffsetPx = expectedOffsetPxByLayer[name] ?? '0';
    expect(layer.dataset.linkedSourceRegisterContentOffsetPx).toBe(expectedOffsetPx);
    if (expectedOffsetPx === '0') {
      expect(layer.style.transform).toBe('');
    } else {
      expect(layer.style.transform).toBe(`translate3d(${expectedOffsetPx}px, 0px, 0px)`);
    }
  }
}

function expectProductOwnerPreviewOffsets(
  layers: Record<string, HTMLElement>,
  expectedOffsetPxByLayer: Record<string, string>
): void {
  for (const [name, layer] of Object.entries(layers)) {
    const expectedOffsetPx = expectedOffsetPxByLayer[name] ?? '0';
    expect(layer.dataset.linkedSourceRegisterProductOwnerOffsetPx).toBe(expectedOffsetPx);
    expect(layer.dataset.linkedSourceRegisterProductOwnerActive).toBe(
      expectedOffsetPx === '0' ? 'false' : 'true'
    );
    const content = layer.querySelector<HTMLElement>(
      '[data-linked-source-register-product-owner-content="true"]'
    );
    expect(content).not.toBeNull();
    if (expectedOffsetPx === '0') {
      expect(content?.style.transform).toBe('');
    } else {
      expect(content?.style.transform).toBe(`translate3d(${expectedOffsetPx}px, 0px, 0px)`);
    }
  }
}

function dispatchPointerEvent(
  target: HTMLElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: MouseEventInit & { pointerId: number; pointerType?: string }
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId });
  Object.defineProperty(event, 'pointerType', { value: init.pointerType ?? 'mouse' });
  target.dispatchEvent(event);
}

function makeRows(): JunctionWorkbenchRow[] {
  return [
    row('left', 'left-source', 40),
    row('right', 'right-source', 40),
    row('product', 'product', 40),
  ];
}

function sourceBoundaryField({
  id = 'source-field',
  rowId = 'left',
  value = 120,
  min = 80,
  max = 180,
}: {
  id?: string;
  rowId?: 'left' | 'right';
  value?: number;
  min?: number;
  max?: number;
} = {}): AssemblyWorkbenchEditableField {
  const rowKind = rowId === 'left' ? 'left-source' : 'right-source';
  const side = rowId === 'left' ? 'downstream' : 'upstream';
  const regionId = rowId === 'left' ? 'r1' : 'r2';
  return {
    id,
    kind: 'sourceContributionBoundary',
    label: 'Source boundary',
    target: { junctionIndex: 0, regionId, side },
    value,
    units: 'bp',
    range: { min, max, step: 1, largeStep: 10 },
    anchors: [{ rowId, rowKind, bioCol: 0, role: 'boundary' }],
    command: {
      type: 'setSourceContributionBoundary',
      payload: { regionId, side, sourcePosition: value },
      valueKey: 'sourcePosition',
    },
    constraints: [],
  };
}

function homologyArmField({
  id,
  side,
  value,
  oppositeValue,
}: {
  id: string;
  side: 'left' | 'right';
  value: number;
  oppositeValue: number;
}): AssemblyWorkbenchEditableField {
  const rowId = side === 'left' ? 'left' : 'right';
  const rowKind = side === 'left' ? 'left-source' : 'right-source';
  const encoding =
    side === 'left'
      ? { onLeft: value, onRight: oppositeValue }
      : { onLeft: oppositeValue, onRight: value };
  return {
    id,
    kind: 'homologyArm',
    label: `${side} homology`,
    target: { junctionIndex: 0, side },
    value,
    units: 'bp',
    range: { min: 0, max: 12, step: 1, largeStep: 5 },
    anchors: [
      {
        rowId,
        rowKind,
        bioCol: side === 'left' ? -value : 0,
        role: 'tail-start',
      },
      {
        rowId,
        rowKind,
        bioCol: side === 'left' ? 0 : value,
        role: 'tail-end',
      },
    ],
    command: {
      type: 'setHomologyEncoding',
      payload: { junctionIndex: 0, encoding },
      valueKey: side === 'left' ? 'encoding.onLeft' : 'encoding.onRight',
    },
    constraints: [],
  };
}

function row(
  id: string,
  kind: CoordMappingRow['kind'],
  anchorRowPosition: number
): JunctionWorkbenchRow {
  const sequence = 'ACGT'.repeat(40);
  return {
    id,
    kind,
    label: id,
    sequence,
    coordinateStart: 0,
    anchorRowPosition,
    annotations: [],
    primers:
      kind === 'product'
        ? [
            {
              id: 'primer-1',
              name: 'Primer 1',
              start: anchorRowPosition - 8,
              end: anchorRowPosition + 12,
              direction: 'forward',
              bases: 'ACGTACGTACGTACGTACGT',
              tm: 60,
              gc: 50,
              mismatches: [],
            },
          ]
        : [],
    points: Array.from({ length: sequence.length }, (_, rowPosition) =>
      makeMappingPoint(id, rowPosition, rowPosition - anchorRowPosition, rowPosition, 'valid')
    ),
    ...(kind === 'left-source' || kind === 'right-source'
      ? {
          visibleColumns: Array.from({ length: sequence.length }, (_, index) => index),
          contributingColumns: [38, 39, 40, 41],
          mutedColumns: Array.from({ length: sequence.length }, (_, index) => index).filter(
            (index) => index < 38 || index > 41
          ),
        }
      : {}),
  };
}

async function flushFrames() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function hasFillTextPaintedWithColor(log: CanvasOp[], color: string): boolean {
  let fillStyle: unknown = null;
  for (const op of log) {
    if (op.op === 'set' && op.prop === 'fillStyle') {
      fillStyle = op.value;
      continue;
    }
    if (op.op === 'fillText' && op.text.trim().length > 0 && fillStyle === color) {
      return true;
    }
  }
  return false;
}

function textsAtColumn(log: CanvasOp[], column: number, expectedText: string): string[] {
  const x =
    JUNCTION_WORKBENCH_HORIZONTAL_PADDING +
    column * DEFAULT_EDITOR_CONFIG.charWidth +
    DEFAULT_EDITOR_CONFIG.charWidth / 2;
  return opsOf(log, 'fillText')
    .filter((op) => Math.abs(op.x - x) < 0.01)
    .map((op) => op.text)
    .filter((text) => text === expectedText);
}

function hasColumnRectPaintedWithColor(log: CanvasOp[], column: number, color: string): boolean {
  const x = JUNCTION_WORKBENCH_HORIZONTAL_PADDING + column * DEFAULT_EDITOR_CONFIG.charWidth;
  let fillStyle: unknown = null;
  for (const op of log) {
    if (op.op === 'set' && op.prop === 'fillStyle') {
      fillStyle = op.value;
      continue;
    }
    if (
      op.op === 'fillRect' &&
      fillStyle === color &&
      Math.abs(op.x - x) < 0.01 &&
      Math.abs(op.w - DEFAULT_EDITOR_CONFIG.charWidth) < 0.01
    ) {
      return true;
    }
  }
  return false;
}

function pointAtBioCol(row: JunctionWorkbenchRow, bioCol: number) {
  const point = row.points.find((item) => item.bioCol === bioCol);
  if (!point) throw new Error(`Missing bioCol ${bioCol} in row ${row.id}`);
  return point;
}

function rowPositionAtBioCol(row: JunctionWorkbenchRow, bioCol: number): number {
  return pointAtBioCol(row, bioCol).rowPosition;
}

function sequenceSliceByBioCol(
  row: JunctionWorkbenchRow,
  startBioCol: number,
  endBioCol: number
): string {
  let sequence = '';
  for (let bioCol = startBioCol; bioCol < endBioCol; bioCol++) {
    sequence += row.sequence[rowPositionAtBioCol(row, bioCol)] ?? '';
  }
  return sequence;
}

function hasFillRectPaintedWithColor(log: CanvasOp[], color: string): boolean {
  let fillStyle: unknown = null;
  for (const op of log) {
    if (op.op === 'set' && op.prop === 'fillStyle') {
      fillStyle = op.value;
      continue;
    }
    if (op.op === 'fillRect' && fillStyle === color) return true;
  }
  return false;
}

function createSpacerDesign(): SequenceDesign {
  const now = new Date('2026-04-26T00:00:00.000Z');
  return {
    id: 'linked-camera-spacer-design',
    name: 'Linked Camera Spacer Design',
    topology: 'circular',
    regions: [
      spacerRegion('left', 'ATGCGTAC'.repeat(100)),
      spacerRegion('right', 'GGCATACC'.repeat(100)),
    ],
    spacers: [{ id: 'spacer-0', junctionIndex: 0, sequence: 'AAGC' }],
    version: 0,
    assemblyState: 'drafting',
    validationErrors: [],
    proposedPlans: [],
    status: 'draft',
    assemblyMethod: 'gibson',
    backboneSequenceId: null,
    defaultHomologyLength: 30,
    homologyRegions: [],
    goldenGateJunctions: undefined,
    designPrimers: [],
    selectedJunctionIndex: null,
    scrollToPosition: null,
    highlightRange: null,
    createdAt: now,
    updatedAt: now,
  };
}

function spacerRegion(id: string, sequence: string): DesignRegion {
  const upstream = `${id === 'left' ? 'T' : 'C'}`.repeat(320);
  const downstream = `${id === 'left' ? 'G' : 'A'}`.repeat(320);
  return {
    id,
    sourceSequenceId: id,
    sourceSequenceName: id,
    sourceStart: upstream.length,
    sourceEnd: upstream.length + sequence.length,
    sequence,
    annotations: [],
    sourceSequence: upstream + sequence + downstream,
    sourceAnnotations: [],
    sourceIsCircular: false,
    sourceType: 'pcr',
  };
}
