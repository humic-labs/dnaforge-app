// @vitest-environment jsdom

import { codonFontSize } from '@waypoint/platform';
import { Container, type Text } from 'pixi.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Genome, RenderState } from '../../../types';
import type { TrackContract } from '../shared/lane-contracts';
import type { PathMapper } from '../shared/path-mapper';
import type { UnifiedLayout } from '../shared/track-layout';
import { OrfTrack } from './orf-track';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

function state(): RenderState {
  return {
    morph: 0,
    viewOffset: 0,
    zoom: 1,
    width: 400,
    height: 160,
    selectedIds: new Set(),
    hoveredId: null,
    highlightRange: null,
    cursorPosition: null,
    hoveredOrf: null,
    selectedOrf: null,
    hoveredCutSiteId: null,
    perfPanelVisible: false,
  };
}

function genome(overrides: Partial<Genome> = {}): Genome {
  return {
    name: 'orf-test',
    length: 120,
    circular: false,
    features: [],
    sequence: 'ATGAAATAA'.padEnd(120, 'A'),
    ...overrides,
  };
}

function linearPath(pixelsPerBp = 10): PathMapper {
  const y = 60;
  return {
    isArcMode: false,
    pixelsPerBp,
    viewStartBp: 0,
    viewEndBp: 120,
    rowHeight: 12,
    sequenceFontSize: 10,
    sequenceVisible: true,
    sequenceOpacity: 1,
    bpLeftX: (bp: number) => bp * pixelsPerBp,
    bpCenterX: (bp: number) => bp * pixelsPerBp + pixelsPerBp / 2,
    featureLabelPosAt: (bp: number, offsetPx: number) => ({
      x: bp * pixelsPerBp + pixelsPerBp / 2,
      y: y + offsetPx,
      angle: 0,
    }),
    featurePolygonAt: (startBp: number, endBp: number, offsetPx: number, halfHeight = 7) => {
      const x1 = startBp * pixelsPerBp;
      const x2 = endBp * pixelsPerBp;
      const cy = y + offsetPx;
      return [x1, cy - halfHeight, x2, cy - halfHeight, x2, cy + halfHeight, x1, cy + halfHeight];
    },
    isFeatureVisible: () => true,
  } as unknown as PathMapper;
}

function compactedPath(normalScale = 0.5, pixelsPerBp = 10): PathMapper {
  const y = 60;
  return {
    ...linearPath(pixelsPerBp),
    isArcMode: true,
    featureLabelPosAt: (bp: number, offsetPx: number) => ({
      x: bp * pixelsPerBp + pixelsPerBp / 2,
      y: y + offsetPx * normalScale,
      angle: 0,
    }),
    scaleNormalOffset: (baseOffsetPx: number) => baseOffsetPx * normalScale,
  } as unknown as PathMapper;
}

function orfLayout(overrides: Partial<UnifiedLayout> = {}): UnifiedLayout {
  return {
    orfForwardOffset: 0,
    orfReverseOffset: 20,
    orfLaneStep: 16,
    orfLaneHeight: 10,
    sequenceVisible: true,
    sequenceOpacity: 1,
    ...overrides,
  } as UnifiedLayout;
}

function orfContract(centerOffset: number): TrackContract {
  return {
    trackId: 'orfs',
    lod: 'hairline',
    side: 'above',
    lanes: [
      {
        laneIndex: 0,
        contractLaneIndex: 0,
        role: 'orf-forward',
        centerOffset,
        halfHeight: 5,
        minOffset: centerOffset - 5,
        maxOffset: centerOffset + 5,
      },
    ],
    allowedOverlap: [],
    zIndex: 25,
    opacity: 1,
    transitionProgress: 0,
  };
}

