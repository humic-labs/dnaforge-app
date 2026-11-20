import { describe, expect, it } from 'vitest';
import type { Genome } from '@waypoint/genome-renderer';
import type { TraceData } from '@waypoint/sequence-utils';
import { buildAlignedChromatogramOptions } from '../tracks/aligned-chromatogram';
import { buildSequenceViewProjection } from '../view-state/sequence-view-projection';
import { buildSharedAlignmentProjection } from './shared-alignment-projection';
import { buildSharedSequenceReadScene } from './shared-sequence-read-model';

const trace: TraceData = {
  channels: {
    A: [0, 20, 0, 0, 0, 0],
    C: [0, 0, 0, 20, 0, 0],
    G: [0, 0, 0, 0, 20, 0],
    T: [0, 0, 0, 0, 0, 20],
  },
  peakPositions: [1, 3, 4, 5],
  baseOrder: 'GATC',
  maxValue: 20,
};

function genome(): Genome {
  return {
    name: 'ordinary.gb',
    length: 4,
    circular: false,
    sequence: 'ACGT',
    features: [
      {
        id: 7,
        type: 'gene',
        start: 2,
        end: 4,
        direction: 1,
        displayName: 'tail',
        color: 0x33aa55,
        lane: 0,
      },
    ],
  };
}

