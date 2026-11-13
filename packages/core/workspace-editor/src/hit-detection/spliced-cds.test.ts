import { describe, expect, it } from 'vitest';
import { buildSplicedCodingSequence } from '../translation/spliced-coding-sequence';
import {
  findSplicedCodonWithIndexAtPosition,
  findIntronAtPosition,
  orderedCdsSegments,
} from './spliced-cds';
import { translationIntronUnderCursor } from '../hooks/canvas-interaction-pointer';
import { DEFAULT_EDITOR_CONFIG } from '../types';

describe('spliced codon hit coordinates match translated exon order', () => {
  it('normalizes a terminal intron ending at the circular origin and admits its pointer hit', () => {
    const cds = {
      name: 'origin gap',
      type: 'CDS',
      start: 91,
      end: 12,
      direction: 1 as const,
      translationLane: 0,
      segments: [
        { start: 1, end: 12 },
        { start: 91, end: 98 },
      ],
    };
    const segments = orderedCdsSegments(cds);
    expect(findIntronAtPosition(99, segments, 100)).toEqual({ start: 98, end: 99 });
    expect(findIntronAtPosition(0, segments, 100)).toBeNull();
    const line = {
      lineIndex: 0,
      startPos: 90,
      endPos: 110,
      preOriginLength: 10,
      sequence: 'N'.repeat(20),
      complementSequence: 'N'.repeat(20),
      y: 0,
      annotations: [],
      annotationLaneCount: 0,
      classifiedCDSs: [cds],
      translationLaneCount: 1,
    };
    expect(
      translationIntronUnderCursor({
        line,
        position: 99,
        y: 14 + (DEFAULT_EDITOR_CONFIG.rowHeight * 0.9) / 2,
        scrollTop: 0,
        hitDetectionConfig: { ...DEFAULT_EDITOR_CONFIG, showResidueNumbers: false },
        showReverseComplement: true,
        hasForwardPrimers: false,
        hasReversePrimers: false,
        sequenceLength: 100,
      })
    ).toBe(true);
  });
  for (const strand of [1, -1] as const)
    for (const circular of [false, true]) {
      it(`keeps every codon and residue index for strand ${strand}, origin wrap ${circular}`, () => {
        const segments = circular
          ? [
              { start: 91, end: 100 },
              { start: 1, end: 7 },
              { start: 15, end: 26 },
            ]
          : [
              { start: 1, end: 10 },
              { start: 21, end: 27 },
              { start: 35, end: 46 },
            ];
        const cds = {
          name: 'spliced',
          type: 'CDS',
          start: circular ? 91 : 1,
          end: circular ? 26 : 46,
          direction: strand,
          segments,
          qualifiers: { codon_start: ['2'] },
        };
        const authoritative = buildSplicedCodingSequence(cds, 'N'.repeat(100));
        for (let index = 0; index < authoritative.proteinLength; index++) {
          const offset = authoritative.codonStartOffset + index * 3;
          const positions = authoritative.genomicCoordinateMap.slice(offset, offset + 3);
          for (const position of positions)
            expect(
              findSplicedCodonWithIndexAtPosition(position, segments, {
                strand,
                codonStartOffset: 1,
              })
            ).toEqual({
              start: Math.min(...positions),
              end: Math.max(...positions),
              codonIndex: index,
            });
        }
        expect(
          findSplicedCodonWithIndexAtPosition(authoritative.genomicCoordinateMap[0], segments, {
            strand,
            codonStartOffset: 1,
          })
        ).toBeNull();
        expect(
          findSplicedCodonWithIndexAtPosition(circular ? 10 : 15, segments, {
            strand,
            codonStartOffset: 1,
          })
        ).toBeNull();
      });
    }
});