describe('OrfTrack', () => {
  it('packs overlapping ORFs into strand-specific lanes', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(
      genome({
        orfs: [
          { start: 0, end: 30, strand: '+', frame: 1, length: 31 },
          { start: 9, end: 39, strand: '+', frame: 1, length: 31 },
          { start: 60, end: 90, strand: '-', frame: -1, length: 31 },
        ],
      })
    );

    expect(track.getForwardLaneCount()).toBe(2);
    expect(track.getReverseLaneCount()).toBe(1);
  });

  it('renders detail chevrons with an ORF hit target', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(
      genome({
        orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }],
      })
    );

    track.render(linearPath(), state(), orfLayout(), 120, 'ATGAAATAA'.padEnd(120, 'A'));

    expect(track.hitTest(15, 60)).toEqual({
      start: 0,
      end: 8,
      strand: '+',
      frame: 1,
      length: 9,
    });
  });

  it('shrinks ORF amino-acid letters inside unchanged chevrons', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(genome({ orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }] }));
    const path = linearPath();
    const layout = orfLayout();
    const internals = track as unknown as {
      letterPool: Text[];
      graphics: { poly: (...args: unknown[]) => unknown };
    };
    const polySpy = vi.spyOn(internals.graphics, 'poly');
    track.render(path, state(), layout, 120, 'ATGAAATAA'.padEnd(120, 'A'));
    const letter = internals.letterPool[0];
    expect(letter.text).toBe('M');
    expect(letter.style.fontSize * letter.scale.x).toBeCloseTo(
      codonFontSize(path.sequenceFontSize) * 0.92,
      6
    );
    const points = polySpy.mock.calls[0][0] as number[];
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(layout.orfLaneHeight, 6);
    expect(Math.max(...xs) - points[2]).toBe(Math.round(layout.orfLaneHeight * 0.17));
    track.destroy();
  });

  it('keeps overview thin bars clickable before nucleotide detail appears', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(
      genome({
        orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }],
      })
    );

    track.render(
      linearPath(),
      state(),
      orfLayout({ sequenceVisible: false, sequenceOpacity: 0 }),
      120,
      'ATGAAATAA'.padEnd(120, 'A')
    );

    expect(track.hitTest(15, 60)).toMatchObject({ start: 0, end: 8, strand: '+' });
  });

  it('uses fill-state highlights instead of outlines for overview ORFs', () => {
    const renderOverview = (
      renderState: Partial<RenderState>,
      genomeOverrides: Partial<Genome> = {}
    ) => {
      const track = new OrfTrack(new Container());
      track.loadGenome(
        genome({
          orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }],
          ...genomeOverrides,
        })
      );
      const graphics = (
        track as unknown as {
          graphics: {
            fill: (...args: unknown[]) => unknown;
            setStrokeStyle: (...args: unknown[]) => unknown;
          };
        }
      ).graphics;
      const fillSpy = vi.spyOn(graphics, 'fill');
      const strokeStyleSpy = vi.spyOn(graphics, 'setStrokeStyle');

      track.render(
        linearPath(),
        { ...state(), ...renderState },
        orfLayout({ sequenceVisible: false, sequenceOpacity: 0 }),
        120,
        'ATGAAATAA'.padEnd(120, 'A')
      );

      const fill = fillSpy.mock.calls[0][0] as { color: number; alpha: number };
      const strokeCalls = strokeStyleSpy.mock.calls.length;
      track.destroy();
      return { fill, strokeCalls };
    };

    const base = renderOverview({});
    const hovered = renderOverview({ hoveredOrf: { start: 0, end: 8, strand: '+' } });
    const selected = renderOverview({ selectedOrf: { start: 0, end: 8, strand: '+' } });
    const candidate = renderOverview({}, { candidateOrf: { start: 0, end: 8, strand: '+' } });

    expect(hovered.fill.alpha).toBeGreaterThan(base.fill.alpha);
    expect(hovered.fill.color).not.toBe(base.fill.color);
    expect(selected.fill.alpha).toBeGreaterThan(hovered.fill.alpha);
    expect(selected.fill.color).not.toBe(base.fill.color);
    expect(candidate.fill.alpha).toBeGreaterThan(base.fill.alpha);
    expect(base.strokeCalls).toBe(0);
    expect(hovered.strokeCalls).toBe(0);
    expect(selected.strokeCalls).toBe(0);
    expect(candidate.strokeCalls).toBe(0);
  });

  it('keeps individual overview ORFs visible instead of locally culling compact geometry', () => {
    const track = new OrfTrack(new Container());
    const normalBandRenderable = vi.fn(() => false);
    track.loadGenome(
      genome({
        circular: true,
        orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }],
      })
    );

    track.render(
      {
        ...compactedPath(1, 0.001),
        isNormalBandRenderable: normalBandRenderable,
      },
      { ...state(), zoom: 0.5 },
      orfLayout({ sequenceVisible: false, sequenceOpacity: 0 }),
      120,
      'ATGAAATAA'.padEnd(120, 'A')
    );

    const debug = track.getDebugSnapshot();
    expect(debug.overviewIndividualDrawCount).toBe(1);
    expect(normalBandRenderable).not.toHaveBeenCalled();
  });

  it('uses the resolved lane contract instead of recomputing ORF offsets from layout', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(
      genome({
        orfs: [{ start: 0, end: 8, strand: '+', frame: 1, length: 9 }],
      })
    );

    track.render(
      linearPath(),
      state(),
      orfLayout({ sequenceVisible: false, sequenceOpacity: 0, orfForwardOffset: 0 }),
      120,
      'ATGAAATAA'.padEnd(120, 'A'),
      orfContract(40)
    );

    expect(track.hitTest(15, 60)).toBeNull();
    expect(track.hitTest(15, 100)).toMatchObject({ start: 0, end: 8, strand: '+' });
  });

  it('aggregates dense low-zoom ORF overview bars instead of drawing every ORF', () => {
    const track = new OrfTrack(new Container());
    const length = 100_000;
    const orfs = Array.from({ length: 5_000 }, (_, index) => ({
      start: index * 20,
      end: index * 20 + 8,
      strand: '+' as const,
      frame: 1,
      length: 9,
    }));
    track.loadGenome(
      genome({
        length,
        circular: true,
        sequence: 'A'.repeat(length),
        orfs,
      })
    );

    track.render(
      compactedPath(1, 0.001),
      { ...state(), zoom: 0.5 },
      orfLayout({ sequenceVisible: false, sequenceOpacity: 0 }),
      length,
      'A'.repeat(length)
    );

    const debug = track.getDebugSnapshot();
    expect(debug.overviewIndividualDrawCount).toBe(0);
    expect(debug.overviewBinDrawCount).toBeGreaterThan(0);
    expect(debug.overviewBinDrawCount).toBeLessThan(orfs.length / 10);
    expect(debug.hitCount).toBe(0);
  });

  it('keeps aggregated overview ORFs visible instead of locally culling compact geometry', () => {
    const track = new OrfTrack(new Container());
    const length = 100_000;
    const normalBandRenderable = vi.fn(() => false);
    const orfs = Array.from({ length: 5_000 }, (_, index) => ({
      start: index * 20,
      end: index * 20 + 8,
      strand: '+' as const,
      frame: 1,
      length: 9,
    }));
    track.loadGenome(
      genome({
        length,
        circular: true,
        sequence: 'A'.repeat(length),
        orfs,
      })
    );

    track.render(
      {
        ...compactedPath(1, 0.001),
        isNormalBandRenderable: normalBandRenderable,
      },
      { ...state(), zoom: 0.5 },
      orfLayout({ sequenceVisible: false, sequenceOpacity: 0 }),
      length,
      'A'.repeat(length)
    );

    const debug = track.getDebugSnapshot();
    expect(debug.overviewIndividualDrawCount).toBe(0);
    expect(debug.overviewBinDrawCount).toBeGreaterThan(0);
    expect(normalBandRenderable).not.toHaveBeenCalled();
  });

  it('scales detail chevron height with stadium lane compaction so packed ORF lanes do not overlap', () => {
    const track = new OrfTrack(new Container());
    track.loadGenome(
      genome({
        orfs: [
          { start: 0, end: 8, strand: '+', frame: 1, length: 9 },
          { start: 0, end: 8, strand: '+', frame: 1, length: 9 },
        ],
      })
    );

    track.render(
      compactedPath(0.5),
      state(),
      orfLayout({ orfForwardOffset: 0, orfLaneStep: 16, orfLaneHeight: 12 }),
      120,
      'ATGAAATAA'.padEnd(120, 'A')
    );

    expect(track.hitTest(15, 60)).toMatchObject({ start: 0, end: 8, strand: '+' });
    expect(track.hitTest(15, 68)).toMatchObject({ start: 0, end: 8, strand: '+' });
    expect(track.hitTest(15, 64)).toBeNull();
  });
});
