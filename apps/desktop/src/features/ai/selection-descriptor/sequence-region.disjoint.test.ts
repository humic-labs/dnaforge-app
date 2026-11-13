import { describe, it, expect } from 'vitest';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import { buildSequenceRegionDescriptor } from './sequence-region';
import type { SelectionRegion, SequenceDescriptorInput } from './types';

function seq(): AnnotatedSequence {
  return {
    id: 'x',
    name: 'triad-host',
    sequence: 'A'.repeat(300),
    length: 300,
    annotations: [],
    circular: false,
  };
}

const TRIAD_REGIONS: SelectionRegion[] = [
  {
    codingDnaMapped: true,
    start: 191,
    end: 193,
    strand: '+',
    residues: [{ chain: 'A', residueNumber: 10, proteinResidue: 1 }],
  },
  {
    codingDnaMapped: true,
    start: 206,
    end: 208,
    strand: '+',
    residues: [{ chain: 'A', residueNumber: 15, proteinResidue: 6 }],
  },
  {
    codingDnaMapped: true,
    start: 227,
    end: 229,
    strand: '+',
    residues: [{ chain: 'A', residueNumber: 22, proteinResidue: 13 }],
  },
];

function build(regions?: SelectionRegion[]) {
  const input: SequenceDescriptorInput & { range: { start: number; end: number } } = {
    kind: 'sequence_region',
    path: '/ws/triad-host.gb',
    range: { start: 191, end: 193 },
    ...(regions ? { regions } : {}),
  };
  return buildSequenceRegionDescriptor(input, seq(), 0);
}

describe('buildSequenceRegionDescriptor — disjoint multi-region ', () => {
  it('attaches measured.regions + disjoint + regionCount for a ≥2-region selection', () => {
    const descriptor = build(TRIAD_REGIONS);

    expect(descriptor.measured.disjoint).toBe(true);
    expect(descriptor.measured.regionCount).toBe(3);
    expect(descriptor.measured.regions).toEqual(TRIAD_REGIONS);

    expect(descriptor.measured.start).toBe(191);
    expect(descriptor.measured.end).toBe(193);
    expect(descriptor.measured.end).not.toBe(229);
  });

  it('passes an unmapped (codingDnaMapped:false) region through verbatim — no fabricated coords', () => {
    const withUnmapped: SelectionRegion[] = [
      TRIAD_REGIONS[0],
      {
        codingDnaMapped: false,
        strand: 'unspecified',
        reason: 'residue-not-in-coding-dna',
        residues: [{ chain: 'A', residueNumber: 999 }],
      },
    ];
    const descriptor = build(withUnmapped);

    expect(descriptor.measured.disjoint).toBe(true);
    const bucket = descriptor.measured.regions!.find((region) => !region.codingDnaMapped)!;
    expect(bucket.start).toBeUndefined();
    expect(bucket.end).toBeUndefined();
    expect(bucket.reason).toBe('residue-not-in-coding-dna');
  });

  it('is byte-identical (no disjoint keys) for a single contiguous selection', () => {
    const single = build();
    expect(single.measured.disjoint).toBeUndefined();
    expect(single.measured.regions).toBeUndefined();
    expect(single.measured.regionCount).toBeUndefined();
    expect('disjoint' in single.measured).toBe(false);
    expect('regions' in single.measured).toBe(false);

    const oneRegion = build([TRIAD_REGIONS[0]]);
    expect(oneRegion.measured.disjoint).toBeUndefined();
    expect('regions' in oneRegion.measured).toBe(false);
  });
});
