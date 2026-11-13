import { describe, expect, it } from 'vitest';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import { productOverlapBioRangeForField } from './ProductOverlapPreviewContract';
import type { JunctionWorkbenchRow } from './model';

describe('ProductOverlapPreviewContract', () => {
  it('updates spacer-separated RD/PCR Gibson overlap previews from the physical tail anchors, not spacer midpoint math', () => {
    const row = productRow({
      constraintKind: 'homology-width',
      constraintStart: -18,
      constraintEnd: 0,
      spacerLength: 4,
      leftHomologyEndBioCol: 0,
      leftTailEndBioCol: 4,
      leftTailPresent: true,
      rightTailPresent: false,
    });
    const field = homologyField({
      side: 'left',
      value: 18,
      oppositeValue: 0,
    });

    expect(productOverlapBioRangeForField(row, field, 20)).toMatchObject({
      kind: 'homology',
      startBioCol: -20,
      endBioCol: 0,
      spacerLength: 4,
      leftHomologyLength: 20,
      rightHomologyLength: 0,
    });
  });

  it('updates spacer-separated PCR/RD Gibson overlap previews without counting spacer cargo as overlap', () => {
    const row = productRow({
      constraintKind: 'homology-width',
      constraintStart: 4,
      constraintEnd: 22,
      spacerLength: 4,
      rightHomologyStartBioCol: 4,
      rightTailStartBioCol: 0,
      leftTailPresent: false,
      rightTailPresent: true,
    });
    const field = homologyField({
      side: 'right',
      value: 18,
      oppositeValue: 0,
    });

    expect(productOverlapBioRangeForField(row, field, 20)).toMatchObject({
      kind: 'homology',
      startBioCol: 4,
      endBioCol: 24,
      spacerLength: 4,
      leftHomologyLength: 0,
      rightHomologyLength: 20,
    });
  });

  it('uses signed tail geometry when a left homology boundary intrudes into the forward PBS', () => {
    const row = productRow({
      constraintKind: 'homology-width',
      constraintStart: -1,
      constraintEnd: 14,
      spacerLength: 6,
      leftHomologyEndBioCol: 6,
      rightHomologyStartBioCol: 6,
      leftTailEndBioCol: 6,
      rightTailStartBioCol: 0,
      leftTailPresent: true,
      rightTailPresent: true,
    });
    const field = homologyField({
      side: 'left',
      value: 7,
      oppositeValue: 8,
    });

    expect(productOverlapBioRangeForField(row, field, -5)).toMatchObject({
      kind: 'homology',
      startBioCol: 11,
      endBioCol: 14,
      spacerLength: 6,
      leftHomologyLength: -5,
      rightHomologyLength: 8,
    });
  });

  it('uses signed tail geometry when a right homology boundary intrudes into the reverse PBS', () => {
    const row = productRow({
      constraintKind: 'homology-width',
      constraintStart: -2,
      constraintEnd: 7,
      spacerLength: 3,
      leftHomologyEndBioCol: 3,
      rightHomologyStartBioCol: 3,
      leftTailEndBioCol: 3,
      rightTailStartBioCol: 0,
      leftTailPresent: true,
      rightTailPresent: true,
    });
    const field = homologyField({
      side: 'right',
      value: 4,
      oppositeValue: 5,
    });

    expect(productOverlapBioRangeForField(row, field, -4)).toMatchObject({
      kind: 'homology',
      startBioCol: -2,
      endBioCol: -1,
      spacerLength: 3,
      leftHomologyLength: 5,
      rightHomologyLength: -4,
    });
  });

  it('keeps Golden Gate live geometry anchored to the drag-start overhang range', () => {
    const row = productRow({
      constraintKind: 'fixed-overhang',
      constraintStart: 3,
      constraintEnd: 7,
    });
    const field = goldenGateField({
      value: 0,
      previewStart: 1,
      previewEnd: 5,
      spacerLength: 3,
    });

    expect(productOverlapBioRangeForField(row, field, 3)).toMatchObject({
      kind: 'goldengate-overhang',
      startBioCol: 4,
      endBioCol: 8,
      spacerLength: 3,
    });
  });
});

