// @vitest-environment jsdom

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { SequenceTrack } from './sequence-track';
import type { LayoutModel } from '../shared/layout-model';
import { LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL } from '../shared/linear-sequence-glyph';
import * as sequenceGlyph from '../shared/linear-sequence-glyph';
import { webglThemeForMode } from '../shared/theme';

vi.mock('../shared/linear-sequence-glyph', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/linear-sequence-glyph')>()),
  linearSequenceGlyphVerticalMetrics: vi.fn(() => null),
}));

function linearModel(): LayoutModel {
  return {
    sequenceVisible: true,
    sequenceOpacity: 1,
    fwdStrandTop: 0,
    fwdStrandCenter: 8,
    fwdStrandBottom: 16,
    revStrandTop: 16,
    revStrandCenter: 24,
    revStrandBottom: 32,
    viewStartBp: 0,
    viewEndBp: 20,
    sequenceFontSize: 11,
    pixelsPerBp: 10,
  } as unknown as LayoutModel;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((contextId: string) => {
    if (contextId !== '2d') return null;
    return {
      font: '',
      measureText: (text: string) => ({ width: text.length * 6 }),
    } as unknown as CanvasRenderingContext2D;
  }) as typeof HTMLCanvasElement.prototype.getContext;
});

describe('gapped nucleotide change markup', () => {
  it('centers deletion strikes on the reference when a file alignment keeps it on the forward row', () => {
    const track = new SequenceTrack(new Container());
    try {
      track.renderLinear('ACGT', linearModel(), 40, undefined, {
        alignedQuery: 'A--T',
        referenceRow: 'forward',
        nucleotideChanges: [{ start: 1, end: 3, kind: 'deletion', color: 0xf44336 }],
      });
      expect(track.getDebugSnapshot().nucleotideStrikes).toEqual([
        expect.objectContaining({ start: 1, end: 3, x1: 10, x2: 30, y: 8 }),
      ]);
      expect(track.getLinearPaintSnapshot().queryRow).toEqual({ top: 16, bottom: 32 });
      expect(
        track.getDebugSnapshot().nucleotideHighlights.find((mark) => mark.source === 'original')?.y
      ).toBe(0);
    } finally {
      track.destroy();
    }
  });
  it('applies a mapped color to the actual glyphs and cell paint without moving them', () => {
    const track = new SequenceTrack(new Container());
    track.renderLinear('ACGT', linearModel(), 40, undefined, {
      alignedQuery: 'ACGT',
      nucleotideChanges: [
        {
          start: 1,
          end: 2,
          kind: 'insertion',
          color: 0x8a2be2,
          style: {
            text: { color: 0x8a2be2, alpha: 1 },
            background: { color: 0x8a2be2, alpha: 0.15 },
          },
        },
      ],
    });
    expect(track.fwdMap.get(1)?.tint).toBe(0x8a2be2);
    expect(track.revMap.get(1)?.tint).toBe(0x8a2be2);
    expect(
      track.getDebugSnapshot().nucleotideHighlights.every((mark) => mark.color === 0x8a2be2)
    ).toBe(true);
    track.destroy();
  });

  it('uses the 2D edit text colors and opacity, then restores ordinary letters', () => {
    const track = new SequenceTrack(new Container());
    const changes = [
      { start: 0, end: 1, kind: 'deletion' as const, color: 0xef4444 },
      { start: 1, end: 2, kind: 'insertion' as const, color: 0x22c55e },
      { start: 2, end: 3, kind: 'substitution' as const, color: 0xe09c07 },
    ];
    track.renderLinear('ACGT', linearModel(), 40, undefined, {
      alignedQuery: 'ACGT',
      nucleotideChanges: changes,
    });
    for (const map of [track.fwdMap, track.revMap]) {
      expect(map.get(0)).toMatchObject({ tint: 0xf44336, alpha: 0.6 });
      expect(map.get(1)).toMatchObject({ tint: 0x22c55e, alpha: 1 });
      expect(map.get(2)).toMatchObject({ tint: 0xe09c07, alpha: 1 });
    }
    track.renderLinear('ACGT', linearModel(), 40);
    expect(track.fwdMap.get(0)).toMatchObject({ tint: webglThemeForMode('light').text, alpha: 1 });
    track.destroy();
  });

  it.each([8, 16])('centers comparison markup on the glyph ink at font size %i', (fontSize) => {
    const metrics = vi.mocked(sequenceGlyph.linearSequenceGlyphVerticalMetrics);
    metrics.mockReturnValue({ top: -2, bottom: 8, strikeY: 3 });
    const track = new SequenceTrack(new Container());
    const rect = vi.spyOn(Graphics.prototype, 'rect');
    const moveTo = vi.spyOn(Graphics.prototype, 'moveTo');
    const scale = fontSize / 16;
    try {
      track.renderLinear('A--T', { ...linearModel(), sequenceFontSize: fontSize }, 40, undefined, {
        alignedQuery: 'ACGT',
        nucleotideChanges: [{ start: 1, end: 3, kind: 'deletion', color: 0xef4444 }],
      });
      const { x, y } = track.container;
      expect(rect).toHaveBeenCalledWith(10 - x, 3 * scale - y, 20, 16);
      expect(rect).toHaveBeenCalledWith(10 - x, 16 + 3 * scale - y, 20, 16);
      expect(moveTo).toHaveBeenCalledWith(10 - x, 24 + 3 * scale - y);
      expect(track.getLinearComparisonRowBounds()).toEqual({
        forward: { top: 3 * scale, bottom: 16 + 3 * scale },
        secondary: { top: 16 + 3 * scale, bottom: 32 + 3 * scale },
      });
    } finally {
      metrics.mockReturnValue(null);
      rect.mockRestore();
      moveTo.mockRestore();
      track.destroy();
    }
  });

  it('paints the actual aligned cells and strikes only the deleted original bases', () => {
    const track = new SequenceTrack(new Container());
    const rect = vi.spyOn(Graphics.prototype, 'rect');
    const moveTo = vi.spyOn(Graphics.prototype, 'moveTo');
    const lineTo = vi.spyOn(Graphics.prototype, 'lineTo');
    const presentation = {
      alignedQuery: 'ACGT--AC',
      nucleotideChanges: [
        { start: 2, end: 4, kind: 'deletion' as const, color: 0xef4444 },
        { start: 4, end: 6, kind: 'insertion' as const, color: 0x22c55e },
        { start: 6, end: 7, kind: 'substitution' as const, color: 0xe09c07 },
      ],
    };
    try {
      track.renderLinear(
        'AC--GTTC',
        { ...linearModel(), viewStartBp: 1.5, viewEndBp: 7.5 },
        60,
        undefined,
        presentation
      );
      const { x, y } = track.container;
      expect(rect).toHaveBeenCalledWith(5 - x, 0 - y, 20, 16);
      expect(rect).toHaveBeenCalledWith(5 - x, 16 - y, 20, 16);
      expect(rect).toHaveBeenCalledWith(25 - x, 0 - y, 20, 16);
      expect(rect).toHaveBeenCalledWith(45 - x, 0 - y, 10, 16);
      expect(moveTo).toHaveBeenCalledWith(5 - x, 24 - y);
      expect(lineTo).toHaveBeenCalledWith(25 - x, 24 - y);
      expect(track.getBackgroundDrawOpCount()).toBeGreaterThan(0);
      track.renderLinear('ACGTAC', linearModel(), 60);
      expect(track.getLinearComparisonRowBounds()).toBeNull();
      expect(track.getBackgroundDrawOpCount()).toBe(0);
      for (const graphics of track.container.children.filter(
        (child) => child instanceof Graphics
      )) {
        expect(graphics.context.instructions).toHaveLength(0);
      }
    } finally {
      rect.mockRestore();
      moveTo.mockRestore();
      lineTo.mockRestore();
      track.destroy();
    }
  });
});

