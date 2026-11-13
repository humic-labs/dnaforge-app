import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_EDITOR_CONFIG } from '@waypoint/workspace-editor';
import {
  LINKED_CAMERA_DEFAULT_PX_PER_BASE,
  LinkedCameraController,
} from './LinkedCameraController';
import {
  createCoordMapping,
  JUNCTION_WORKBENCH_HORIZONTAL_PADDING,
  makeMappingPoint,
  type CoordMappingRow,
} from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';

let rafCallbacks: FrameRequestCallback[] = [];

beforeEach(() => {
  rafCallbacks = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinkedCameraController', () => {
  it('uses the same 100% px/base baseline as SequenceViewer1D', () => {
    expect(LINKED_CAMERA_DEFAULT_PX_PER_BASE).toBe(DEFAULT_EDITOR_CONFIG.charWidth);
  });

  it('coalesces wheel bursts into one shared camera frame for all rows', () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const controller = new LinkedCameraController({ rows, mapping, initialCameraBioCol: 0 });
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.setViewportWidth(720);
    listener.mockClear();

    for (let i = 0; i < 120; i++) {
      controller.panPixels(2);
    }

    expect(rafCallbacks).toHaveLength(1);
    expect(controller.getSnapshot().frameCount).toBe(0);

    rafCallbacks.shift()?.(performance.now());

    const snapshot = controller.getSnapshot();
    expect(snapshot.frameCount).toBe(1);
    expect(snapshot.inputEventCount).toBe(120);
    expect(snapshot.lastRedrawCount).toBe(3);
    expect(snapshot.lastFrameDurationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.maxFrameDurationMs).toBe(snapshot.lastFrameDurationMs);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(snapshot.scrollLeftByRowId.product).toBeGreaterThan(0);
    expect(snapshot.scrollLeftByRowId.left).toBe(snapshot.scrollLeftByRowId.product);
    expect(snapshot.scrollLeftByRowId.right).toBe(snapshot.scrollLeftByRowId.product);
  });

  it('clamps shared scroll to the viewer-compatible linear sequence extent', () => {
    const rows = makeRows();
    const mapping = createCoordMapping('gibson', { rows, maxWindowBp: 160 });
    const controller = new LinkedCameraController({ rows, mapping, initialCameraBioCol: 0 });
    controller.setViewportWidth(720);

    controller.panPixels(100_000);
    rafCallbacks.shift()?.(performance.now());

    const expectedMax = Math.max(
      0,
      rows[0].sequence.length * DEFAULT_EDITOR_CONFIG.charWidth +
        JUNCTION_WORKBENCH_HORIZONTAL_PADDING * 2 -
        720
    );
    const snapshot = controller.getSnapshot();
    expect(snapshot.maxSharedScrollLeft).toBe(expectedMax);
    expect(snapshot.sharedScrollLeft).toBe(expectedMax);

    controller.panPixels(100_000);
    rafCallbacks.shift()?.(performance.now());

    const afterExtraInput = controller.getSnapshot();
    expect(afterExtraInput.sharedScrollLeft).toBe(expectedMax);
    expect(afterExtraInput.scrollLeftByRowId.left).toBe(expectedMax);
    expect(afterExtraInput.scrollLeftByRowId.product).toBe(expectedMax);
    expect(afterExtraInput.scrollLeftByRowId.right).toBe(expectedMax);
  });
});

function makeRows(): JunctionWorkbenchRow[] {
  return [
    row('left', 'left-source', 40),
    row('product', 'product', 40),
    row('right', 'right-source', 40),
  ];
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
    points: Array.from({ length: sequence.length }, (_, rowPosition) =>
      makeMappingPoint(id, rowPosition, rowPosition - anchorRowPosition, rowPosition, 'valid')
    ),
  };
}
