import { describe, expect, it } from 'vitest';
import type { Genome } from '@waypoint/genome-renderer';
import type { TraceData } from '@waypoint/sequence-utils';
import { buildSharedSequenceReadScene } from './shared-sequence-read-model';

type PartialAlignmentLane = {
  readonly id: string;
  readonly kind: 'alignment';
  readonly label: string;
  readonly alignedReference: string;
  readonly queryColumns: ReadonlyArray<string | null>;
};

type PartialAlignmentSceneInput = Omit<
  Parameters<typeof buildSharedSequenceReadScene>[0],
  'alignmentLanes'
> & {
  readonly alignmentLanes: ReadonlyArray<PartialAlignmentLane>;
};

const buildPartialAlignmentScene = buildSharedSequenceReadScene as unknown as (
  input: PartialAlignmentSceneInput
) => ReturnType<typeof buildSharedSequenceReadScene>;

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

  it('keeps the full reference axis and annotations for an explicit partial lane without a query string', () => {
    const partialLane: PartialAlignmentLane = {
      id: 'alignment-query-partial',
      kind: 'alignment',
      label: 'partial',
      alignedReference: 'ATGAAACCCGGGTAA',
      queryColumns: [
        null,
        null,
        null,
        null,
        null,
        null,
        'C',
        'C',
        'T',
        'G',
        'G',
        'G',
        null,
        null,
        null,
      ],
    };
    const scene = buildPartialAlignmentScene({
      genome: {
        ...genome(),
        sequence: 'ATGAAACCCGGGTAA',
        length: 15,
        features: [{ ...genome().features![0], start: 12, end: 15 }],
      },
      documentId: 'partial-reference',
      coordinateSpace: { mode: 'gapped', gappedSequence: 'ATGAAACCCGGGTAA' },
      alignmentLanes: [partialLane],
    });

    expect(scene.genome).toMatchObject({
      sourceIdentity: 'partial-reference',
      sequence: 'ATGAAACCCGGGTAA',
      length: 15,
      features: [expect.objectContaining({ start: 12, end: 15 })],
    });
    expect(scene.axis.length).toBe(15);
    expect(scene.axis.biologicalLength).toBe(15);
    expect([0, 8, 14].map((position) => scene.axis.bioToColumn(position))).toEqual([0, 8, 14]);
    expect([0, 8, 14].map((column) => scene.axis.columnToBio(column))).toEqual([0, 8, 14]);
    expect(scene.lanes).toEqual([partialLane]);
    expect(scene.lanes[0]).not.toHaveProperty('alignedQuery');
  });
});
