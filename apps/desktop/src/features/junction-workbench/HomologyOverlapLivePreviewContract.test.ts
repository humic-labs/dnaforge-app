import { describe, expect, it } from 'vitest';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import { reverseComplement } from '@waypoint/sequence-utils';
import type { AssemblyWorkbenchEditableField } from './AssemblyWorkbenchContract';
import {
  homologyOverlapLivePreviewForProductRow,
  homologyOverlapLivePrimersForRow,
} from './HomologyOverlapLivePreviewContract';
import { makeMappingPoint } from './coord-mapping';
import type { JunctionWorkbenchRow } from './model';

describe('HomologyOverlapLivePreviewContract', () => {
  it('previews RD-to-PCR Gibson forward primer tails across spacer cargo from the physical tail anchor', () => {
    const row = {
      ...productRow(),
      spacerColumns: [12, 13, 14],
      constraints: [
        {
          kind: 'homology-width' as const,
          startBioCol: -5,
          endBioCol: 0,
          editable: true,
          label: '8 bp PCR tail',
          spacerLength: 3,
          leftHomologyEndBioCol: 0,
          leftTailEndBioCol: 3,
          leftTailPresent: true,
          rightTailPresent: false,
        },
      ],
    };
    const field = homologyField({ side: 'left', value: 5, oppositeValue: 0 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, 7);
    const pbsLength = 10;
    const forwardPbsStart = row.anchorRowPosition + 3;
    const forward: PrimerDisplay = {
      id: 'right-forward-rd-spacer',
      name: 'right forward RD spacer',
      start: forwardPbsStart - 8,
      end: forwardPbsStart + pbsLength,
      direction: 'forward',
      bases:
        row.sequence.slice(row.anchorRowPosition - 5, forwardPbsStart) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
      tm: 60,
      gc: 50,
      overhangLength: 8,
      spacerLength: 3,
      junctionIndex: 0,
    };

    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: -7,
      endBioCol: 0,
      spacerLength: 3,
      leftHomologyLength: 7,
      rightHomologyLength: 0,
      forwardOverhang: row.sequence.slice(row.anchorRowPosition - 7, forwardPbsStart),
      forwardSpacerLength: 3,
    });

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [forward] },
      preview!,
      0
    );
    expect(livePrimers?.[0]).toMatchObject({
      start: forwardPbsStart - 10,
      end: forward.end,
      overhangLength: 10,
      spacerLength: 3,
      bases:
        row.sequence.slice(row.anchorRowPosition - 7, forwardPbsStart) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
    });
  });

  it('previews PCR-to-RD Gibson reverse primer tails across spacer cargo without counting spacer as overlap', () => {
    const row = {
      ...productRow(),
      spacerColumns: [12, 13, 14],
      constraints: [
        {
          kind: 'homology-width' as const,
          startBioCol: 3,
          endBioCol: 8,
          editable: true,
          label: '8 bp PCR tail',
          spacerLength: 3,
          rightHomologyStartBioCol: 3,
          rightTailStartBioCol: 0,
          leftTailPresent: false,
          rightTailPresent: true,
        },
      ],
    };
    const field = homologyField({ side: 'right', value: 5, oppositeValue: 0 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, 7);
    const pbsLength = 10;
    const reversePbsEnd = row.anchorRowPosition;
    const reverse: PrimerDisplay = {
      id: 'left-reverse-rd-spacer',
      name: 'left reverse RD spacer',
      start: reversePbsEnd - pbsLength,
      end: reversePbsEnd + 8,
      direction: 'reverse',
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 8)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: 8,
      spacerLength: 3,
      junctionIndex: 0,
    };

    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: 3,
      endBioCol: 10,
      spacerLength: 3,
      leftHomologyLength: 0,
      rightHomologyLength: 7,
      reverseOverhang: reverseComplement(
        row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 10)
      ),
      reverseSpacerLength: 3,
    });

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [reverse] },
      preview!,
      0
    );
    expect(livePrimers?.[0]).toMatchObject({
      start: reverse.start,
      end: row.anchorRowPosition + 10,
      overhangLength: 10,
      spacerLength: 3,
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 10)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
    });
  });

  it('updates Gibson/NEBuilder primer overlays from product-space homology ground truth', () => {
    const row = productRow();
    const field = homologyField({ side: 'left', value: 5, oppositeValue: 4 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, 7);
    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: -4,
      endBioCol: 7,
      spacerLength: 3,
      forwardOverhang: row.sequence.slice(row.anchorRowPosition - 4, row.anchorRowPosition + 3),
      forwardSpacerLength: 3,
      reverseOverhang: reverseComplement(
        row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)
      ),
      reverseSpacerLength: 3,
    });

    const pbsLength = 10;
    const forwardPbsStart = row.anchorRowPosition + 3;
    const forward: PrimerDisplay = {
      id: 'right-forward',
      name: 'right forward',
      start: forwardPbsStart - 5,
      end: forwardPbsStart + pbsLength,
      direction: 'forward',
      bases:
        row.sequence.slice(row.anchorRowPosition - 2, row.anchorRowPosition + 3) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
      tm: 60,
      gc: 50,
      overhangLength: 5,
      spacerLength: 3,
      junctionIndex: 0,
    };
    const reversePbsEnd = row.anchorRowPosition;
    const reverse: PrimerDisplay = {
      id: 'left-reverse',
      name: 'left reverse',
      start: reversePbsEnd - pbsLength,
      end: reversePbsEnd + 7,
      direction: 'reverse',
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: 7,
      spacerLength: 3,
      junctionIndex: 0,
    };

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [forward, reverse] },
      preview!,
      0
    );

    expect(livePrimers?.find((primer) => primer.id === forward.id)).toMatchObject({
      start: forwardPbsStart - 7,
      end: forward.end,
      overhangLength: 7,
      spacerLength: 3,
      bases:
        row.sequence.slice(row.anchorRowPosition - 4, row.anchorRowPosition + 3) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
    });
    expect(livePrimers?.find((primer) => primer.id === reverse.id)).toMatchObject({
      start: reverse.start,
      end: reverse.end,
      overhangLength: 7,
      spacerLength: 3,
      bases: reverse.bases,
    });
  });

  it('keeps live primer overlays aligned when the left homology boundary intrudes into the forward PBS', () => {
    const row = productRow();
    const field = homologyField({ side: 'left', value: 5, oppositeValue: 4 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, -2);
    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: 5,
      endBioCol: 7,
      spacerLength: 3,
      forwardOverhang: '',
      forwardSpacerLength: 0,
      reverseOverhang: reverseComplement(
        row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)
      ),
      reverseSpacerLength: 3,
    });

    const pbsLength = 10;
    const forwardPbsStart = row.anchorRowPosition + 3;
    const forward: PrimerDisplay = {
      id: 'right-forward',
      name: 'right forward',
      start: forwardPbsStart - 5,
      end: forwardPbsStart + pbsLength,
      direction: 'forward',
      bases:
        row.sequence.slice(row.anchorRowPosition - 2, row.anchorRowPosition + 3) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
      tm: 60,
      gc: 50,
      overhangLength: 5,
      spacerLength: 3,
      junctionIndex: 0,
    };
    const reversePbsEnd = row.anchorRowPosition;
    const reverse: PrimerDisplay = {
      id: 'left-reverse',
      name: 'left reverse',
      start: reversePbsEnd - pbsLength,
      end: reversePbsEnd + 7,
      direction: 'reverse',
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: 7,
      spacerLength: 3,
      junctionIndex: 0,
    };

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [forward, reverse] },
      preview!,
      0
    );

    const expectedForwardPbs = row.sequence.slice(forwardPbsStart + 2, forwardPbsStart + pbsLength);
    expect(livePrimers?.find((primer) => primer.id === forward.id)).toMatchObject({
      start: forward.end - expectedForwardPbs.length,
      end: forward.end,
      overhangLength: 0,
      spacerLength: undefined,
      bases: expectedForwardPbs,
    });
    expect(livePrimers?.find((primer) => primer.id === reverse.id)).toMatchObject({
      start: reverse.start,
      end: reverse.end,
      overhangLength: reverse.overhangLength,
      spacerLength: reverse.spacerLength,
      bases: reverse.bases,
    });
  });

  it('keeps live primer overlays aligned when the right homology boundary intrudes into the reverse PBS', () => {
    const row = productRow();
    const field = homologyField({ side: 'right', value: 4, oppositeValue: 5 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, -4);
    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: -2,
      endBioCol: -1,
      spacerLength: 3,
      forwardOverhang: row.sequence.slice(row.anchorRowPosition - 2, row.anchorRowPosition + 3),
      forwardSpacerLength: 3,
      reverseOverhang: '',
      reverseSpacerLength: 0,
    });

    const pbsLength = 10;
    const forwardPbsStart = row.anchorRowPosition + 3;
    const forward: PrimerDisplay = {
      id: 'right-forward',
      name: 'right forward',
      start: forwardPbsStart - 5,
      end: forwardPbsStart + pbsLength,
      direction: 'forward',
      bases:
        row.sequence.slice(row.anchorRowPosition - 2, row.anchorRowPosition + 3) +
        row.sequence.slice(forwardPbsStart, forwardPbsStart + pbsLength),
      tm: 60,
      gc: 50,
      overhangLength: 5,
      spacerLength: 3,
      junctionIndex: 0,
    };
    const reversePbsEnd = row.anchorRowPosition;
    const reverse: PrimerDisplay = {
      id: 'left-reverse',
      name: 'left reverse',
      start: reversePbsEnd - pbsLength,
      end: reversePbsEnd + 7,
      direction: 'reverse',
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: 7,
      spacerLength: 3,
      junctionIndex: 0,
    };

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [forward, reverse] },
      preview!,
      0
    );

    const expectedReversePbs = reverseComplement(
      row.sequence.slice(reversePbsEnd - pbsLength, reversePbsEnd - 1)
    );
    expect(livePrimers?.find((primer) => primer.id === forward.id)).toMatchObject({
      start: forward.start,
      end: forward.end,
      overhangLength: forward.overhangLength,
      spacerLength: forward.spacerLength,
      bases: forward.bases,
    });
    expect(livePrimers?.find((primer) => primer.id === reverse.id)).toMatchObject({
      start: reverse.start,
      end: reverse.start + expectedReversePbs.length,
      overhangLength: 0,
      spacerLength: undefined,
      bases: expectedReversePbs,
    });
  });

  it('reconstructs the live forward PBS when a left-boundary intrusion is dragged back out', () => {
    const row = productRow();
    const field = homologyField({ side: 'left', value: -2, oppositeValue: 4 });
    const preview = homologyOverlapLivePreviewForProductRow(row, field, 5);
    expect(preview).toMatchObject({
      kind: 'homology',
      startBioCol: -2,
      currentStartBioCol: 5,
      currentLeftHomologyLength: -2,
    });

    const restoredPbsLength = 10;
    const basePbsStart = row.anchorRowPosition + 3;
    const currentPbsStart = row.anchorRowPosition + 5;
    const currentPbsEnd = basePbsStart + restoredPbsLength;
    const forward: PrimerDisplay = {
      id: 'right-forward',
      name: 'right forward',
      start: currentPbsStart,
      end: currentPbsEnd,
      direction: 'forward',
      bases: row.sequence.slice(currentPbsStart, currentPbsEnd),
      tm: 60,
      gc: 50,
      overhangLength: 0,
      spacerLength: undefined,
      junctionIndex: 0,
    };
    const reversePbsEnd = row.anchorRowPosition;
    const reverse: PrimerDisplay = {
      id: 'left-reverse',
      name: 'left reverse',
      start: reversePbsEnd - restoredPbsLength,
      end: reversePbsEnd + 7,
      direction: 'reverse',
      bases:
        reverseComplement(row.sequence.slice(row.anchorRowPosition, row.anchorRowPosition + 7)) +
        reverseComplement(row.sequence.slice(reversePbsEnd - restoredPbsLength, reversePbsEnd)),
      tm: 60,
      gc: 50,
      overhangLength: 7,
      spacerLength: 3,
      junctionIndex: 0,
    };

    const livePrimers = homologyOverlapLivePrimersForRow(
      { ...row, primers: [forward, reverse] },
      preview!,
      0
    );

    const expectedForwardOverhang = row.sequence.slice(row.anchorRowPosition - 2, basePbsStart);
    const expectedForwardPbs = row.sequence.slice(basePbsStart, currentPbsEnd);
    expect(livePrimers?.find((primer) => primer.id === forward.id)).toMatchObject({
      start: currentPbsEnd - expectedForwardPbs.length - expectedForwardOverhang.length,
      end: currentPbsEnd,
      overhangLength: expectedForwardOverhang.length,
      spacerLength: 3,
      bases: expectedForwardOverhang + expectedForwardPbs,
    });
    expect(livePrimers?.find((primer) => primer.id === reverse.id)).toMatchObject({
      start: reverse.start,
      end: reverse.end,
      overhangLength: reverse.overhangLength,
      spacerLength: reverse.spacerLength,
      bases: reverse.bases,
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
        kind: 'homology-width',
        startBioCol: -2,
        endBioCol: 7,
        editable: true,
        label: '9 bp crossover',
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