describe('SequenceTrack recycling', () => {
  it.each([8, 14])(
    'matches wrapped nucleotide raster size at %i pixels per base in stadium mode',
    (pixelsPerBp) => {
      const track = new SequenceTrack(new Container());
      const css = document.documentElement.style;
      const originalForeground = css.getPropertyValue('--color-fg');

      css.setProperty('--color-fg', '0 0% 0%');
      try {
        track.renderArc(
          'acgt',
          0,
          4,
          1 / pixelsPerBp,
          (bp) => ({ x: bp * pixelsPerBp, y: 20, angle: 0 }),
          1,
          (bp) => ({ x: bp * pixelsPerBp, y: 40, angle: 0 }),
          { opacity: 1 }
        );
        const glyph = (track as unknown as { fwdMap: Map<number, Text> }).fwdMap.get(0)!;
        expect.soft(glyph.style.fontSize).toBeCloseTo((pixelsPerBp * 11) / 8, 8);
        expect.soft(glyph.scale.x).toBe(1);
        expect.soft(glyph.tint).toBe(0x000000);
      } finally {
        css.setProperty('--color-fg', originalForeground);
        track.destroy();
      }
    }
  );

  it('draws the complement strand in the document nucleic acid', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequence = 'AAGCAU';
    const reverseStrand = () => {
      track.renderArc(
        sequence,
        0,
        sequence.length,
        0.1,
        (bp) => ({ x: bp * 10, y: 20, angle: 0 }),
        1,
        (bp) => ({ x: bp * 10, y: 40, angle: 0 }),
        {}
      );
      return track
        .getDebugSnapshot()
        .revSample.slice(0, sequence.length)
        .map((base) => base.text)
        .join('');
    };
    try {
      expect(reverseStrand().toUpperCase()).toBe('TTCGTA');
      track.setNucleicAcid('rna');
      expect(reverseStrand().toUpperCase()).toBe('UUCGUA');
      track.setNucleicAcid('dna');
      expect(reverseStrand().toUpperCase()).toBe('TTCGTA');
    } finally {
      track.destroy();
    }
  });

  it('updates exposed digest letters without changing source DNA or waiting for a scroll', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequence = 'AAAA....CCCC';
    const render = (reverse?: string) =>
      track.renderArc(
        sequence,
        0,
        sequence.length,
        0.1,
        (bp) => ({ x: bp * 10, y: 20, angle: 0 }),
        1,
        (bp) => ({ x: bp * 10, y: 40, angle: 0 }),
        { strandOverrides: reverse ? [{ start: 4, reverse }] : undefined }
      );
    render('ATAC');
    expect(
      track
        .getDebugSnapshot()
        .fwdSample.slice(4, 8)
        .map((base) => base.text)
        .join('')
    ).toBe('....');
    expect(
      track
        .getDebugSnapshot()
        .revSample.slice(4, 8)
        .map((base) => base.text)
        .join('')
    ).toBe('ATAC');
    render('TGCA');
    expect(
      track
        .getDebugSnapshot()
        .revSample.slice(4, 8)
        .map((base) => base.text)
        .join('')
    ).toBe('TGCA');
    render();
    expect(
      track
        .getDebugSnapshot()
        .revSample.slice(4, 8)
        .map((base) => base.text)
        .join('')
    ).toBe('....');
    expect(sequence).toBe('AAAA....CCCC');
    track.destroy();
    parent.destroy();
  });
  const recyclePoolLimitPerStrand = 3072;

  it('bounds arbitrary raster-size styles with LRU reuse', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const debug = track as unknown as {
      stylesForRasterSize: (rasterSize: number) => object;
      sizedStyleCache: Map<string, object>;
    };
    const first = debug.stylesForRasterSize(1);
    for (let rasterSize = 2; rasterSize <= 32; rasterSize++) {
      debug.stylesForRasterSize(rasterSize);
    }
    expect(debug.stylesForRasterSize(1)).toBe(first);
    debug.stylesForRasterSize(33);

    expect(debug.sizedStyleCache.size).toBe(32);
    expect(debug.stylesForRasterSize(2)).not.toBe(first);
    expect(debug.stylesForRasterSize(1)).toBe(first);
    track.destroy();
    parent.destroy();
  });

  function linearModel(overrides: Partial<LayoutModel> = {}): LayoutModel {
    return {
      viewportWidth: 800,
      viewportHeight: 220,
      bpPerPixel: 1,
      pixelsPerBp: 1,
      viewStartBp: 100,
      viewEndBp: 112,
      sequenceFontSize: 12,
      rowHeight: 18,
      sequenceVisible: true,
      sequenceOpacity: 1,
      annotationLanes: 0,
      translationLanes: 0,
      annotationTop: 0,
      annotationHeight: 0,
      translationTop: 0,
      translationLaneHeight: 0,
      translationHeight: 0,
      fwdStrandTop: 20,
      fwdStrandCenter: 29,
      fwdStrandBottom: 38,
      revStrandTop: 40,
      revStrandCenter: 49,
      revStrandBottom: 58,
      rulerY: 62,
      totalHeight: 66,
      cutLineTop: 18,
      cutLineBottom: 60,
      cutLineConnectorY: 39,
      cutLabelY: 74,
      ...overrides,
    };
  }

  it('uses the native second row for recorded aligned DNA and hides an omitted complement row', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const model = linearModel({ viewStartBp: 0, viewEndBp: 4 });
    track.renderLinear('a-gt', model, 800, undefined, { alignedQuery: 'ac-t' });
    expect(track.getLinearPaintSnapshot()).toMatchObject({
      kind: 'alignment',
      visible: true,
      forwardGlyphs: 4,
      secondaryGlyphs: 4,
      visibleStart: 0,
      visibleEnd: 4,
      queryRow: { top: model.fwdStrandTop, bottom: model.fwdStrandBottom },
    });
    expect(
      track
        .getDebugSnapshot()
        .fwdSample.map((base) => base.text)
        .join('')
    ).toBe('a-gt');
    expect(
      track
        .getDebugSnapshot()
        .revSample.map((base) => base.text)
        .join('')
    ).toBe('ac-t');
    expect(
      track.getLinearNucleotidePresentationAudit(0, 4, 'a-gt').reverse.sourceMismatchCount
    ).toBe(0);
    track.renderLinear('a-gt', model, 800, undefined, { showReverseComplement: false });
    expect(track.getDebugSnapshot().revVisible).toBe(0);
    expect(track.getLinearPaintSnapshot()).toMatchObject({
      kind: 'sequence',
      secondaryGlyphs: 0,
      queryRow: null,
    });
    expect(
      track.getLinearNucleotidePresentationAudit(0, 4, 'a-gt').reverse.requiredViewportGlyphCount
    ).toBe(0);
    track.renderLinear('a-gt', model, 800);
    expect(
      track
        .getDebugSnapshot()
        .revSample.map((base) => base.text)
        .join('')
    ).toBe('t-ca');
    track.destroy();
    parent.destroy();
  });

  it('renders linear nucleotides from a bounded sequence window without requiring whole sequence', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);

    track.renderLinear(undefined, linearModel(), 800, {
      startBp: 96,
      bases: 'acgtacgtacgtacgt',
    });

    const debug = track.getDebugSnapshot();
    expect(debug.glyphContract).toBe('reference-sequence-text-v1');
    expect(debug.fwdVisible).toBe(16);
    expect(debug.revVisible).toBe(16);
    expect(debug.fwdSample[0]).toMatchObject({ bp: 96, text: 'a' });
    expect(debug.revSample[0]).toMatchObject({ bp: 96, text: 't' });

    track.destroy();
    parent.destroy();
  });

  it('audits every visible nucleotide against the streamed source and glyph contract', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 96, bases: 'acgt'.repeat(8) };

    track.renderLinear(undefined, linearModel(), 800, sequenceWindow);
    expect(
      track.getLinearNucleotidePresentationAudit(100, 112, undefined, sequenceWindow)
    ).toMatchObject({
      contract: 'indexed-nucleotide-glyph-presentation.v1',
      glyphContract: 'reference-sequence-text-v1',
      expectedFontFamily: '"JetBrains Mono", "SF Mono", "Fira Code", monospace',
      requiredViewportBaseCount: 12,
      sourceCoveredViewportBaseCount: 12,
      forward: {
        requiredViewportGlyphCount: 12,
        missingViewportBpCount: 0,
        hiddenViewportGlyphCount: 0,
        sourceMismatchCount: 0,
        unknownSubstitutionCount: 0,
        fallbackFontGlyphCount: 0,
        invalidTextGlyphCount: 0,
      },
      reverse: {
        requiredViewportGlyphCount: 12,
        missingViewportBpCount: 0,
        hiddenViewportGlyphCount: 0,
        sourceMismatchCount: 0,
        unknownSubstitutionCount: 0,
        fallbackFontGlyphCount: 0,
        invalidTextGlyphCount: 0,
      },
    });

    track.fwdMap.get(100)!.text = 'n';
    track.fwdMap.delete(101);
    track.revMap.get(102)!.visible = false;
    track.revMap.get(103)!.style = new TextStyle({ fontFamily: 'monospace' });
    track.revMap.get(104)!.text = '?';

    const corrupted = track.getLinearNucleotidePresentationAudit(
      100,
      112,
      undefined,
      sequenceWindow
    );
    expect(corrupted.forward).toMatchObject({
      missingViewportBpCount: 1,
      sourceMismatchCount: 1,
      unknownSubstitutionCount: 1,
    });
    expect(corrupted.reverse).toMatchObject({
      hiddenViewportGlyphCount: 1,
      sourceMismatchCount: 1,
      fallbackFontGlyphCount: 1,
      invalidTextGlyphCount: 1,
    });

    track.destroy();
    parent.destroy();
  });

  it('uses one Pixi render group to pan retained linear glyphs without rewriting them', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 96, bases: 'acgt'.repeat(40) };
    const initialModel = linearModel({
      viewStartBp: 100,
      viewEndBp: 112,
      pixelsPerBp: 1,
      bpPerPixel: 1,
    });

    track.renderLinear(undefined, initialModel, 800, sequenceWindow);
    const retained = track.fwdMap.get(104);
    const initialLocalX = retained?.x;
    const initial = track.getDebugSnapshot();

    track.renderLinear(
      undefined,
      linearModel({
        viewStartBp: 102,
        viewEndBp: 114,
        pixelsPerBp: 1,
        bpPerPixel: 1,
      }),
      800,
      sequenceWindow
    );
    const panned = track.getDebugSnapshot();

    expect(initial.renderGroupEnabled).toBe(true);
    expect(panned.renderGroupEnabled).toBe(true);
    expect(track.fwdMap.get(104)).toBe(retained);
    expect(track.fwdMap.get(104)?.x).toBe(initialLocalX);
    expect(panned.linearGeometryOriginBp).toBe(initial.linearGeometryOriginBp);
    expect(panned.linearPanOffsetPx).toBe(initial.linearPanOffsetPx - 2);
    expect(panned.lastLinearGlyphUpdateCount).toBeLessThan(panned.fwdVisible);
    expect(panned.lastLinearGlyphRecycleCount).toBeLessThan(panned.fwdVisible);

    track.renderLinear(
      undefined,
      linearModel({
        viewStartBp: 102,
        viewEndBp: 108,
        pixelsPerBp: 2,
        bpPerPixel: 0.5,
      }),
      800,
      sequenceWindow
    );
    const zoomed = track.getDebugSnapshot();

    expect(zoomed.linearGeometryOriginBp).toBe(102);
    expect(zoomed.linearGeometryPixelsPerBp).toBe(2);
    expect(zoomed.linearPanOffsetPx).toBe(0);
    expect(track.fwdMap.get(104)?.x).not.toBe(initialLocalX);

    track.destroy();
    parent.destroy();
  });

  it('keeps the linear nucleotide row background transparent so selection wash remains visible', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const bg = (track as unknown as { bg: { fill: (opts?: unknown) => unknown } }).bg;
    const bgFillSpy = vi.spyOn(bg, 'fill');

    track.renderLinear(undefined, linearModel(), 800, {
      startBp: 96,
      bases: 'acgtacgtacgtacgt',
    });

    expect(bgFillSpy).not.toHaveBeenCalled();

    track.destroy();
    parent.destroy();
  });

  it('culls offscreen stadium nucleotide text before acquiring Pixi Text objects', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequence = 'atgc'.repeat(6_000);
    const position = (bp: number) => ({ x: bp * 2, y: 20, angle: 0 });
    const complementPosition = (bp: number) => ({ x: bp * 2, y: 36, angle: 0 });

    track.renderArc(sequence, 0, 600, 1, position, 1, complementPosition, {
      opacity: 1,
      screenBounds: { xMin: -10, yMin: 0, xMax: 210, yMax: 50 },
    });

    const debug = track.getDebugSnapshot();
    expect(debug.fwdVisible).toBeGreaterThan(90);
    expect(debug.fwdVisible).toBeLessThan(130);
    expect(debug.revVisible).toBe(debug.fwdVisible);
    expect(debug.lastRequestedBaseCount).toBeGreaterThan(600);
    expect(debug.lastRenderedBaseCount).toBe(debug.fwdVisible);
    expect(debug.lastScreenCulledBaseCount).toBeGreaterThan(500);
    expect(track.fwdMap.has(0)).toBe(true);
    expect(track.fwdMap.has(100)).toBe(true);
    expect(track.fwdMap.has(300)).toBe(false);
    expect(track.revMap.has(300)).toBe(false);

    track.destroy();
    parent.destroy();
  });

  it('refreshes retained stadium nucleotide glyphs when sequence content changes in place', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const position = (bp: number) => ({ x: bp * 20, y: 20, angle: 0 });
    const complementPosition = (bp: number) => ({ x: bp * 20, y: 36, angle: 0 });

    track.renderArc('aaaa', 0, 4, 0.1, position, 1, complementPosition, { opacity: 1 });
    const retainedForwardGlyph = track.fwdMap.get(1);
    const retainedReverseGlyph = track.revMap.get(1);
    expect(retainedForwardGlyph?.text).toBe('a');
    expect(retainedReverseGlyph?.text).toBe('t');

    track.renderArc('acaa', 0, 4, 0.1, position, 1, complementPosition, { opacity: 1 });

    expect(track.fwdMap.get(1)).toBe(retainedForwardGlyph);
    expect(track.revMap.get(1)).toBe(retainedReverseGlyph);
    expect(track.fwdMap.get(1)?.text).toBe('c');
    expect(track.revMap.get(1)?.text).toBe('g');

    track.destroy();
    parent.destroy();
  });

  it('preserves source case and canonical IUPAC complements in stadium nucleotide glyphs', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const position = (bp: number) => ({ x: bp * 20, y: 20, angle: 0 });
    const complementPosition = (bp: number) => ({ x: bp * 20, y: 36, angle: 0 });

    track.renderArc('aRnY', 0, 4, 0.1, position, 1, complementPosition, { opacity: 1 });

    expect([...track.fwdMap.values()].map((glyph) => glyph.text)).toEqual(['a', 'R', 'n', 'Y']);
    expect([...track.revMap.values()].map((glyph) => glyph.text)).toEqual(['t', 'Y', 'n', 'R']);

    track.destroy();
    parent.destroy();
  });

  it('caps hidden nucleotide text objects so long sessions do not bloat the Pixi tree', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequence = 'atgc'.repeat(6_000);
    const position = (bp: number) => ({ x: bp * 2, y: 20, angle: 0 });
    const complementPosition = (bp: number) => ({ x: bp * 2, y: 36, angle: 0 });

    track.renderArc(sequence, 0, 3_000, 1, position, 1, complementPosition, { opacity: 1 });
    expect(track.getDebugSnapshot().fwdVisible).toBe(3_000);

    track.renderArc(sequence, 10_000, 10_200, 0.5, position, 1, complementPosition, {
      opacity: 1,
    });

    const debug = track.getDebugSnapshot();
    expect(debug.fwdRecycle).toBeLessThanOrEqual(recyclePoolLimitPerStrand);
    expect(debug.revRecycle).toBeLessThanOrEqual(recyclePoolLimitPerStrand);
    expect(debug.fwdChildren).toBeLessThanOrEqual(debug.fwdVisible + recyclePoolLimitPerStrand);
    expect(debug.revChildren).toBeLessThanOrEqual(debug.revVisible + recyclePoolLimitPerStrand);

    track.destroy();
    parent.destroy();
  });

  it('keeps bounded overlapping linear nucleotide glyphs attached for rapid zoom reuse', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(1_200) };

    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 3_000, pixelsPerBp: 1, bpPerPixel: 1 }),
      800,
      sequenceWindow
    );
    const broad = track.getDebugSnapshot();
    const retainedOutsideTightRange = track.fwdMap.get(100);
    expect(broad.fwdVisible).toBe(3_000);
    expect(broad.revVisible).toBe(3_000);
    expect(retainedOutsideTightRange).toBeDefined();

    track.renderLinear(
      undefined,
      linearModel({
        viewStartBp: 1_000,
        viewEndBp: 1_100,
        pixelsPerBp: 8,
        bpPerPixel: 0.125,
      }),
      800,
      sequenceWindow
    );
    const tight = track.getDebugSnapshot();
    expect(tight.fwdVisible).toBeLessThan(broad.fwdVisible);
    expect(tight.revVisible).toBeLessThan(broad.revVisible);
    expect(tight.fwdChildren).toBe(broad.fwdChildren);
    expect(tight.revChildren).toBe(broad.revChildren);
    expect(tight.linearRetainedFwdGlyphCount).toBe(broad.linearRetainedFwdGlyphCount);
    expect(tight.linearRetainedRevGlyphCount).toBe(broad.linearRetainedRevGlyphCount);
    expect(track.fwdMap.get(100)).toBe(retainedOutsideTightRange);
    expect(retainedOutsideTightRange?.visible).toBe(false);
    expect(retainedOutsideTightRange?.parent).not.toBeNull();
    const tightAudit = track.getLinearNucleotidePresentationAudit(
      1_000,
      1_100,
      undefined,
      sequenceWindow
    );
    expect(tightAudit.forward.glyphCount).toBe(tight.fwdVisible);
    expect(tightAudit.reverse.glyphCount).toBe(tight.revVisible);

    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 3_000, pixelsPerBp: 1, bpPerPixel: 1 }),
      800,
      sequenceWindow
    );
    const broadAgain = track.getDebugSnapshot();
    expect(broadAgain.fwdVisible).toBe(3_000);
    expect(broadAgain.revVisible).toBe(3_000);
    expect(broadAgain.fwdChildren).toBe(broad.fwdChildren);
    expect(broadAgain.revChildren).toBe(broad.revChildren);
    expect(track.fwdMap.get(100)).toBe(retainedOutsideTightRange);
    expect(retainedOutsideTightRange?.visible).toBe(true);

    track.destroy();
    parent.destroy();
  });

  it('retains bounded linear glyphs across a temporary missing-data frame and releases them on destroy', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const model = linearModel({
      viewStartBp: 0,
      viewEndBp: 1_000,
      pixelsPerBp: 1,
      bpPerPixel: 1,
    });
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(300) };

    track.renderLinear(undefined, model, 800, sequenceWindow);
    const retainedGlyph = track.fwdMap.get(100);
    const visible = track.getDebugSnapshot();
    expect(retainedGlyph).toBeDefined();

    track.renderLinear(undefined, model, 800);
    expect(track.getDebugSnapshot()).toMatchObject({
      fwdVisible: 0,
      revVisible: 0,
      linearRetainedFwdGlyphCount: visible.linearRetainedFwdGlyphCount,
      linearRetainedRevGlyphCount: visible.linearRetainedRevGlyphCount,
    });
    expect(retainedGlyph?.destroyed).toBe(false);

    track.renderLinear(undefined, model, 800, sequenceWindow);
    expect(track.fwdMap.get(100)).toBe(retainedGlyph);

    track.destroy();
    expect(retainedGlyph?.destroyed).toBe(true);
    expect(
      track as unknown as {
        readonly linearActiveSequenceWindow: unknown;
        readonly fwdMap: ReadonlyMap<number, Text>;
        readonly revMap: ReadonlyMap<number, Text>;
        readonly fwdRecycle: readonly Text[];
        readonly revRecycle: readonly Text[];
      }
    ).toMatchObject({
      linearActiveSequenceWindow: undefined,
      fwdMap: new Map(),
      revMap: new Map(),
      fwdRecycle: [],
      revRecycle: [],
    });
    parent.destroy();
  });

  it('severs renderer callbacks and cached owner state on destroy', () => {
    const parent = new Container();
    const prepare = vi.fn(async () => undefined);
    const track = new SequenceTrack(parent, prepare);
    const internals = track as unknown as {
      prepareLinearGlyphsForGpu: unknown;
      retainedLinearNucleotideLayer: unknown;
      readonly sizedStyleCache: ReadonlyMap<string, unknown>;
    };

    expect(internals.prepareLinearGlyphsForGpu).toBe(prepare);
    track.destroy();

    expect(internals.prepareLinearGlyphsForGpu).toBeUndefined();
    expect(internals.retainedLinearNucleotideLayer).toBeNull();
    expect(internals.sizedStyleCache.size).toBe(0);
    expect(track.container.destroyed).toBe(true);
    parent.destroy();
  });

  it('releases TextStyle listeners when hide-all overflows the detached recycle pool', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const style = new TextStyle({ fontSize: 12 });
    const evicted = new Text({ text: 'a', style });
    const debug = track as unknown as {
      fwdRecycle: Text[];
      fwdMap: Map<number, Text>;
      hideAll: () => void;
    };
    debug.fwdRecycle.length = recyclePoolLimitPerStrand;
    debug.fwdMap.set(0, evicted);
    expect(style.listenerCount('update')).toBe(1);

    debug.hideAll();

    expect(evicted.destroyed).toBe(true);
    expect(style.listenerCount('update')).toBe(0);
    debug.fwdRecycle.length = 0;
    track.destroy();
    parent.destroy();
  });

  it('hides a complete nucleotide owner without child-list mutations', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(1_200) };

    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 3_000, pixelsPerBp: 1, bpPerPixel: 1 }),
      800,
      sequenceWindow
    );
    expect(track.getDebugSnapshot().fwdVisible).toBe(3_000);

    const removeChild = vi.spyOn(Container.prototype, 'removeChild');
    const removeChildren = vi.spyOn(Container.prototype, 'removeChildren');
    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 3_000, pixelsPerBp: 1, bpPerPixel: 1 }),
      800
    );

    const hidden = track.getDebugSnapshot();
    expect(hidden.fwdVisible).toBe(0);
    expect(hidden.revVisible).toBe(0);
    expect(hidden.fwdRecycle).toBe(0);
    expect(hidden.revRecycle).toBe(0);
    expect(hidden.linearRetainedFwdGlyphCount).toBe(3_000);
    expect(hidden.linearRetainedRevGlyphCount).toBe(3_000);
    expect(removeChild).not.toHaveBeenCalled();
    expect(removeChildren).not.toHaveBeenCalled();

    removeChildren.mockRestore();
    removeChild.mockRestore();
    track.destroy();
    parent.destroy();
  });

  it('prewarms linear nucleotide glyphs before the sequence row becomes visible', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(1_200) };

    for (let frame = 0; frame < 16; frame += 1) {
      track.renderLinear(
        undefined,
        linearModel({
          viewStartBp: 0,
          viewEndBp: 40_000,
          pixelsPerBp: 0.03,
          bpPerPixel: 33.33,
          sequenceVisible: false,
          sequenceOpacity: 0,
        }),
        800,
        sequenceWindow
      );
    }

    const prewarmed = track.getDebugSnapshot();
    expect(prewarmed.fwdVisible).toBe(0);
    expect(prewarmed.revVisible).toBe(0);
    expect(prewarmed.fwdRecycle).toBe(128);
    expect(prewarmed.revRecycle).toBe(128);
    expect(prewarmed.fwdChildren).toBe(0);
    expect(prewarmed.revChildren).toBe(0);

    track.renderLinear(
      undefined,
      linearModel({
        viewStartBp: 0,
        viewEndBp: 96,
        pixelsPerBp: 8,
        bpPerPixel: 0.125,
      }),
      800,
      sequenceWindow
    );

    const visible = track.getDebugSnapshot();
    expect(visible.fwdVisible).toBeGreaterThanOrEqual(96);
    expect(visible.revVisible).toBe(visible.fwdVisible);
    expect(visible.fwdVisible).toBeLessThanOrEqual(prewarmed.fwdRecycle);
    expect(visible.fwdChildren).toBe(visible.fwdVisible);
    expect(visible.revChildren).toBe(visible.revVisible);

    track.destroy();
    parent.destroy();
  });

  it('moves bulk linear glyph prewarming into bounded idle slices', () => {
    const idleCallbacks = new Map<number, (deadline: { timeRemaining: () => number }) => void>();
    let nextIdleHandle = 1;
    const cancelIdleCallback = vi.fn((handle: number) => idleCallbacks.delete(handle));
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: (deadline: { timeRemaining: () => number }) => void) => {
        const handle = nextIdleHandle++;
        idleCallbacks.set(handle, callback);
        return handle;
      })
    );
    vi.stubGlobal('cancelIdleCallback', cancelIdleCallback);

    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(1_200) };
    const hiddenModel = linearModel({
      viewStartBp: 0,
      viewEndBp: 40_000,
      pixelsPerBp: 0.03,
      bpPerPixel: 33.33,
      sequenceVisible: false,
      sequenceOpacity: 0,
    });

    track.renderLinear(undefined, hiddenModel, 800, sequenceWindow);
    expect(track.getDebugSnapshot().fwdRecycle).toBe(8);

    for (let slice = 0; slice < 3; slice += 1) {
      const [handle, callback] = idleCallbacks.entries().next().value!;
      idleCallbacks.delete(handle);
      const before = track.getDebugSnapshot().fwdRecycle;

      const sliceClock = vi.spyOn(performance, 'now').mockReturnValue(0);
      try {
        callback({ timeRemaining: () => 50 });
      } finally {
        sliceClock.mockRestore();
      }
      const after = track.getDebugSnapshot().fwdRecycle;
      expect(after - before).toBeGreaterThan(0);
      expect(after - before).toBeLessThanOrEqual(16);
    }

    const afterIdleSlices = track.getDebugSnapshot();
    expect(afterIdleSlices.fwdRecycle).toBeGreaterThan(8);
    expect(afterIdleSlices.fwdRecycle).toBeLessThanOrEqual(56);
    expect(idleCallbacks.size).toBe(1);
    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 3_000, pixelsPerBp: 1, bpPerPixel: 1 }),
      800,
      sequenceWindow
    );
    const visible = track.getDebugSnapshot();
    expect(visible.fwdVisible).toBe(3_000);
    expect(visible.fwdChildren).toBe(3_000);

    const [pendingHandle, pendingCallback] = idleCallbacks.entries().next().value!;
    idleCallbacks.delete(pendingHandle);
    pendingCallback({ timeRemaining: () => 50 });
    const afterVisibleIdle = track.getDebugSnapshot();
    expect(afterVisibleIdle.fwdChildren).toBe(3_000);
    expect(afterVisibleIdle.revChildren).toBe(3_000);
    expect(idleCallbacks.size).toBe(0);

    track.renderLinear(
      undefined,
      { ...hiddenModel, pixelsPerBp: 0.01, bpPerPixel: 100 },
      800,
      sequenceWindow
    );
    const hiddenAgain = track.getDebugSnapshot();
    expect(hiddenAgain.fwdVisible).toBe(0);
    expect(hiddenAgain.revVisible).toBe(0);
    expect(hiddenAgain.fwdRecycle).toBe(0);
    expect(hiddenAgain.revRecycle).toBe(0);
    expect(hiddenAgain.linearRetainedFwdGlyphCount).toBe(3_000);
    expect(hiddenAgain.linearRetainedRevGlyphCount).toBe(3_000);
    expect(hiddenAgain.fwdChildren).toBe(0);
    expect(hiddenAgain.revChildren).toBe(0);

    track.destroy();
    expect(cancelIdleCallback).not.toHaveBeenCalled();
    parent.destroy();
    vi.unstubAllGlobals();
  });

  it('publishes actual dark-mode sequence content only after its successor is texture-ready', async () => {
    const idleCallbacks = new Map<number, (deadline: { timeRemaining: () => number }) => void>();
    let nextIdleHandle = 1;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: (deadline: { timeRemaining: () => number }) => void) => {
        const handle = nextIdleHandle++;
        idleCallbacks.set(handle, callback);
        return handle;
      })
    );
    vi.stubGlobal(
      'cancelIdleCallback',
      vi.fn((handle: number) => idleCallbacks.delete(handle))
    );

    const preparedTextBatches: string[][] = [];
    const preparedGlyphBatches: Text[][] = [];
    const parent = new Container();
    const track = new SequenceTrack(parent, async (glyphs) => {
      preparedTextBatches.push(glyphs.map((glyph) => String(glyph.text)));
      preparedGlyphBatches.push([...glyphs]);
    });
    const sequenceWindow = { startBp: 0, bases: 'acgt'.repeat(1_200) };
    const hiddenNearReveal = linearModel({
      viewportWidth: 800,
      viewStartBp: 0,
      viewEndBp: 8_000,
      pixelsPerBp: 0.1,
      bpPerPixel: 10,
      sequenceVisible: false,
      sequenceOpacity: 0,
    });
    const visible = linearModel({
      viewportWidth: 800,
      viewStartBp: 1_000,
      viewEndBp: 2_000,
      pixelsPerBp: 0.8,
      bpPerPixel: 1.25,
      sequenceVisible: true,
      sequenceOpacity: 1,
    });

    track.setTheme(webglThemeForMode('dark'));
    track.renderLinear(undefined, hiddenNearReveal, 800, sequenceWindow);

    const createText = vi.spyOn(
      track as unknown as { _createText: (style: unknown, container: unknown) => Text },
      '_createText'
    );
    const coldReveal = track.renderLinear(undefined, visible, 800, sequenceWindow);
    expect(coldReveal.preparationPending).toBe(true);
    expect(track.getDebugSnapshot()).toMatchObject({
      fwdVisible: 0,
      revVisible: 0,
      linearContentState: 'preparing',
      linearContentDeferredPresentationCount: 1,
    });
    expect(createText).not.toHaveBeenCalled();
    createText.mockRestore();

    for (let slice = 0; slice < 100; slice += 1) {
      if (track.getDebugSnapshot().linearContentState === 'ready') break;
      const next = idleCallbacks.entries().next().value as
        | [number, (deadline: { timeRemaining: () => number }) => void]
        | undefined;
      expect(next, `idle slice ${slice} must remain scheduled`).toBeDefined();
      const [handle, callback] = next!;
      idleCallbacks.delete(handle);
      callback({ timeRemaining: () => 50 });
      await Promise.resolve();
    }

    const prepared = track.getDebugSnapshot();
    expect(prepared.linearContentState).toBe('ready');
    expect(prepared.linearContentPreparedPairCount).toBeGreaterThanOrEqual(1_000);
    expect(prepared.linearContentGpuPendingBatches).toBe(0);
    expect(preparedTextBatches.flat()).toEqual(expect.arrayContaining(['a', 'c', 'g', 't']));
    expect(preparedGlyphBatches.flat().every((glyph) => glyph.visible === false)).toBe(true);

    const createTextOnPublish = vi.spyOn(
      track as unknown as { _createText: (style: unknown, container: unknown) => Text },
      '_createText'
    );
    const readyReveal = track.renderLinear(undefined, visible, 800, sequenceWindow);
    const published = track.getDebugSnapshot();
    expect(readyReveal.preparationPending).toBe(false);
    expect(published.linearContentPresentationCount).toBe(1);
    expect(published.fwdVisible).toBeGreaterThanOrEqual(1_000);
    expect(published.revVisible).toBe(published.fwdVisible);
    expect(track.fwdMap.values().next().value?.tint).toBe(webglThemeForMode('dark').text);
    expect(createTextOnPublish).not.toHaveBeenCalled();

    const equivalentWindow = { ...sequenceWindow };
    const equivalentRender = track.renderLinear(undefined, visible, 800, equivalentWindow);
    expect(equivalentRender.preparationPending).toBe(false);
    expect(track.getDebugSnapshot().fwdVisible).toBeGreaterThanOrEqual(1_000);

    createTextOnPublish.mockRestore();
    track.destroy();
    parent.destroy();
    vi.unstubAllGlobals();
  });

  it('makes bounded content progress when Chromium starves ordinary idle time', async () => {
    let idleCallback:
      | ((deadline: { timeRemaining: () => number; didTimeout: boolean }) => void)
      | null = null;
    const requestIdleCallback = vi.fn(
      (
        callback: (deadline: { timeRemaining: () => number; didTimeout: boolean }) => void,
        _options?: { timeout: number }
      ) => {
        idleCallback = callback;
        return 1;
      }
    );
    vi.stubGlobal('requestIdleCallback', requestIdleCallback);
    vi.stubGlobal('cancelIdleCallback', vi.fn());
    const parent = new Container();
    const track = new SequenceTrack(parent, async () => undefined);
    const window = { startBp: 0, bases: 'acgt'.repeat(1_200) };
    const visible = linearModel({
      viewportWidth: 800,
      viewStartBp: 1_000,
      viewEndBp: 2_000,
      pixelsPerBp: 0.8,
      bpPerPixel: 1.25,
      sequenceVisible: true,
      sequenceOpacity: 1,
    });
    track.renderLinear(undefined, visible, 800, window);
    expect(requestIdleCallback).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 50 });
    expect(idleCallback).not.toBeNull();

    const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(0);
    idleCallback!({ didTimeout: true, timeRemaining: () => 0 });
    await Promise.resolve();
    expect(track.getDebugSnapshot().linearContentPreparedPairCount).toBeGreaterThan(0);

    performanceNow.mockRestore();
    track.destroy();
    parent.destroy();
    vi.unstubAllGlobals();
  });

  it('preallocates Text objects without claiming a managed texture for placeholder letters', async () => {
    const idleCallbacks = new Map<number, (deadline: { timeRemaining: () => number }) => void>();
    let nextIdleHandle = 1;
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: (deadline: { timeRemaining: () => number }) => void) => {
        const handle = nextIdleHandle++;
        idleCallbacks.set(handle, callback);
        return handle;
      })
    );
    const preparedBatches: Text[][] = [];
    const parent = new Container();
    const track = new SequenceTrack(parent, async (glyphs) => {
      preparedBatches.push([...glyphs]);
    });

    await Promise.resolve();
    const initial = track.getDebugSnapshot();
    expect(initial.fwdRecycle).toBe(8);
    expect(initial.revRecycle).toBe(8);
    expect(initial.linearGpuPrewarmSubmittedGlyphCount).toBe(0);
    expect(initial.linearGpuPrewarmCompletedGlyphCount).toBe(0);
    expect(preparedBatches).toEqual([]);

    const firstIdle = idleCallbacks.entries().next().value;
    expect(firstIdle).toBeDefined();
    const [handle, callback] = firstIdle as [
      number,
      (deadline: { timeRemaining: () => number }) => void,
    ];
    idleCallbacks.delete(handle);

    const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(0);
    callback({ timeRemaining: () => 50 });
    await Promise.resolve();

    const afterIdle = track.getDebugSnapshot();
    expect(afterIdle.fwdRecycle).toBeGreaterThan(initial.fwdRecycle);
    expect(afterIdle.revRecycle).toBeGreaterThan(initial.revRecycle);
    expect(afterIdle.linearGpuPrewarmSubmittedGlyphCount).toBe(0);
    expect(afterIdle.linearGpuPrewarmCompletedGlyphCount).toBe(0);
    expect(afterIdle.linearGpuPrewarmFailedGlyphCount).toBe(0);
    expect(preparedBatches).toEqual([]);

    performanceNow.mockRestore();
    track.destroy();
    parent.destroy();
    vi.unstubAllGlobals();
  });

  it('does not invoke optional GPU preparation for placeholder reserve objects', () => {
    const parent = new Container();
    const prepare = vi.fn(() => {
      throw new Error('prepare extension unavailable');
    });
    const track = new SequenceTrack(parent, prepare);

    const snapshot = track.getDebugSnapshot();
    expect(snapshot.fwdRecycle).toBe(8);
    expect(snapshot.revRecycle).toBe(8);
    expect(snapshot.linearGpuPrewarmSubmittedGlyphCount).toBe(0);
    expect(snapshot.linearGpuPrewarmCompletedGlyphCount).toBe(0);
    expect(snapshot.linearGpuPrewarmFailedGlyphCount).toBe(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(parent.children).toContain(track.container);

    track.destroy();
    parent.destroy();
  });

  it('reuses the prewarmed glyph raster across light and dark themes', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    const sequenceWindow = { startBp: 0, bases: 'atgc'.repeat(1_200) };
    const hiddenModel = linearModel({
      viewStartBp: 0,
      viewEndBp: 40_000,
      pixelsPerBp: 0.03,
      bpPerPixel: 33.33,
      sequenceVisible: false,
      sequenceOpacity: 0,
    });

    track.renderLinear(undefined, hiddenModel, 800, sequenceWindow);
    const reservedGlyph = (track as unknown as { fwdRecycle: Text[] }).fwdRecycle.at(-1)!;
    const neutralStyle = reservedGlyph.style;

    const dark = webglThemeForMode('dark');
    track.setTheme(dark);
    track.renderLinear(
      undefined,
      linearModel({ viewStartBp: 0, viewEndBp: 8, pixelsPerBp: 8, bpPerPixel: 0.125 }),
      800,
      sequenceWindow
    );

    const visibleGlyph = track.fwdMap.values().next().value!;
    expect(visibleGlyph.style).toBe(neutralStyle);
    expect(visibleGlyph.tint).toBe(dark.text);
    expect(visibleGlyph.style.fill).toBe(LINEAR_SEQUENCE_GLYPH_NEUTRAL_FILL);

    track.destroy();
    parent.destroy();
  });
});

