import { describe, expect, it } from 'vitest';

import type { AnnotationRecord } from '@waypoint/genome-data';

import {
  CCRE_RECORD_TEXTURE_WIDTH,
  CCRE_MAX_RECORDS_PER_TILE,
  ccreDominantClassRule,
  packCcreRecords,
} from './ccre-dominant-class';

function rec(partial: Partial<AnnotationRecord>): AnnotationRecord {
  return {
    chrom: partial.chrom ?? 'chr11',
    start: partial.start ?? 0,
    end: partial.end ?? 100,
    name: partial.name,
    color: partial.color,
    strand: partial.strand,
    extra: partial.extra,
  };
}

function unpackColor(packedFloat: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = packedFloat;
  return new Uint32Array(buf)[0];
}

describe('ccreDominantClassRule (Phase 1 stub)', () => {
  it('exposes the contract fields', () => {
    expect(ccreDominantClassRule.type).toBe('annotation-encode-ccre');
    expect(ccreDominantClassRule.maxRecordsPerTile).toBe(CCRE_MAX_RECORDS_PER_TILE);
    expect(ccreDominantClassRule.vertexShader).toMatch(/#version 300 es/);
    expect(ccreDominantClassRule.fragmentShader).toMatch(/#version 300 es/);
    expect(() => ccreDominantClassRule.packRecords([])).toThrow(/requires laneAssignment/);
  });
});

describe('packCcreRecords (Phase 1)', () => {
  it('returns an empty buffer for empty input', () => {
    const out = packCcreRecords([], new Int16Array(0));
    expect(out.recordCount).toBe(0);
    expect(out.textureWidth).toBe(CCRE_RECORD_TEXTURE_WIDTH);
    expect(out.textureHeight).toBe(1);
    expect(out.componentsPerRecord).toBe(4);
  });

  it('throws when records.length !== laneAssignment.length', () => {
    const records = [rec({ start: 100, end: 200 })];
    expect(() => packCcreRecords(records, new Int16Array(0))).toThrow(/laneAssignment/);
  });

  it('packs a single record at index 0 of the texture', () => {
    const records = [rec({ start: 100, end: 200, color: 0xff0000 })];
    const out = packCcreRecords(records, new Int16Array([3]));
    expect(out.recordCount).toBe(1);
    expect(out.textureWidth).toBe(CCRE_RECORD_TEXTURE_WIDTH);
    expect(out.textureHeight).toBe(1);
    expect(out.data[0]).toBe(100);
    expect(out.data[1]).toBe(200);
    expect(out.data[2]).toBe(3);
    expect(unpackColor(out.data[3] as number)).toBe(0xff0000);
  });

  it('uses default color 0x3b82f6 when record.color is undefined', () => {
    const records = [rec({ start: 0, end: 50 })];
    const out = packCcreRecords(records, new Int16Array([0]));
    expect(unpackColor(out.data[3] as number)).toBe(0x3b82f6);
  });

  it('skips records with lane === -1 (dropped by maxLanes)', () => {
    const records = [
      rec({ start: 0, end: 100, color: 0x111111 }),
      rec({ start: 200, end: 300, color: 0x222222 }),
      rec({ start: 400, end: 500, color: 0x333333 }),
    ];
    const laneAssignment = new Int16Array([0, -1, 1]);
    const out = packCcreRecords(records, laneAssignment);
    expect(out.recordCount).toBe(2);
    expect(out.data[0]).toBe(0);
    expect(out.data[2]).toBe(0);
    expect(out.data[4]).toBe(400);
    expect(out.data[6]).toBe(1);
    expect(unpackColor(out.data[7] as number)).toBe(0x333333);
  });

  it('grows the texture height to fit visible record count', () => {
    const records: AnnotationRecord[] = [];
    const lanes: number[] = [];
    for (let i = 0; i < 200; i++) {
      records.push(rec({ start: i * 1000, end: i * 1000 + 500 }));
      lanes.push(i % 32);
    }
    const out = packCcreRecords(records, new Int16Array(lanes));
    expect(out.recordCount).toBe(200);
    expect(out.textureWidth).toBe(64);
    expect(out.textureHeight).toBe(Math.ceil(200 / 64));
    expect(out.data.length).toBe(out.textureWidth * out.textureHeight * 4);
  });

  it('round-trips RGB color through float-bits packing for various colors', () => {
    const palette = [0x3b82f6, 0xff8800, 0x22c55e, 0xef4444, 0x000000, 0xffffff];
    for (const color of palette) {
      const records = [rec({ start: 0, end: 100, color })];
      const out = packCcreRecords(records, new Int16Array([0]));
      expect(unpackColor(out.data[3] as number)).toBe(color);
    }
  });
});