function productRow(input: {
  constraintKind: 'homology-width' | 'fixed-overhang';
  constraintStart: number;
  constraintEnd: number;
  spacerLength?: number;
  leftHomologyEndBioCol?: number;
  rightHomologyStartBioCol?: number;
  leftTailEndBioCol?: number;
  rightTailStartBioCol?: number;
  leftTailPresent?: boolean;
  rightTailPresent?: boolean;
}): JunctionWorkbenchRow {
  const spacerLength = input.spacerLength ?? 3;
  return {
    id: 'product',
    kind: 'product',
    label: 'Product',
    sequence: 'A'.repeat(120),
    coordinateStart: 0,
    anchorRowPosition: 60,
    points: Array.from({ length: 120 }, (_, rowPosition) => ({
      rowId: 'product',
      bioCol: rowPosition - 60,
      rowPosition,
      productPosition: rowPosition,
      kind: 'valid',
      editable: true,
    })),
    annotations: [],
    spacerColumns: Array.from({ length: spacerLength }, (_, index) => 60 + index),
    constraints: [
      {
        kind: input.constraintKind,
        startBioCol: input.constraintStart,
        endBioCol: input.constraintEnd,
        editable: true,
        label: input.constraintKind === 'fixed-overhang' ? 'PCR-designed overhang' : 'Gibson tail',
        ...(input.constraintKind === 'homology-width'
          ? {
              spacerLength,
              leftHomologyEndBioCol: input.leftHomologyEndBioCol,
              rightHomologyStartBioCol: input.rightHomologyStartBioCol,
              leftTailEndBioCol: input.leftTailEndBioCol,
              rightTailStartBioCol: input.rightTailStartBioCol,
              leftTailPresent: input.leftTailPresent,
              rightTailPresent: input.rightTailPresent,
            }
          : {}),
      },
    ],
  };
}

function homologyField(input: {
  side: 'left' | 'right';
  value: number;
  oppositeValue: number;
}): AssemblyWorkbenchEditableField {
  const encoding =
    input.side === 'left'
      ? { onLeft: input.value, onRight: input.oppositeValue }
      : { onLeft: input.oppositeValue, onRight: input.value };
  return {
    id: `${input.side}-homology`,
    kind: 'homologyArm',
    label: `${input.side} homology`,
    target: { junctionIndex: 0, side: input.side },
    value: input.value,
    units: 'bp',
    range: { min: 0, max: 60, step: 1, largeStep: 5 },
    anchors: [],
    command: {
      type: 'setHomologyEncoding',
      payload: { junctionIndex: 0, encoding },
      valueKey: input.side === 'left' ? 'encoding.onLeft' : 'encoding.onRight',
    },
    constraints: [],
  };
}

function goldenGateField(input: {
  value: number;
  previewStart: number;
  previewEnd: number;
  spacerLength: number;
}): AssemblyWorkbenchEditableField {
  return {
    id: 'goldengate-overhang',
    kind: 'goldenGateOverhang',
    label: 'Golden Gate overhang offset',
    target: { junctionIndex: 0 },
    value: input.value,
    units: 'bp',
    range: { min: -24, max: 24, step: 1, largeStep: 5 },
    anchors: [{ rowId: 'product', rowKind: 'product', bioCol: 3, role: 'boundary' }],
    command: {
      type: 'setGoldenGateOffset',
      payload: {
        junctionIndex: 0,
        offset: input.value,
        previewRange: {
          startBioCol: input.previewStart,
          endBioCol: input.previewEnd,
          spacerLength: input.spacerLength,
        },
      },
      valueKey: 'offset',
    },
    constraints: [],
  };
}