describe('shared sequence/read scene', () => {
  it('keeps a direct AB1 on its own grid with quality and stable source identity', () => {
    const scene = buildSharedSequenceReadScene({
      genome: genome(),
      documentId: 'ab1-file-17',
      directRead: { trace, sequence: 'ACGT', quality: [10, 20, 30, 40] },
    });

    expect(scene.genome.sourceIdentity).toBe('ab1-file-17');
    expect(scene.genome.sequence).toBe('ACGT');
    expect(scene.lanes).toEqual([
      expect.objectContaining({
        id: 'sanger-direct-ab1-file-17',
        kind: 'sanger',
        trace,
        sequence: 'ACGT',
        quality: [10, 20, 30, 40],
        baseToColumn: [0, 1, 2, 3],
      }),
    ]);
  });

  it('preserves attached read placement and circular virtual columns', () => {
    const scene = buildSharedSequenceReadScene({
      genome: { ...genome(), circular: true },
      documentId: 'reference-2',
      attachedReads: [
        {
          id: 'read-1',
          label: 'read.ab1',
          laneOptions: {
            trace,
            sequence: 'ACGT',
            quality: [40, 40, 12, 40],
            baseToColumn: [2, 3, 4, 5],
            totalColumns: 4,
            cycleLength: 4,
            mutationColumns: [5],
            deletionColumns: [4],
          },
        },
      ],
    });

    expect(scene.lanes[0]).toMatchObject({
      id: 'sanger-attached-read-1',
      baseToColumn: [2, 3, 4, 5],
      cycleLength: 4,
      mutationColumns: [5],
      deletionColumns: [4],
    });
    expect(scene.genome.length).toBe(4);
  });

  it.each([
    [[10, 20, 30]],
    [[10, 20, 30, 40, 50]],
    [[0, 10, 256, 40]],
    [[0, 10, -1, 40]],
    [[0, 10, 2.5, 40]],
    [[0, 10, Number.NaN, 40]],
    [Array<number>(4)],
  ])('rejects inconsistent quality before admitting either read lane (%j)', (quality) => {
    const input = { genome: genome(), documentId: 'read-quality' };
    expect(() =>
      buildSharedSequenceReadScene({
        ...input,
        directRead: { trace, sequence: 'ACGT', quality },
      })
    ).toThrow('Quality values do not match the called bases.');
    expect(() =>
      buildSharedSequenceReadScene({
        ...input,
        attachedReads: [
          {
            id: 'read-1',
            label: 'read.ab1',
            laneOptions: { trace, sequence: 'ACGT', quality, totalColumns: 4 },
          },
        ],
      })
    ).toThrow('Quality values do not match the called bases.');
  });

  it.each([[undefined], [[]], [[0, 19, 20, 255]]])(
    'preserves missing and valid quality without replacing Q0 (%j)',
    (quality) => {
      const scene = buildSharedSequenceReadScene({
        genome: genome(),
        documentId: 'read-quality',
        directRead: { trace, sequence: 'ACGT', quality },
      });
      expect(scene.lanes[0]).toHaveProperty('quality', quality);
    }
  );

  it('uses gapped columns for the reference, feature, query row, and attached read', () => {
    const scene = buildSharedSequenceReadScene({
      genome: genome(),
      documentId: 'reference-3',
      coordinateSpace: {
        mode: 'gapped',
        gappedSequence: 'AC-GT',
        alignedQuery: 'ACTGT',
      },
      attachedReads: [
        {
          id: 'read-2',
          label: 'read2.ab1',
          laneOptions: {
            trace,
            sequence: 'ACGT',
            baseToColumn: [0, 1, 2, 3],
            totalColumns: 4,
            mutationColumns: [2],
          },
        },
      ],
    });

    expect(scene.genome).toMatchObject({
      sequence: 'AC-GT',
      length: 5,
      circular: false,
      features: [expect.objectContaining({ start: 3, end: 5 })],
    });
    expect(scene.axis.bioToColumn(2)).toBe(3);
    expect(scene.axis.columnToBio(2)).toBeNull();
    expect(scene.lanes).toEqual([
      expect.objectContaining({ kind: 'alignment', alignedQuery: 'ACTGT' }),
      expect.objectContaining({
        kind: 'sanger',
        baseToColumn: [0, 1, 3, 4],
        mutationColumns: [3],
      }),
    ]);
  });

  it('keeps inserted calls, samples, and quality on a shared axis in both orientations', () => {
    const reference = 'AGT';
    const { laneOptions } = buildAlignedChromatogramOptions({
      referenceSequence: reference,
      readSequence: 'ACGT',
      trace,
      readQuality: [10, 20, 30, 40],
      alignedReference: 'A-GT',
      alignedQuery: 'ACGT',
    });
    const attachments = [{ id: 'trace', label: 'trace', laneOptions }];
    const forward = buildSharedSequenceReadScene({
      genome: { ...genome(), sequence: reference, length: 3, features: [] },
      documentId: 'sequence',
      attachedReads: attachments,
    });
    expect(forward.genome.sequence).toBe('A-GT');
    expect(forward.axis.columnToBio(1)).toBeNull();
    expect(forward.lanes[0]).toMatchObject({
      baseToColumn: [0, 1, 2, 3],
      sourcePeakPositions: [1, 3, 4, 5],
    });
    const reverse = buildSharedSequenceReadScene({
      genome: { ...genome(), sequence: 'ACT', length: 3, features: [] },
      documentId: 'sequence',
      attachedReads: attachments,
      viewProjection: buildSequenceViewProjection({
        sequenceLength: 3,
        circular: false,
        orientation: 'reverse-complement',
      }),
    });
    expect(reverse.genome.sequence).toBe('AC-T');
    expect(reverse.lanes[0]).toMatchObject({
      baseToColumn: [0, 1, 2, 3],
      sourceBaseIndices: [3, 2, 1, 0],
      sourcePeakPositions: [5, 4, 3, 1],
      quality: [40, 30, 20, 10],
    });
  });

  it('preserves peak order over an origin crossing in a saved circular alignment', () => {
    const reference = 'ACGT';
    const { laneOptions } = buildAlignedChromatogramOptions({
      referenceSequence: reference,
      readSequence: 'TACG',
      trace,
      readQuality: [10, 20, 30, 40],
      referenceOffset: 3,
      alignedReference: 'T-AC',
      alignedQuery: 'TACG',
    });
    const projection = buildSharedAlignmentProjection(reference, [
      {
        id: 'q',
        label: 'q',
        referenceOffset: 3,
        alignedReference: 'T-AC',
        alignedQuery: 'TACG',
        sanger: { ...laneOptions, cycleLength: 4 },
      },
    ])!;
    const scene = buildSharedSequenceReadScene({
      genome: { ...genome(), circular: true },
      documentId: 'r',
      coordinateSpace: projection.coordinateSpace,
      alignmentLanes: projection.lanes,
    });
    expect(scene.genome.sequence).toBe('-ACGT');
    expect(scene.axis.columnToBio(0)).toBeNull();
    expect(projection.projectTrackColumn('q', 1)).toBe(0);
    expect(scene.lanes[1]).toMatchObject({
      kind: 'sanger',
      sequence: 'TACG',
      baseToColumn: [4, 5, 6, 7],
      cycleLength: 5,
      sourceBaseIndices: [0, 1, 2, 3],
    });
  });

  it('keeps an existing alignment insertion selectable after an earlier bridge insertion expands the axis', () => {
    const { laneOptions } = buildAlignedChromatogramOptions({
      referenceSequence: 'ACGT',
      readSequence: 'ACGT',
      alignedReference: '-ACGT',
      alignedQuery: 'ACG-T',
      trace,
    });
    const scene = buildSharedSequenceReadScene({
      genome: genome(),
      documentId: 'r',
      coordinateSpace: { mode: 'gapped', gappedSequence: 'AC-GT', alignedQuery: 'ACTGT' },
      attachedReads: [{ id: 'bridge', label: 'bridge', laneOptions }],
    });
    expect(scene.genome.sequence).toBe('-AC-GT');
    expect(scene.coordinateSpace?.alignedQuery).toBe('-ACTGT');
    expect(scene.inputColumnToDisplayColumn?.(2)).toBe(3);
    expect(scene.lanes[1]).toMatchObject({ baseToColumn: [0, 1, 2, 5], deletionColumns: [4] });
  });

  it('rejects an alignment from another reference instead of painting shifted data', () => {
    expect(() =>
      buildSharedSequenceReadScene({
        genome: genome(),
        documentId: 'reference-4',
        coordinateSpace: {
          mode: 'gapped',
          gappedSequence: 'AT-GT',
          alignedQuery: 'ATCGT',
        },
      })
    ).toThrow(/reference/i);
  });

  it('projects all native exon geometry onto the same existing gapped axis', () => {
    const scene = buildSharedSequenceReadScene({
      genome: {
        ...genome(),
        features: [
          {
            ...genome().features![0],
            start: 0,
            end: 4,
            segments: [
              { start: 1, end: 2 },
              { start: 3, end: 4 },
            ],
            exons: [
              { start: 1, end: 2 },
              { start: 3, end: 4 },
            ],
            cds: [
              { start: 2, end: 2 },
              { start: 3, end: 4 },
            ],
          },
        ],
      },
      documentId: 'spliced-reference',
      coordinateSpace: { mode: 'gapped', gappedSequence: 'AC-GT', alignedQuery: 'ACTGT' },
    });
    expect(scene.genome.features![0]).toMatchObject({
      start: 0,
      end: 5,
      segments: [
        { start: 1, end: 2 },
        { start: 4, end: 5 },
      ],
      exons: [
        { start: 1, end: 2 },
        { start: 4, end: 5 },
      ],
      cds: [
        { start: 2, end: 2 },
        { start: 4, end: 5 },
      ],
    });
  });
});
