// @vitest-environment node

import { describe, it, expect } from 'vitest';
import type { Feature } from '@waypoint/genome-renderer';
import {
  offsetFeatureToGlobal,
  offsetFeaturesToGlobal,
  offsetSequenceWindowToGlobal,
} from './assembly-feature-offset';

const base: Feature = {
  id: 'g1',
  type: 'mRNA',
  start: 100,
  end: 500,
  direction: 1,
  displayName: 'GENE1',
  color: 0x336699,
  lane: 0,
  exons: [
    { start: 100, end: 200 },
    { start: 400, end: 500 },
  ],
  cds: [{ start: 150, end: 450 }],
};

describe('offsetFeaturesToGlobal  assembly axis)', () => {
  it('shifts start/end and every exon + CDS sub-range by the offset', () => {
    const off = 2_000_000_000;
    const r = offsetFeatureToGlobal(base, off);
    expect(r.start).toBe(100 + off);
    expect(r.end).toBe(500 + off);
    expect(r.exons).toEqual([
      { start: 100 + off, end: 200 + off },
      { start: 400 + off, end: 500 + off },
    ]);
    expect(r.cds).toEqual([{ start: 150 + off, end: 450 + off }]);
    expect(r.id).toBe('g1');
    expect(r.displayName).toBe('GENE1');
    expect(r.lane).toBe(0);
  });

  it('shifts legacy splice segments and their join() qualifier to the same global axis', () => {
    const legacy: Feature = {
      id: 'legacy-splice',
      type: 'mRNA',
      start: 100,
      end: 500,
      direction: 'forward',
      displayName: 'LEGACY_SPLICE',
      color: 0x336699,
      lane: 0,
      segments: [
        { start: 101, end: 200 },
        { start: 401, end: 500 },
      ],
      qualifiers: { _locationString: 'join(101..200,401..500)' },
    };

    const r = offsetFeatureToGlobal(legacy, 1_000);

    expect(r.start).toBe(1_100);
    expect(r.end).toBe(1_500);
    expect(r.segments).toEqual([
      { start: 1_101, end: 1_200 },
      { start: 1_401, end: 1_500 },
    ]);
    expect(r.qualifiers?._locationString).toBe('join(1101..1200,1401..1500)');
    expect(legacy.segments?.[0]?.start).toBe(101);
    expect(legacy.qualifiers?._locationString).toBe('join(101..200,401..500)');
  });

  it('offset 0 is a no-op that returns the SAME array reference (single-chrom path)', () => {
    const arr = [base];
    const r = offsetFeaturesToGlobal(arr, 0);
    expect(r).toBe(arr);
  });

  it('preserves features with no exons/cds (e.g. flat BED-like features)', () => {
    const flat: Feature = {
      id: 'f',
      type: 'region',
      start: 10,
      end: 20,
      direction: 1,
      color: 0,
      lane: 0,
    };
    const r = offsetFeatureToGlobal(flat, 1000);
    expect(r).toEqual({ ...flat, start: 1010, end: 1020 });
    expect(r.exons).toBeUndefined();
    expect(r.cds).toBeUndefined();
  });

  it('maps a whole array, leaving inputs unmutated', () => {
    const r = offsetFeaturesToGlobal([base], 5);
    expect(r[0].start).toBe(105);
    expect(base.start).toBe(100);
  });
});

describe('offsetSequenceWindowToGlobal  nucleotides = deepest tile)', () => {
  const local = { startBp: 1000, endBp: 6000, generation: 3, byteCount: 5000, bases: 'ACGT' };

  it('shifts the window bounds by the offset; bases + metadata ride through', () => {
    const off = 248_956_422;
    const r = offsetSequenceWindowToGlobal(local, off);
    expect(r.startBp).toBe(1000 + off);
    expect(r.endBp).toBe(6000 + off);
    expect(r.bases).toBe('ACGT');
    expect(r.byteCount).toBe(5000);
    expect(r.generation).toBe(3);
  });

  it('offset 0 is a no-op returning the SAME object (single-chrom / anchor at global 0)', () => {
    const r = offsetSequenceWindowToGlobal(local, 0);
    expect(r).toBe(local);
  });

  it('leaves the input window unmutated', () => {
    offsetSequenceWindowToGlobal(local, 100);
    expect(local.startBp).toBe(1000);
    expect(local.endBp).toBe(6000);
  });

  it('round-trips: a local window offset to global maps back to the global viewport', () => {
    const globalStart = 248_956_422;
    const r = offsetSequenceWindowToGlobal({ startBp: 0, endBp: 128_000 }, globalStart);
    expect(r.startBp).toBe(globalStart);
    expect(r.endBp).toBe(globalStart + 128_000);
  });
});
