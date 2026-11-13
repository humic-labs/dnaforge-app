import { describe, it, expect } from 'vitest';
import { isSplicedCDS, buildSplicedCodingSequence } from './spliced-coding-sequence';
import type { Annotation } from '@waypoint/sequence-utils';

const SEQ = 'ACGT'.repeat(50);

const constructed: Annotation = {
  name: 'built-by-a-tool',
  type: 'CDS',
  start: 1,
  end: 100,
  direction: 1,
  segments: [
    { start: 1, end: 30 },
    { start: 61, end: 100 },
  ],
};

describe('isSplicedCDS — segments are the authority, not a stamped string', () => {
  it('treats a constructed segments-bearing CDS as spliced without _locationString', () => {
    expect(isSplicedCDS(constructed)).toBe(true);
  });

  it('still treats a parsed CDS with _locationString as spliced', () => {
    expect(
      isSplicedCDS({
        ...constructed,
        qualifiers: { _locationString: ['join(1..30,61..100)'] },
      })
    ).toBe(true);
  });

  it('still rejects an origin-spanning CDS (start > end) as unspliced', () => {
    expect(
      isSplicedCDS({
        ...constructed,
        start: 180,
        end: 20,
        segments: [
          { start: 180, end: 200 },
          { start: 1, end: 20 },
        ],
        qualifiers: { _locationString: ['join(180..200,1..20)'] },
      })
    ).toBe(false);
  });

  it('still rejects an EXPLICIT order() location even with segments present', () => {
    expect(
      isSplicedCDS({
        ...constructed,
        qualifiers: { _locationString: ['order(1..30,61..100)'] },
      })
    ).toBe(false);
  });

  it('rejects complement(order(...)) too', () => {
    expect(
      isSplicedCDS({
        ...constructed,
        direction: -1,
        qualifiers: { _locationString: ['complement(order(1..30,61..100))'] },
      })
    ).toBe(false);
  });

  it('still rejects a single-segment CDS', () => {
    expect(isSplicedCDS({ ...constructed, segments: [{ start: 1, end: 100 }] })).toBe(false);
  });

  it('still rejects a CDS with no segments', () => {
    expect(isSplicedCDS({ ...constructed, segments: undefined })).toBe(false);
  });

  it('actually splices a constructed CDS end-to-end (not just the predicate)', () => {
    const result = buildSplicedCodingSequence(constructed, SEQ);

    expect(result.codingSequence).toHaveLength(70);
    expect(result.genomicCoordinateMap).toHaveLength(70);
    expect(result.introns).toHaveLength(1);
    expect(result.introns[0].length).toBe(30);
  });

  it('writer and translator agree about the same constructed annotation', () => {
    expect(isSplicedCDS(constructed)).toBe(true);
    expect(buildSplicedCodingSequence(constructed, SEQ).codingSequence.length).toBeLessThan(
      constructed.end - constructed.start + 1
    );
  });
});

it('retains genuine exon gaps inside an origin-crossing CDS', () => {
  expect(
    isSplicedCDS(
      {
        type: 'CDS',
        name: 'circular splice',
        start: 180,
        end: 100,
        segments: [
          { start: 180, end: 195 },
          { start: 10, end: 40 },
          { start: 61, end: 100 },
        ],
      },
      200
    )
  ).toBe(true);
  expect(
    isSplicedCDS(
      {
        type: 'CDS',
        name: 'circular continuous',
        start: 180,
        end: 20,
        segments: [
          { start: 180, end: 200 },
          { start: 1, end: 20 },
        ],
      },
      200
    )
  ).toBe(false);
});
