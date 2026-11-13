import { describe, expect, it } from 'vitest';

import { annotationTypeAccentColor } from '../../../../feature-colors';
import { webglAnnotationColorForMode } from '../../shared/theme';
import {
  TRANSCRIPTION_UNIT_GENE_PALETTE,
  catalogKindColor,
  catalogTrackColor,
} from './catalog-colors';
import {
  CATALOG_COMPUTED_ALPHA,
  CATALOG_COMPUTED_LINE_DASH,
  LineBatch,
  clipCatalogDashes,
  createCatalogGlyphBatches,
  resetCatalogGlyphBatches,
} from './catalog-glyph-batches';

describe('evidence styling', () => {
  it('fills shapes for measured and curated records', () => {
    for (const evidence of ['measured', 'curated'] as const) {
      const batches = createCatalogGlyphBatches({ color: 0x22c55e, evidence, themeMode: 'light' });
      expect(batches.body.paint).toEqual({ mode: 'fill', color: 0x22c55e, alpha: 1 });
      expect(batches.band.paint.mode).toBe('fill');
      expect(batches.unitColors.every((batch) => batch.paint.mode === 'fill')).toBe(true);
      expect(batches.density.paint.alpha).toBeGreaterThan(CATALOG_COMPUTED_ALPHA);
    }
  });

  it('draws solid lines at full alpha for measured and curated records', () => {
    for (const evidence of ['measured', 'curated'] as const) {
      const batches = createCatalogGlyphBatches({ color: 0x22c55e, evidence, themeMode: 'light' });
      for (const line of [batches.line, batches.thinLine]) {
        expect(line.dash).toBeNull();
        expect(line.paint.alpha).toBe(1);
      }
    }
  });

  it('outlines shapes, dashes lines and halves alpha for computed records', () => {
    const measured = createCatalogGlyphBatches({
      color: 0x22c55e,
      evidence: 'measured',
      themeMode: 'light',
    });
    const computed = createCatalogGlyphBatches({
      color: 0x22c55e,
      evidence: 'computed',
      themeMode: 'light',
    });
    expect(computed.body.paint).toMatchObject({ mode: 'stroke', color: 0x22c55e });
    expect(computed.band.paint.mode).toBe('stroke');
    expect(computed.unitColors.every((batch) => batch.paint.mode === 'stroke')).toBe(true);
    expect(computed.density.paint.mode).toBe('fill');
    expect(computed.line.dash).toEqual(CATALOG_COMPUTED_LINE_DASH);
    expect(computed.thinLine.dash).toEqual(CATALOG_COMPUTED_LINE_DASH);

    expect(computed.ordered).toHaveLength(measured.ordered.length);
    computed.ordered.forEach((batch, i) => {
      const twin = measured.ordered[i].paint;
      expect(batch.paint.alpha).toBeLessThanOrEqual(CATALOG_COMPUTED_ALPHA);
      const hollow = twin.mode === 'fill' && batch.paint.mode === 'stroke';
      expect(hollow || batch.paint.alpha < twin.alpha).toBe(true);
    });
  });

  it('paints lines as strokes in every evidence class', () => {
    for (const evidence of ['measured', 'curated', 'computed'] as const) {
      const batches = createCatalogGlyphBatches({ color: 1, evidence, themeMode: 'dark' });
      expect(batches.line).toBeInstanceOf(LineBatch);
      expect(batches.line.paint.mode).toBe('stroke');
    }
  });
});

