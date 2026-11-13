// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

const L = 30;
function ctx() {
  const c = document.createElement('canvas');
  c.width = 900;
  c.height = 300;
  return c.getContext('2d') as CanvasRenderingContext2D;
}

function drawWith(seq: string, cds: ClassifiedCDS, lineStart: number, lineEndExclusive: number) {
  const lineSeq =
    lineEndExclusive > lineStart
      ? seq.slice(lineStart, lineEndExclusive)
      : seq.slice(lineStart) + seq.slice(0, lineEndExclusive);
  return drawTranslation(
    ctx(),
    lineSeq,
    [cds],
    lineStart,
    lineEndExclusive,
    0,
    0,
    DEFAULT_EDITOR_CONFIG,
    seq,
    [],
    [],
    0,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { isCircularSequence: true, emitArrows: true }
  );
}
const basesOf = (r: ReturnType<typeof drawWith>) => {
  const set = new Set<number>();
  for (const c of r.codons) {
    let b = c.visibleStart;
    for (let i = 0; i < 3; i++) {
      set.add(b);
      if (b === c.visibleEnd) break;
      b = (b + 1) % L;
    }
  }
  return set;
};

describe('adversarial: every base of a wrapped CDS gets painted somewhere', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  const FWD = 'AA' + 'C'.repeat(24) + 'ATG' + 'T';
  const fwdCds = (): ClassifiedCDS =>
    ({
      type: 'CDS',
      name: 'f',
      start: 27,
      end: 2,
      direction: 1,
      cdsType: 'full',
      translationLane: 0,
    }) as ClassifiedCDS;

  it('forward: union over all row shapes covers every coding base', () => {
    const rows: Array<[number, number]> = [
      [0, 10],
      [10, 20],
      [20, 30],
      [24, 6],
      [18, 30],
      [0, 30],
    ];
    const union = new Set<number>();
    for (const [s, e] of rows) for (const b of basesOf(drawWith(FWD, fwdCds(), s, e))) union.add(b);
    expect([...union].sort((a, b) => a - b)).toEqual([0, 1, 26, 27, 28, 29]);
  });

  const revCds = (): ClassifiedCDS =>
    ({
      type: 'CDS',
      name: 'r',
      start: 27,
      end: 2,
      direction: -1,
      cdsType: 'full',
      translationLane: 0,
    }) as ClassifiedCDS;

  it('reverse: union over all row shapes covers every coding base', () => {
    const rows: Array<[number, number]> = [
      [0, 10],
      [10, 20],
      [20, 30],
      [24, 6],
      [18, 30],
      [0, 30],
    ];
    const union = new Set<number>();
    for (const [s, e] of rows) for (const b of basesOf(drawWith(FWD, revCds(), s, e))) union.add(b);
    expect([...union].sort((a, b) => a - b)).toEqual([0, 1, 26, 27, 28, 29]);
  });

  it('a single row showing the whole molecule paints both ends of the straddling codon', () => {
    const bases = basesOf(drawWith(FWD, fwdCds(), 0, 30));
    expect([...bases].sort((a, b) => a - b)).toEqual([0, 1, 26, 27, 28, 29]);
  });

  it('no codon is painted twice on the same row', () => {
    for (const [s, e] of [
      [0, 10],
      [24, 6],
      [0, 30],
    ] as Array<[number, number]>) {
      const cells = drawWith(FWD, fwdCds(), s, e).codons;
      const keys = cells.map((c) => `${c.startPos}:${c.visibleStart}:${c.visibleEnd}`);
      expect(new Set(keys).size, `row ${s}..${e}`).toBe(keys.length);
    }
  });

  it('an ordinary non-wrapped CDS is unaffected', () => {
    const plain = (): ClassifiedCDS =>
      ({
        type: 'CDS',
        name: 'p',
        start: 1,
        end: 9,
        direction: 1,
        cdsType: 'full',
        translationLane: 0,
      }) as ClassifiedCDS;
    const bases = basesOf(drawWith(FWD, plain(), 0, 30));
    expect([...bases].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
