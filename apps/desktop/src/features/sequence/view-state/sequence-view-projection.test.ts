// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Annotation, AnnotatedSequence } from '@waypoint/sequence-utils';
import {
  applySequenceStrandOverrides,
  complementBase,
  reverseComplement,
} from '@waypoint/sequence-utils';
import type { PrimerDisplay } from '@waypoint/workspace-editor';
import {
  buildSequenceViewProjection,
  projectAnnotationToSource,
  projectAnnotationToView,
  projectPrimersToView,
  projectSelectionToSourceRange,
  projectSequenceToView,
  projectSourceRangeToViewSelection,
  projectBackboneSegmentsToView,
  projectPlasmidToView,
  projectAssemblyScaffoldDigestMarkers,
} from './sequence-view-projection';

const baseSequence: AnnotatedSequence = {
  id: 'seq',
  name: 'seq',
  sequence: 'AAAACCCCGGGGTTTT',
  length: 16,
  circular: true,
  annotations: [
    { name: 'left', type: 'misc_feature', start: 2, end: 5, direction: 1 },
    { name: 'wrap', type: 'misc_feature', start: 14, end: 3, direction: -1 },
  ],
};

describe('sequence view projection', () => {
  it.each(['forward', 'reverse-complement'] as const)(
    'shares paired schema scar columns and highlights between both %s viewers',
    (orientation) => {
      const ends = ['TACT', 'AATG', 'AGGT', 'GCTT', 'GGAG'];
      const projection = buildSequenceViewProjection({
        sequenceLength: 0,
        circular: true,
        orientation,
        backboneSegments: ends.map((outgoingOverhang, i) => ({
          start: 0,
          end: 0,
          color: '#999',
          scaffold: {
            slotId: `s-${i}`,
            slotIndex: i,
            label: `Part ${i + 1}`,
            incomingOverhang: ends[(i + 4) % 5],
            outgoingOverhang,
            enzyme: 'BsaI',
          },
        })),
      });
      const canvas = projectSequenceToView(
        { ...baseSequence, sequence: '', length: 0, annotations: [] },
        projection
      );
      const map = projectPlasmidToView(
        { name: 'empty', sequence: '', length: 0, circular: true, features: [], primers: [] },
        projection
      );
      expect(map.sequence).toBe(canvas.sequence);
      expect(map.strandOverrides).toEqual(canvas.strandOverrides);
      expect(map.primers).toEqual([]);
      const markers = projectAssemblyScaffoldDigestMarkers(projection);
      expect(markers).toHaveLength(5);
      const rows = (['forward', 'reverse'] as const).map((strand) =>
        applySequenceStrandOverrides(
          canvas.sequence,
          0,
          canvas.length,
          canvas.strandOverrides,
          strand
        )
      );
      for (const [i, marker] of markers.entries()) {
        const expected = ends[(i + 4) % 5];
        const top = orientation === 'forward' ? expected : reverseComplement(expected);
        expect(rows[0].slice(marker.start, marker.start + 4)).toBe(top);
        expect(rows[1].slice(marker.start, marker.start + 4)).toBe(
          Array.from(top, complementBase).join('')
        );
        expect(marker).toMatchObject({
          isScarMarkerOnly: true,
          scarAbsolutePosition: marker.start,
          enzymeName: 'BsaI',
        });
        expect(
          projectSelectionToSourceRange({ start: marker.start, end: marker.start + 3 }, projection)
        ).toEqual({ start: 0, end: 0 });
      }
    }
  );

  it.each(['forward', 'reverse-complement'] as const)(
    'keeps exposed digest bases on their actual strand in the %s view',
    (orientation) => {
      const projection = buildSequenceViewProjection({
        sequenceLength: 16,
        circular: true,
        orientation,
        backboneSegments: [
          {
            start: 8,
            end: 8,
            color: '#999',
            scaffold: {
              slotId: 'missing',
              slotIndex: 1,
              label: 'CDS',
              incomingOverhang: 'TATG',
              outgoingOverhang: 'GGGG',
              exposedDigestEnds: {
                preceding: { overhang: 'TATG', enzyme: 'BsaI', junctionIndex: 0 },
                following: { overhang: 'GGGG', enzyme: 'BsaI', junctionIndex: 1 },
              },
            },
          },
        ],
      });
      const canvas = projectSequenceToView({ ...baseSequence, annotations: [] }, projection);
      const map = projectPlasmidToView(
        {
          name: 'assembly',
          sequence: baseSequence.sequence,
          length: 16,
          circular: true,
          features: [],
          primers: [],
        },
        projection
      );
      const label = '.......... CDS ..........';
      const labelStart = orientation === 'forward' ? 12 : 8;
      expect(canvas.strandOverrides?.find((override) => override.kind === 'label')).toEqual({
        start: labelStart,
        kind: 'label',
        forward: label,
        reverse: label,
      });
      expect(canvas.strandOverrides?.filter((override) => override.kind !== 'label')).toEqual(
        orientation === 'forward'
          ? [
              { start: 8, forward: '    ', reverse: 'ATAC' },
              { start: 37, reverse: '    ' },
            ]
          : [
              { start: 33, forward: 'CATA', reverse: '    ' },
              { start: 4, forward: '    ' },
            ]
      );
      expect(map.strandOverrides).toEqual(canvas.strandOverrides);
      for (const strand of ['forward', 'reverse'] as const) {
        expect(
          applySequenceStrandOverrides(
            canvas.sequence,
            0,
            canvas.length,
            canvas.strandOverrides,
            strand
          ).slice(labelStart, labelStart + label.length)
        ).toBe(label);
      }
      const markers = projectAssemblyScaffoldDigestMarkers(projection);
      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        start: orientation === 'forward' ? 8 : 33,
        end: orientation === 'forward' ? 12 : 37,
        scarAbsolutePosition: orientation === 'forward' ? 8 : 33,
        direction: 'forward',
        isScarMarkerOnly: true,
      });
      expect(canvas.sequence).toBe('AAAACCCC' + '.'.repeat(29) + 'GGGGTTTT');
      expect(baseSequence.sequence).toBe('AAAACCCCGGGGTTTT');
    }
  );
  it('does not copy the next component when a selection ends inside a scaffold', () => {
    const projection = buildSequenceViewProjection({
      sequenceLength: 16,
      circular: false,
      backboneSegments: [
        {
          start: 8,
          end: 8,
          color: '#999',
          scaffold: {
            slotId: 's',
            slotIndex: 1,
            label: 'CDS',
            incomingOverhang: null,
            outgoingOverhang: null,
          },
        },
      ],
    });
    expect(projectSelectionToSourceRange({ start: 0, end: 20 }, projection)).toEqual({
      start: 0,
      end: 8,
    });
    expect(projectSelectionToSourceRange({ start: 12, end: 20 }, projection)).toEqual({
      start: 8,
      end: 8,
    });
  });
  it('renders an entirely empty schema through both existing viewer models', () => {
    const segments = [0, 1, 2, 3].map((i) => ({
      start: 0,
      end: 0,
      color: '#999',
      regionId: `empty-${i}`,
      scaffold: {
        slotId: `slot-${i}`,
        slotIndex: i,
        label: `Part ${i + 1}`,
        incomingOverhang: null,
        outgoingOverhang: null,
      },
    }));
    const projection = buildSequenceViewProjection({
      sequenceLength: 0,
      circular: true,
      backboneSegments: segments,
    });
    const canvas = projectSequenceToView(
      { ...baseSequence, sequence: '', length: 0, annotations: [] },
      projection
    );
    const map = projectPlasmidToView(
      {
        id: 'empty',
        name: 'empty',
        sequence: '',
        length: 0,
        circular: true,
        features: [],
        primers: [],
      },
      projection
    );
    expect(canvas.sequence).toBe('.'.repeat(112));
    expect(map.sequence).toBe(canvas.sequence);
    expect(map.features).toEqual([]);
    expect(map.primers).toEqual([]);
    expect(
      projectBackboneSegmentsToView(segments, projection)?.map((s) => [s.start, s.end])
    ).toEqual([
      [0, 28],
      [28, 56],
      [56, 84],
      [84, 0],
    ]);
  });
  it.each(['forward', 'reverse-complement'] as const)(
    'reserves scaffold columns in every %s layer',
    (orientation) => {
      const source = {
        ...baseSequence,
        annotations: [{ name: 'right', type: 'CDS', start: 9, end: 15, direction: 1 as const }],
      };
      const segments = [
        { start: 0, end: 8, color: '#f00', regionId: 'a' },
        {
          start: 8,
          end: 8,
          color: '#999',
          regionId: 'empty',
          scaffold: {
            slotId: 's',
            slotIndex: 1,
            label: 'CDS',
            incomingOverhang: 'TATG',
            outgoingOverhang: 'ATCC',
          },
        },
        { start: 8, end: 16, color: '#00f', regionId: 'b' },
      ];
      const projection = buildSequenceViewProjection({
        sequenceLength: 16,
        circular: true,
        orientation,
        backboneSegments: segments,
      });
      const view = projectSequenceToView(source, projection);
      expect(view.sequence).toHaveLength(41);
      expect(view.sequence.match(/\./g)).toHaveLength(25);
      expect(source.sequence).toBe('AAAACCCCGGGGTTTT');
      const plasmid = projectPlasmidToView(
        {
          ...source,
          features: [{ ...source.annotations[0], direction: 'forward' }],
          primers: [],
        } as any,
        projection
      );
      expect(plasmid.sequence).toBe(view.sequence);
      expect(plasmid.features[0].start).toBe(view.annotations[0].start);
      expect(plasmid.features[0].end).toBe(view.annotations[0].end);
      expect(projectAnnotationToSource(view.annotations[0], projection)).toEqual(
        source.annotations[0]
      );
      const ranges = projectBackboneSegmentsToView(segments, projection)!;
      expect(ranges.find((r) => r.regionId === 'empty')).toMatchObject({ start: 8, end: 33 });
      const primer = {
        id: 'p',
        name: 'p',
        start: 9,
        end: 14,
        bases: 'GGGTT',
        direction: 'forward',
        tm: 0,
        gc: 0,
      } as PrimerDisplay;
      const displayedPrimer = projectPrimersToView([primer], projection)![0];
      expect(displayedPrimer.end - displayedPrimer.start).toBe(5);
      expect(
        projectSelectionToSourceRange(
          { start: displayedPrimer.start, end: displayedPrimer.end - 1 },
          projection
        )
      ).toMatchObject({ start: 9, end: 14 });
    }
  );
  it('re-indexes circular sequence data without mutating source coordinates', () => {
    const projection = buildSequenceViewProjection({
      sequenceLength: baseSequence.length,
      circular: true,
      orientation: 'forward',
      originOffset: 4,
    });

    const viewed = projectSequenceToView(baseSequence, projection);
    expect(viewed.sequence).toBe('CCCCGGGGTTTTAAAA');
    expect(baseSequence.sequence).toBe('AAAACCCCGGGGTTTT');
    expect(viewed.annotations[0]).toMatchObject({ name: 'left', start: 14, end: 1, direction: 1 });
    expect(projectAnnotationToSource(viewed.annotations[0], projection)).toMatchObject({
      name: 'left',
      start: 2,
      end: 5,
      direction: 1,
    });
  });

  it('projects a reverse-complement circular view with reversible annotation coordinates', () => {
    const projection = buildSequenceViewProjection({
      sequenceLength: baseSequence.length,
      circular: true,
      orientation: 'reverse-complement',
      originOffset: 4,
    });

    const viewed = projectSequenceToView(baseSequence, projection);
    expect(viewed.sequence).toBe('TTTTAAAACCCCGGGG');
    expect(projectAnnotationToView(baseSequence.annotations[0], projection)).toMatchObject({
      name: 'left',
      start: 16,
      end: 3,
      direction: -1,
    });
    expect(projectAnnotationToSource(viewed.annotations[0], projection)).toMatchObject({
      name: 'left',
      start: 2,
      end: 5,
      direction: 1,
    });
  });

  it('maps visible selections back to source ranges for copy/design operations', () => {
    const projection = buildSequenceViewProjection({
      sequenceLength: baseSequence.length,
      circular: true,
      orientation: 'reverse-complement',
      originOffset: 4,
    });

    expect(projectSelectionToSourceRange({ start: 0, end: 3 }, projection)).toEqual({
      start: 0,
      end: 4,
    });
    expect(projectSelectionToSourceRange({ start: 14, end: 1, wraps: true }, projection)).toEqual({
      start: 2,
      end: 6,
    });
  });

  it('maps source highlights into the visible coordinate space', () => {
    const projection = buildSequenceViewProjection({
      sequenceLength: baseSequence.length,
      circular: true,
      orientation: 'forward',
      originOffset: 12,
    });

    expect(
      projectSourceRangeToViewSelection({ start: 14, end: 2, wraps: true }, projection)
    ).toEqual({
      start: 2,
      end: 6,
    });
  });

  it('projects primers and flips primer direction in reverse-complement view', () => {
    const primers: PrimerDisplay[] = [
      {
        id: 'p1',
        name: 'primer',
        start: 2,
        end: 6,
        direction: 'forward',
        bases: 'AACG',
        tm: 10,
        gc: 50,
      },
    ];
    const projection = buildSequenceViewProjection({
      sequenceLength: 16,
      circular: true,
      orientation: 'reverse-complement',
      originOffset: 0,
    });

    expect(projectPrimersToView(primers, projection)[0]).toMatchObject({
      start: 10,
      end: 14,
      direction: 'reverse',
    });
  });
});
