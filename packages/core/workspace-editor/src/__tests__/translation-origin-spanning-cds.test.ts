// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { drawTranslation } from '../translation-drawing';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';
import type { ClassifiedCDS } from '../types';

const SEQUENCE = 'TAA' + 'C'.repeat(21) + 'ATG' + 'AAA';

const LINE_START = 24;
const LINE_END = 6;

const LINE_SEQUENCE = SEQUENCE.slice(LINE_START) + SEQUENCE.slice(0, LINE_END);

function context(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = 900;
  canvas.height = 300;
  return canvas.getContext('2d') as CanvasRenderingContext2D;
}

function cds(overrides: Partial<ClassifiedCDS> = {}): ClassifiedCDS {
  return {
    type: 'CDS',
    name: 'wrapper',
    start: 25,
    end: 3,
    direction: 1,
    cdsType: 'full',
    translationLane: 0,
    ...overrides,
  } as ClassifiedCDS;
}

function draw(
  cdsList: ClassifiedCDS[],
  extensionOptions: Parameters<typeof drawTranslation>[20] = {
    isCircularSequence: true,
    emitArrows: true,
  }
) {
  return drawTranslation(
    context(),
    LINE_SEQUENCE,
    cdsList,
    LINE_START,
    LINE_END,
    0,
    0,
    DEFAULT_EDITOR_CONFIG,
    SEQUENCE,
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
    extensionOptions
  );
}

describe('a synthetic circular origin runner, final codon straddling the junction', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  const syntheticCircularSequence = 'GA' + 'C'.repeat(2566) + 'ATG' + 'AAA'.repeat(38) + 'T';

  const extended = (): ClassifiedCDS =>
    ({
      type: 'CDS',
      name: 'synthetic origin runner',
      start: 2569,
      end: 2,
      direction: 1,
      cdsType: 'full',
      translationLane: 0,
    }) as ClassifiedCDS;

  function drawSynthetic(lineStart: number, lineEndExclusive: number) {
    const lineSequence =
      lineEndExclusive > lineStart
        ? syntheticCircularSequence.slice(lineStart, lineEndExclusive)
        : syntheticCircularSequence.slice(lineStart) +
          syntheticCircularSequence.slice(0, lineEndExclusive);
    return drawTranslation(
      context(),
      lineSequence,
      [extended()],
      lineStart,
      lineEndExclusive,
      0,
      0,
      DEFAULT_EDITOR_CONFIG,
      syntheticCircularSequence,
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

  it('sanity: the fixture is the molecule these numbers describe', () => {
    expect(syntheticCircularSequence.length).toBe(2686);
    const body = syntheticCircularSequence.slice(2568) + syntheticCircularSequence.slice(0, 2);
    expect(body.length).toBe(120);
    expect(body.length % 3).toBe(0);
    expect(body.slice(0, 3)).toBe('ATG');
    expect(body.slice(3, -3)).toBe('AAA'.repeat(38));
    expect(body.slice(-3)).toBe('TGA');
  });

  it('draws the straddling stop on the row that ENDS at the origin', () => {
    const { codons } = drawSynthetic(2640, 2686);
    const stop = codons.find((codon) => codon.aa === '*');
    expect(stop, 'the final codon must appear on the row holding its first base').toBeTruthy();
    expect([stop!.startPos, stop!.endPos]).toEqual([2685, 1]);
    expect(stop!.visibleStart).toBe(2685);
  });

  it('draws the straddling stop on the row that BEGINS at the origin', () => {
    const { codons } = drawSynthetic(0, 46);
    const stop = codons.find((codon) => codon.aa === '*');
    expect(stop, 'the final codon must ALSO appear on the row holding its last bases').toBeTruthy();
    expect([stop!.visibleStart, stop!.visibleEnd]).toEqual([0, 1]);
  });

  it('draws the straddling stop whole on a row that wraps the origin', () => {
    const { codons } = drawSynthetic(2631, 24);
    const stop = codons.find((codon) => codon.aa === '*');
    expect(stop).toBeTruthy();
    expect([stop!.visibleStart, stop!.visibleEnd]).toEqual([2685, 1]);
  });

  it('reaches the stop codon and does not run past it', () => {
    const rows: Array<[number, number]> = [
      [2568, 2614],
      [2614, 2660],
      [2660, 24],
      [24, 70],
    ];
    const seen = new Set<string>();
    for (const [start, end] of rows) {
      for (const codon of drawSynthetic(start, end).codons) {
        seen.add(`${codon.startPos}:${codon.endPos}`);
      }
    }
    expect(seen.size).toBe(40);
    expect(seen.has('2685:1')).toBe(true);
  });
});

describe('an origin-spanning CDS on the row that wraps', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  it('draws a cell for every codon, including the one past the origin', () => {
    const { codons } = draw([cds()]);
    expect(codons.map((codon) => [codon.startPos, codon.endPos, codon.codon])).toEqual([
      [24, 26, 'ATG'],
      [27, 29, 'AAA'],
      [0, 2, 'TAA'],
    ]);
  });

  it('translates the codon that straddles the origin correctly', () => {
    const { codons } = draw([cds()]);
    expect(codons.map((codon) => codon.aa)).toEqual(['M', 'K', '*']);
  });

  it('keeps the row from reserving a lane it then leaves blank', () => {
    const { codons } = draw([cds()]);
    expect(codons.some((codon) => codon.startPos < LINE_START)).toBe(true);
  });

  it('emits no arrows for a caller that does not ask for them', () => {
    const incomplete = cds({ start: 25, end: 29, name: 'clipped' });
    expect(draw([incomplete], {}).extensionArrows ?? []).toEqual([]);
    expect(
      draw([incomplete], { isCircularSequence: true, emitArrows: true }).extensionArrows ?? []
    ).not.toEqual([]);
  });

  it('still draws an ordinary CDS that happens to sit on a wrapping row', () => {
    const { codons } = draw([cds({ start: 25, end: 30, name: 'plain' })]);
    expect(codons.map((codon) => [codon.startPos, codon.endPos])).toEqual([
      [24, 26],
      [27, 29],
    ]);
  });
});
