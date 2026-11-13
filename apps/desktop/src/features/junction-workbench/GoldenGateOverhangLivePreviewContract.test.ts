import { describe, expect, it } from 'vitest';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import { reverseComplement } from '@waypoint/sequence-utils';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  goldenGateOverhangLivePreviewForProductRow,
  goldenGateOverhangLivePrimersForRow,
} from './GoldenGateOverhangLivePreviewContract';
import { makeMappingPoint } from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';

describe('GoldenGateOverhangLivePreviewContract', () => {
  it('derives the dragged 4bp scar and attribution from product-row ground truth', () => {
    const row = productRow();
    const field = goldenGateField({ value: 0, previewStart: -1, previewEnd: 3, spacerLength: 3 });

    const preview = goldenGateOverhangLivePreviewForProductRow(row, field, 1);

    expect(preview).toMatchObject({
      kind: 'goldengate-overhang',
      startBioCol: 0,
      endBioCol: 4,
      spacerLength: 3,
      overhang: 'ACGA',
      leftCount: 0,
      spacerCount: 3,
      rightCount: 1,
    });
  });

  it('updates Golden Gate primer overlays without semantic model recomputation', () => {
    const row = productRow();
    const field = goldenGateField({ value: 0, previewStart: -1, previewEnd: 3, spacerLength: 3 });
    const preview = goldenGateOverhangLivePreviewForProductRow(row, field, 2);
    expect(preview).not.toBeNull();

    const cut = 3;
    const prefix = 'GGA';
    const forward: PrimerDisplay = {
      id: 'right-forward',
      name: 'right forward',
      start: row.anchorRowPosition - 7,
      end: row.anchorRowPosition + 10,
      direction: 'forward',
      bases: `${prefix}TTTT${row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 10)}`,
      tm: 60,
      gc: 50,
      overhangLength: cut + 4,
      cutPositionInOverhang: cut,
      junctionIndex: 0,
    };
    const reverse: PrimerDisplay = {
      id: 'left-reverse',
      name: 'left reverse',
      start: row.anchorRowPosition - 10,
      end: row.anchorRowPosition + 7,
      direction: 'reverse',
      bases: `${prefix}AAAA${reverseComplement(
        row.sequence.slice(row.anchorRowPosition - 10, row.anchorRowPosition)
      )}`,
      tm: 60,
      gc: 50,
      overhangLength: cut + 4,
      cutPositionInOverhang: cut,
      junctionIndex: 0,
    };
    const livePrimers = goldenGateOverhangLivePrimersForRow(
      { ...row, primers: [forward, reverse] },
      preview!,
      0
    );

    const liveForward = livePrimers?.find((primer) => primer.id === forward.id);
    const liveReverse = livePrimers?.find((primer) => primer.id === reverse.id);
    expect(liveForward).toMatchObject({
      bases: `${prefix}CGAT${row.sequence.slice(row.anchorRowPosition + 5, row.anchorRowPosition + 15)}`,
      overhangLength: cut + 4,
      cognate4bpLength: 2,
      synthetic4bpSpacerLength: 2,
    });
    expect(liveReverse).toMatchObject({
      bases: `${prefix}ATCG${reverseComplement(
        row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 1)
      )}${reverseComplement(row.sequence.slice(row.anchorRowPosition - 10, row.anchorRowPosition))}`,
      overhangLength: cut + 5,
      cognate4bpLength: 0,
      synthetic4bpSpacerLength: 2,
      spacerLength: 1,
    });
  });
});

function productRow(): JunctionWorkbenchRow {
  const anchorRowPosition = 12;
  const sequence = 'ACGTACGTACGTACGATCGTACGTACGT';
  return {
    id: 'product',
    kind: 'product',
    label: 'Product',
    sequence,
    coordinateStart: 0,
    anchorRowPosition,
    points: Array.from({ length: sequence.length }, (_, rowPosition) =>
      makeMappingPoint(
        'product',
        rowPosition,
        rowPosition - anchorRowPosition,
        rowPosition,
        'valid'
      )
    ),
    annotations: [],
    spacerColumns: [anchorRowPosition, anchorRowPosition + 1, anchorRowPosition + 2],
    constraints: [
      {
        kind: 'fixed-overhang',
        startBioCol: -1,
        endBioCol: 3,
        editable: true,
        label: 'PCR-designed overhang',
      },
    ],
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
    anchors: [{ rowId: 'product', rowKind: 'product', bioCol: 1, role: 'boundary' }],
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
