// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { AssemblyWorkbenchEditableField } from '../AssemblyWorkbenchContract';
import {
  beginSourceRegisterGesture,
  cancelSourceRegisterGesture,
  commitSourceRegisterGesture,
  sourceRegisterPresentationOffsetPx,
  updateSourceRegisterRenderedValue,
  updateSourceRegisterGesture,
  valueForVisualOffset,
} from './SourceRegisterGesture';

describe('SourceRegisterGesture', () => {
  it('keeps continuous visual motion separate from snapped source-boundary values', () => {
    let state = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 760, min: 700, max: 900 }),
      pointerId: 7,
      startClientX: 400,
      pxPerBase: 8,
    });

    let update = updateSourceRegisterGesture(state, 403);
    state = update.state;
    expect(update.visualOffsetChanged).toBe(true);
    expect(update.snappedValueChanged).toBe(false);
    expect(state.visualOffsetPx).toBe(3);
    expect(state.latestValue).toBe(760);

    update = updateSourceRegisterGesture(state, 405);
    state = update.state;
    expect(update.visualOffsetChanged).toBe(true);
    expect(update.snappedValueChanged).toBe(true);
    expect(state.visualOffsetPx).toBe(5);
    expect(state.latestValue).toBe(759);
    expect(state.renderedValue).toBe(760);
  });

  it('keeps snap-boundary presentation continuous until the snapped model has rendered', () => {
    let state = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 760, min: 700, max: 900 }),
      pointerId: 7,
      startClientX: 400,
      pxPerBase: 8,
    });

    state = updateSourceRegisterGesture(state, 405).state;
    expect(state.latestValue).toBe(759);
    expect(state.renderedValue).toBe(760);
    expect(sourceRegisterPresentationOffsetPx(state)).toBe(5);

    state = updateSourceRegisterRenderedValue(state, 759);
    expect(state.latestValue).toBe(759);
    expect(state.renderedValue).toBe(759);
    expect(sourceRegisterPresentationOffsetPx(state)).toBe(-3);
  });

  it('supports a same-pointer bidirectional drag without moving the registered camera', () => {
    let state = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 760, min: 700, max: 900 }),
      pointerId: 11,
      startClientX: 320,
      pxPerBase: 8,
    });

    state = updateSourceRegisterGesture(state, 344).state;
    expect(state.visualOffsetPx).toBe(24);
    expect(state.latestValue).toBe(757);
    expect(state.moveCount).toBe(1);

    state = updateSourceRegisterGesture(state, 296).state;
    expect(state.visualOffsetPx).toBe(-24);
    expect(state.latestValue).toBe(763);
    expect(state.moveCount).toBe(2);

    state = updateSourceRegisterGesture(state, 336).state;
    expect(state.visualOffsetPx).toBe(16);
    expect(state.latestValue).toBe(758);
    expect(state.moveCount).toBe(3);
  });

  it('clamps visual movement and snapped value to the source boundary range', () => {
    let state = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 50, min: 40, max: 55 }),
      pointerId: null,
      startClientX: 100,
      pxPerBase: 10,
    });

    state = updateSourceRegisterGesture(state, 10_000).state;
    expect(state.visualOffsetPx).toBe(100);
    expect(state.latestValue).toBe(40);

    state = updateSourceRegisterGesture(state, -10_000).state;
    expect(state.visualOffsetPx).toBe(-50);
    expect(state.latestValue).toBe(55);
  });

  it('cancels back to the starting boundary without producing a command', () => {
    const started = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 120 }),
      pointerId: 3,
      startClientX: 200,
      pxPerBase: 8,
    });
    const moved = updateSourceRegisterGesture(started, 240).state;

    expect(cancelSourceRegisterGesture(moved)).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        latestClientX: 200,
        latestValue: 120,
        visualOffsetPx: 0,
      })
    );
  });

  it('commits through the same editable-field command contract as UI and MCP paths', () => {
    const field = sourceBoundaryField({
      id: 'source-field',
      regionId: 'fragment-2',
      side: 'upstream',
      value: 900,
      min: 850,
      max: 950,
    });
    const started = beginSourceRegisterGesture({
      field,
      pointerId: 5,
      startClientX: 500,
      pxPerBase: 8,
    });
    const moved = updateSourceRegisterGesture(started, 476).state;

    const commit = commitSourceRegisterGesture(moved, { expectedDesignVersion: 42 });

    expect(commit).toEqual(
      expect.objectContaining({
        status: 'committed',
        field,
        value: 903,
        command: {
          type: 'setSourceContributionBoundary',
          regionId: 'fragment-2',
          side: 'upstream',
          sourcePosition: 903,
          expectedDesignVersion: 42,
        },
      })
    );
  });

  it('rejects non-source-boundary fields at gesture start', () => {
    expect(() =>
      beginSourceRegisterGesture({
        field: sourceBoundaryField({ kind: 'primerPbs' }),
        pointerId: null,
        startClientX: 0,
        pxPerBase: 8,
      })
    ).toThrow(/not a source contribution boundary/);
  });

  it('uses source-register sign semantics for direct visual-offset value projection', () => {
    const state = beginSourceRegisterGesture({
      field: sourceBoundaryField({ value: 100 }),
      pointerId: null,
      startClientX: 0,
      pxPerBase: 10,
    });

    expect(valueForVisualOffset(state, 20)).toBe(98);
    expect(valueForVisualOffset(state, -20)).toBe(102);
  });
});

function sourceBoundaryField(
  overrides: Partial<AssemblyWorkbenchEditableField> & {
    id?: string;
    value?: number;
    min?: number;
    max?: number;
    regionId?: string;
    side?: 'upstream' | 'downstream';
  } = {}
): AssemblyWorkbenchEditableField {
  const regionId = overrides.regionId ?? 'fragment-1';
  const side = overrides.side ?? 'downstream';
  const value = overrides.value ?? 120;
  const kind = overrides.kind ?? 'sourceContributionBoundary';
  return {
    id: overrides.id ?? 'source-field',
    kind,
    label: 'Source boundary',
    target: { junctionIndex: 0, regionId, side },
    value,
    units: 'bp',
    range: {
      min: overrides.min ?? 80,
      max: overrides.max ?? 180,
      step: 1,
      largeStep: 10,
    },
    anchors: [{ rowId: 'left', rowKind: 'left-source', bioCol: 0, role: 'boundary' }],
    command: {
      type: 'setSourceContributionBoundary',
      payload: { regionId, side, sourcePosition: value },
      valueKey: 'sourcePosition',
    },
    constraints: [],
    ...overrides,
  };
}
