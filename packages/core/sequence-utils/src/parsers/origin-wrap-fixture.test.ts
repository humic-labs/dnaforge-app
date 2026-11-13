import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseGenBankFull } from './genbank';

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../../test-fixtures/sequences/circular/origin-wrap-join-synthetic.gb'
);

describe('origin-wrap detection (fixture-driven)', () => {
  const parsed = parseGenBankFull(readFileSync(FIXTURE_PATH, 'utf-8'));

  it('fixture loads with the expected length and topology', () => {
    expect(parsed.length).toBe(500);
    expect(parsed.circular).toBe(true);
  });

  it('case 1: complement-strand origin-wrap → start > end + segments reordered', () => {
    const ann = parsed.annotations.find((a) => a.name === 'ura3_like');
    expect(ann, 'ura3_like must exist in fixture').toBeDefined();
    expect(ann!.direction).toBe(-1);
    expect(ann!.start).toBe(451);
    expect(ann!.end).toBe(50);
    expect(ann!.segments).toEqual([
      { start: 451, end: 500 },
      { start: 1, end: 50 },
    ]);
  });

  it('case 2: complement-strand interior splice → NOT classified as wrap', () => {
    const ann = parsed.annotations.find((a) => a.name === 'interior_splice');
    expect(ann, 'interior_splice must exist').toBeDefined();
    expect(ann!.direction).toBe(-1);
    expect(ann!.start).toBe(100);
    expect(ann!.end).toBe(400);
    expect(ann!.segments).toEqual([
      { start: 100, end: 150 },
      { start: 300, end: 400 },
    ]);
  });

  it('case 3: forward-strand origin-wrap (existing parser path) → start > end', () => {
    const ann = parsed.annotations.find((a) => a.name === 'forward_wrap');
    expect(ann, 'forward_wrap must exist').toBeDefined();
    expect(ann!.direction).toBe(1);
    expect(ann!.start).toBe(451);
    expect(ann!.end).toBe(50);
  });

  it('strand guard: forward-strand ASCENDING join(1..N,M..L) is NOT a wrap', () => {
    const content = readFileSync(
      resolve(
        __dirname,
        '../../../../../test-fixtures/sequences/circular/forward-strand-two-exon-synthetic.gb'
      ),
      'utf-8'
    );
    const r = parseGenBankFull(content);
    const ann = r.annotations.find((a) => a.name === 'fwd_two_exon');
    expect(ann, 'fwd_two_exon must exist').toBeDefined();
    expect(ann!.direction).toBe(1);
    expect(ann!.start).toBe(1);
    expect(ann!.end).toBe(500);
    expect(ann!.segments).toEqual([
      { start: 1, end: 50 },
      { start: 451, end: 500 },
    ]);
  });

  it('order() guard: complement(order(...)) with boundary-touching parts is NOT a wrap', () => {
    const content = readFileSync(
      resolve(
        __dirname,
        '../../../../../test-fixtures/sequences/circular/complement-order-boundary-synthetic.gb'
      ),
      'utf-8'
    );
    const r = parseGenBankFull(content);
    const ann = r.annotations.find((a) => a.name === 'order_test');
    expect(ann, 'order_test must exist').toBeDefined();
    expect(ann!.direction).toBe(-1);
    expect(ann!.start).toBe(1);
    expect(ann!.end).toBe(500);
  });
});
