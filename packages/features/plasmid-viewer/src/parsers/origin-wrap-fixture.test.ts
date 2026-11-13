import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseGenBank } from './genbank';
import { isSplicedFeature } from '../utils/is-spliced-feature';

const FIXTURE_PATH = resolve(
  __dirname,
  '../../../../../test-fixtures/sequences/circular/origin-wrap-join-synthetic.gb'
);

describe('plasmid-viewer parseGenBank — origin-wrap (fixture-driven)', () => {
  const parsed = parseGenBank(readFileSync(FIXTURE_PATH, 'utf-8'));

  it('fixture loads with the expected length and topology', () => {
    expect(parsed.length).toBe(500);
    expect(parsed.circular).toBe(true);
  });

  it('case 1: complement-strand origin-wrap (URA3 shape) is rewritten', () => {
    const f = parsed.features.find((x) => x.displayName === 'ura3_like');
    expect(f, 'ura3_like must exist').toBeDefined();
    expect(f!.direction).toBe('reverse');
    expect(f!.start).toBe(451);
    expect(f!.end).toBe(50);
    expect(f!.segments).toEqual([
      { start: 451, end: 500 },
      { start: 1, end: 50 },
    ]);

    expect(isSplicedFeature(f!)).toBe(false);
  });

  it('case 2: real interior splice on circular sequence is preserved', () => {
    const f = parsed.features.find((x) => x.displayName === 'interior_splice');
    expect(f, 'interior_splice must exist').toBeDefined();
    expect(f!.direction).toBe('reverse');
    expect(f!.start).toBe(100);
    expect(f!.end).toBe(400);

    expect(isSplicedFeature(f!)).toBe(true);
  });

  it('case 3: forward-strand wrap baseline is unaffected', () => {
    const f = parsed.features.find((x) => x.displayName === 'forward_wrap');
    expect(f, 'forward_wrap must exist').toBeDefined();
    expect(f!.direction).toBe('forward');
    expect(f!.start).toBe(451);
    expect(f!.end).toBe(50);

    expect(isSplicedFeature(f!)).toBe(false);
  });

  it('strand guard: forward-strand ASCENDING join is NOT rewritten as wrap', () => {
    const content = readFileSync(
      resolve(
        __dirname,
        '../../../../../test-fixtures/sequences/circular/forward-strand-two-exon-synthetic.gb'
      ),
      'utf-8'
    );
    const r = parseGenBank(content);
    const f = r.features.find((x) => x.displayName === 'fwd_two_exon');
    expect(f, 'fwd_two_exon must exist').toBeDefined();
    expect(f!.direction).toBe('forward');
    expect(f!.start).toBe(1);
    expect(f!.end).toBe(500);
    expect(f!.segments).toEqual([
      { start: 1, end: 50 },
      { start: 451, end: 500 },
    ]);
    expect(isSplicedFeature(f!)).toBe(true);
  });
});