describe('SequenceTrack linear background  ② — highlight occlusion)', () => {
  it('paints NO opaque background behind the glyphs in linear mode', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);

    const result = track.renderLinear('atgc'.repeat(10), linearModel(), 600);

    expect(track.getDebugSnapshot().fwdVisible).toBeGreaterThan(0);
    expect(result.totalHeight).toBeGreaterThan(0);

    expect(track.getBackgroundDrawOpCount()).toBe(0);

    track.destroy();
    parent.destroy();
  });

  it('getBackgroundDrawOpCount reflects real Pixi draw instructions (gate is not vacuous)', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);
    expect(track.getBackgroundDrawOpCount()).toBe(0);

    const bg = (track as unknown as { bg: Graphics }).bg;
    bg.rect(0, 0, 10, 10).fill({ color: 0xffffff, alpha: 1 });
    expect(track.getBackgroundDrawOpCount()).toBeGreaterThan(0);

    track.destroy();
    parent.destroy();
  });

  it('clears any prior-frame background when the sequence hides', () => {
    const parent = new Container();
    const track = new SequenceTrack(parent);

    track.renderLinear('atgc'.repeat(10), linearModel(), 600);
    track.renderLinear('atgc'.repeat(10), { ...linearModel(), sequenceVisible: false }, 600);

    expect(track.getBackgroundDrawOpCount()).toBe(0);

    track.destroy();
    parent.destroy();
  });
});
