// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  selectCutSiteLabelsByDensity,
  MIN_VISIBLE_CUT_SITE_LABELS,
} from '../restriction-enzymes/cut-site-styling';
import { drawCutSites } from '../restriction-enzymes/drawCutSites';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { LayoutSnapshot2D, Layout2DRow, LinePositions, WorkspaceEditorConfig } from '../types';
import type { ColoredCutSite, RestrictionEnzyme } from '@waypoint/sequence-utils';
import {
  installRecordingCanvas,
  uninstallRecordingCanvas,
} from '../testing/recording-canvas-context';

const enzyme = (name: string): RestrictionEnzyme => ({ name }) as RestrictionEnzyme;

function site(name: string, pos: number): ColoredCutSite {
  return {
    enzyme: enzyme(name),
    cutPositionTop: pos,
    cutPositionBottom: pos + 4,
    recognitionStart: pos,
    recognitionEnd: pos + 6,
    strand: 'forward',
    color: '#3366cc',
  };
}

describe('selectCutSiteLabelsByDensity (pure density chooser)', () => {
  const sites = Array.from({ length: 20 }, (_, i) => site(`Enz${i}`, 5 + i * 5));
  const neverHovered = () => false;

  it('keeps a lone site', () => {
    const keep = selectCutSiteLabelsByDensity([sites[0]], () => 10, 5, neverHovered);
    expect(keep.has(sites[0])).toBe(true);
  });

  it('keeps every label when they comfortably fit the span', () => {
    const keep = selectCutSiteLabelsByDensity(sites, () => 10, 1000, neverHovered);
    expect(keep.size).toBe(sites.length);
  });

  it('culls labels when crowded — fewer than the site count, never zero', () => {
    const keep = selectCutSiteLabelsByDensity(sites, () => 10, 50, neverHovered);
    expect(keep.size).toBeLessThan(sites.length);
    expect(keep.size).toBeGreaterThanOrEqual(MIN_VISIBLE_CUT_SITE_LABELS);
  });

  it('never thins below the floor, even with huge labels and a tiny span', () => {
    const keep = selectCutSiteLabelsByDensity(sites, () => 100, 1, neverHovered);
    expect(keep.size).toBe(MIN_VISIBLE_CUT_SITE_LABELS);
  });

  it('always keeps a hovered label that density would otherwise cull', () => {
    const victim = sites[1];
    const culled = selectCutSiteLabelsByDensity(
      sites,
      () => 100,
      1,
      () => false
    );
    expect(culled.has(victim)).toBe(false);
    const withHover = selectCutSiteLabelsByDensity(
      sites,
      () => 100,
      1,
      (s) => s === victim
    );
    expect(withHover.has(victim)).toBe(true);
  });
});

describe('drawCutSites density culling — wired end to end', () => {
  beforeEach(() => installRecordingCanvas());
  afterEach(() => uninstallRecordingCanvas());

  const SEQ_LEN = 200;
  const makeSites = (n: number) => Array.from({ length: n }, (_, i) => site(`Enz${i}`, 5 + i * 9));

  function row(): Layout2DRow {
    return {
      lineIndex: 0,
      startPos: 0,
      endPos: SEQ_LEN,
      sequence: 'A'.repeat(SEQ_LEN),
      complementSequence: 'T'.repeat(SEQ_LEN),
      y: 0,
      annotations: [],
      annotationLaneCount: 0,
      translationLaneCount: 0,
    } as Layout2DRow;
  }
  function layoutFor(line: Layout2DRow, charWidth: number): LayoutSnapshot2D {
    return {
      lines: [line],
      totalHeight: 200,
      totalWidth: SEQ_LEN * charWidth + DEFAULT_EDITOR_CONFIG.marginLeft,
      sequenceLength: SEQ_LEN,
    };
  }
  function linePositionsFor(line: Layout2DRow): LinePositions[] {
    return [
      {
        line,
        annotationY: 0,
        translationY: 0,
        translationLaneCount: 0,
        sequenceY: 10,
        complementY: 32,
        mutationTrackY: 0,
        hasMutationTrack: false,
        rulerY: 80,
        forwardPrimerY: 56,
        reversePrimerY: 64,
        lineEndY: 90,
        hasPrimers: false,
        hasForwardPrimers: false,
        hasReversePrimers: false,
        absoluteLineY: 0,
        forwardOrfY: 0,
        reverseOrfY: 0,
        forwardOrfLaneCount: 0,
        reverseOrfLaneCount: 0,
      } as unknown as LinePositions,
    ];
  }

  const run = (
    sites: ColoredCutSite[],
    charWidth: number,
    hoveredEnzymeName: string | null = null
  ) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
    const config: WorkspaceEditorConfig = { ...DEFAULT_EDITOR_CONFIG, charWidth };
    const line = row();
    return drawCutSites(
      ctx,
      sites,
      layoutFor(line, charWidth),
      config,
      undefined,
      null,
      false,
      linePositionsFor(line),
      false,
      hoveredEnzymeName
    );
  };

  it('draws every label when zoomed in (wide charWidth → roomy span)', () => {
    const sites = makeSites(20);
    const rendered = run(sites, 20);
    expect(rendered.length).toBe(20);
  });

  it('drops labels when zoomed out (narrow charWidth → crowded span), with a floor', () => {
    const sites = makeSites(20);
    const rendered = run(sites, 1);
    expect(rendered.length).toBeLessThan(20);
    expect(rendered.length).toBeGreaterThanOrEqual(MIN_VISIBLE_CUT_SITE_LABELS);
  });

  it('keeps a hovered enzyme label even when density would cull it', () => {
    const sites = makeSites(20);
    const culled = run(sites, 1);
    const culledNames = new Set(culled.map((r) => r.cutSite.enzyme.name));
    const victim = sites.find((s) => !culledNames.has(s.enzyme.name))!;
    expect(victim).toBeDefined();
    const withHover = run(sites, 1, victim.enzyme.name);
    expect(withHover.some((r) => r.cutSite.enzyme.name === victim.enzyme.name)).toBe(true);
  });
});
