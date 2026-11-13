// @vitest-environment jsdom

import { Container, Text } from 'pixi.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { translateCDS } from '../../../biology/translation';
import type { CodonInfo } from '../../../biology/translation';
import type { Feature, RenderState } from '../../../types';
import type { PathMapper } from '../shared/path-mapper';
import { CodonTrack } from './codon-track';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((id: string) =>
    id === '2d'
      ? ({
          font: '',
          measureText: (t: string) => ({ width: t.length * 6 }),
        } as unknown as CanvasRenderingContext2D)
      : null) as typeof HTMLCanvasElement.prototype.getContext;
});

const RESERVED_OFFSET = 40;
const BASE_Y = 60;

function state(overrides: Partial<RenderState> = {}): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 100_000,
    height: 400,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
    showResidueNumbers: true,
    ...overrides,
  };
}

function linearPath(pixelsPerBp: number): PathMapper {
  return {
    isArcMode: false,
    pixelsPerBp,
    viewStartBp: 0,
    rowHeight: 12,
    sequenceFontSize: 10,
    bpLeftX: (bp: number) => bp * pixelsPerBp,
    featureLabelPosAt: (bp: number, offsetPx: number) => ({
      x: bp * pixelsPerBp + pixelsPerBp / 2,
      y: BASE_Y + offsetPx,
      angle: 0,
    }),
    featurePolygonAt: (s: number, e: number, off: number, hh = 7) => {
      const cy = BASE_Y + off;
      return [
        s * pixelsPerBp,
        cy - hh,
        e * pixelsPerBp,
        cy - hh,
        e * pixelsPerBp,
        cy + hh,
        s * pixelsPerBp,
        cy + hh,
      ];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function feature(direction: 'forward' | 'reverse'): Feature {
  return {
    id: 1,
    type: 'CDS',
    start: 0,
    end: 30,
    direction,
    displayName: 'cds',
    color: 0x3b82f6,
    lane: 0,
  };
}

type Lbl = { text: string; x: number; y: number };
function residueLabels(track: CodonTrack): Lbl[] {
  const t = track as unknown as { residueLabelPool: Text[]; residueLabelIndex: number };
  return t.residueLabelPool
    .slice(0, t.residueLabelIndex)
    .map((o) => ({ text: o.text, x: o.x, y: o.y }));
}

const SEQ = 'CAT' + 'AGC'.repeat(8) + 'GGG';

describe('CodonTrack residue contract — real translateCDS, no pixels', () => {
  it('keeps deleted reference ghosts outside the query protein numbering', () => {
    const codons = translateCDS(SEQ, 0, 30, 'forward', 30, false);
    codons.splice(1, 0, {
      ...codons[0],
      aa: '-',
      display: undefined,
      residueIndex: undefined,
      mutation: {
        kind: 'deleted',
        referenceCodons: [{ codon: codons[0].codon, aa: codons[0].aa, residueIndex: 1 }],
        frameShifted: false,
        prematureStop: false,
        stopLost: false,
      },
    });
    const track = new CodonTrack(new Container());
    expect(() =>
      track.renderCodons(
        feature('forward'),
        codons,
        linearPath(12),
        0,
        30,
        state(),
        1,
        RESERVED_OFFSET
      )
    ).not.toThrow();
    expect(
      residueLabels(track)
        .map((label) => label.text)
        .filter((value) => value === '1')
    ).toEqual(['1']);
  });
  it('reverse strand: residue 1 is at the RIGHTMOST label, numbers DESCEND left→right', () => {
    const codons = translateCDS(SEQ, 0, 30, 'reverse', 30, false);
    expect(codons.length).toBeGreaterThan(2);

    const track = new CodonTrack(new Container());
    track.renderCodons(
      feature('reverse'),
      codons,
      linearPath(12),
      0,
      30,
      state(),
      1,
      RESERVED_OFFSET
    );

    const labels = residueLabels(track).sort((a, b) => a.x - b.x);
    const numbers = labels.map((l) => Number(l.text));

    const descending = numbers.every((n, i) => i === 0 || n < numbers[i - 1]);
    expect(numbers.length).toBeGreaterThan(2);
    expect(descending).toBe(true);
    expect(numbers[numbers.length - 1]).toBe(1);
  });

  it('forward strand: numbers ASCEND left→right (sanity, same machinery)', () => {
    const codons = translateCDS(SEQ, 0, 30, 'forward', 30, false);
    const track = new CodonTrack(new Container());
    track.renderCodons(
      feature('forward'),
      codons,
      linearPath(12),
      0,
      30,
      state(),
      1,
      RESERVED_OFFSET
    );
    const numbers = residueLabels(track)
      .sort((a, b) => a.x - b.x)
      .map((l) => Number(l.text));
    expect(numbers[0]).toBe(1);
    expect(numbers.every((n, i) => i === 0 || n > numbers[i - 1])).toBe(true);
  });

  it('every residue label is drawn at the RESERVED band offset, nowhere else', () => {
    const codons = translateCDS(SEQ, 0, 30, 'reverse', 30, false);
    const track = new CodonTrack(new Container());
    track.renderCodons(
      feature('reverse'),
      codons,
      linearPath(12),
      0,
      30,
      state(),
      1,
      RESERVED_OFFSET
    );
    const labels = residueLabels(track);
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) {
      expect(l.y).toBeCloseTo(BASE_Y + RESERVED_OFFSET, 5);
    }
  });

  it('NO reserved band (offset 0) ⇒ ZERO residue labels (never improvised)', () => {
    const codons = translateCDS(SEQ, 0, 30, 'reverse', 30, false);
    const track = new CodonTrack(new Container());

    track.renderCodons(feature('reverse'), codons, linearPath(12), 0, 30, state());
    expect(residueLabels(track)).toHaveLength(0);
  });

  it('control off ⇒ ZERO residue labels even with a reserved band', () => {
    const codons = translateCDS(SEQ, 0, 30, 'reverse', 30, false);
    const track = new CodonTrack(new Container());
    track.renderCodons(
      feature('reverse'),
      codons,
      linearPath(12),
      0,
      30,
      state({ showResidueNumbers: false }),
      1,
      RESERVED_OFFSET
    );
    expect(residueLabels(track)).toHaveLength(0);
  });

  it('phase-0 intron boundary residues stay discoverable under thinning', () => {
    const codons: CodonInfo[] = [];
    let bp = 0;
    for (let i = 1; i <= 12; i++) {
      if (i === 8) bp += 50;
      codons.push({
        startBp: bp,
        endBp: bp + 3,
        codonStartBp: bp,
        codonEndBp: bp + 2,
        codon: 'GCT',
        aa: 'A',
        isStop: false,
        isStart: i === 1,
        renderLetter: true,
        residueIndex: i,
      });
      bp += 3;
    }
    const track = new CodonTrack(new Container());

    track.renderCodons(
      feature('forward'),
      codons,
      linearPath(3),
      0,
      300,
      state(),
      1,
      RESERVED_OFFSET
    );
    const rendered = new Set(residueLabels(track).map((l) => Number(l.text)));
    expect(rendered.has(7)).toBe(true);
    expect(rendered.has(8)).toBe(true);

    expect(rendered.has(6)).toBe(false);
  });
});