describe('LineBatch dashes', () => {
  const dash = { dashPx: 3, gapPx: 2 };

  it('splits a line into dashes that start at its first point', () => {
    const batch = new LineBatch({ mode: 'stroke', color: 1, alpha: 1, widthPx: 1 }, dash);
    batch.segment(10, 0, 26, 0);
    expect(batch.segments).toEqual([10, 0, 13, 0, 15, 0, 18, 0, 20, 0, 23, 0, 25, 0, 26, 0]);

    const up = new LineBatch({ mode: 'stroke', color: 1, alpha: 1, widthPx: 1 }, dash);
    up.segment(5, 20, 5, 12);
    expect(up.segments).toEqual([5, 20, 5, 17, 5, 15, 5, 12]);
  });

  it('emits only dashes inside the clip, keeping the pattern anchored to the line', () => {
    const batch = new LineBatch({ mode: 'stroke', color: 1, alpha: 1, widthPx: 1 }, dash);
    batch.setDashClip(0, 10);
    batch.segment(-1024, 4, 1024, 4);
    expect(batch.segments).toEqual([1, 4, 4, 4, 6, 4, 9, 4]);
    expect(batch.shapeCount).toBe(2);

    batch.reset();
    batch.segment(20, 0, 20, 10);
    expect(batch.segments).toHaveLength(0);
  });

  it('leaves solid lines whole and unclipped', () => {
    const batch = new LineBatch({ mode: 'stroke', color: 1, alpha: 1, widthPx: 1 });
    batch.setDashClip(0, 10);
    batch.segment(-50, 0, 50, 0);
    expect(batch.segments).toEqual([-50, 0, 50, 0]);
  });

  it('clips both line batches of a track', () => {
    const batches = createCatalogGlyphBatches({
      color: 1,
      evidence: 'computed',
      themeMode: 'light',
    });
    clipCatalogDashes(batches, 0, 4);
    batches.line.segment(-128, 0, 128, 0);
    batches.thinLine.segment(-128, 0, 128, 0);
    expect(batches.line.segments).toEqual([2, 0, 4, 0]);
    expect(batches.thinLine.segments).toEqual([2, 0, 4, 0]);
  });
});

describe('catalog glyph batches', () => {
  it('orders batches bottom to top: band, lines, solid shapes, gene colors, density', () => {
    const batches = createCatalogGlyphBatches({
      color: 1,
      evidence: 'measured',
      themeMode: 'light',
    });
    expect(batches.ordered).toEqual([
      batches.band,
      batches.line,
      batches.thinLine,
      batches.body,
      ...batches.unitColors,
      batches.density,
    ]);
  });

  it('colors genes from the theme palette, ignoring the track color', () => {
    const dark = createCatalogGlyphBatches({
      color: 0xff0000,
      evidence: 'measured',
      themeMode: 'dark',
    });
    expect(dark.unitColors.map((batch) => batch.paint.color)).toEqual(
      TRANSCRIPTION_UNIT_GENE_PALETTE.dark
    );
  });

  it('clears every primitive on reset but keeps the arrays', () => {
    const batches = createCatalogGlyphBatches({
      color: 1,
      evidence: 'measured',
      themeMode: 'light',
    });
    batches.body.rect(0, 0, 1, 1);
    batches.body.triangle(0, 0, 1, 1, 2, 2);
    batches.body.circle(0, 0, 1);
    batches.line.segment(0, 0, 1, 1);
    const rects = batches.body.rects;
    expect(batches.body.shapeCount).toBe(3);
    expect(batches.line.shapeCount).toBe(1);

    resetCatalogGlyphBatches(batches);

    expect(batches.body.shapeCount).toBe(0);
    expect(batches.line.shapeCount).toBe(0);
    expect(batches.body.rects).toBe(rects);
  });
});

describe('catalog colors', () => {
  it('uses the shared palette for promoters and terminators', () => {
    expect(catalogKindColor('promoter', 'light')).toBe(0x22c55e);
    expect(catalogKindColor('terminator', 'light')).toBe(0xef4444);
    expect(catalogKindColor('promoter', 'dark')).toBe(
      annotationTypeAccentColor('promoter', 'dark')
    );
  });

  it('gives every kind a distinct color in both themes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const colors = (['promoter', 'terminator', 'tss', 'transcription_unit'] as const).map(
        (kind) => catalogKindColor(kind, mode)
      );
      expect(new Set(colors).size).toBe(4);
    }
  });

  it('lets a valid presentation color override the kind color, themed like other tracks', () => {
    expect(catalogTrackColor('promoter', '#1D4ED8', 'light')).toBe(0x1d4ed8);
    expect(catalogTrackColor('promoter', '#1d4ed8', 'dark')).toBe(
      webglAnnotationColorForMode(0x1d4ed8, 'dark')
    );
    expect(catalogTrackColor('promoter', 'blue', 'light')).toBe(0x22c55e);
    expect(catalogTrackColor('promoter', undefined, 'light')).toBe(0x22c55e);
  });

  it('keeps gene palettes free of duplicates', () => {
    for (const palette of Object.values(TRANSCRIPTION_UNIT_GENE_PALETTE)) {
      expect(new Set(palette).size).toBe(palette.length);
    }
  });
});
