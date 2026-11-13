// @vitest-environment jsdom
import { Graphics, type Container } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  });
});

import {
  BUILTIN_ANNOTATION_VISUALIZATIONS,
  type AnnotationEvidenceClass,
  type CatalogRecord,
  type FeatureKind,
} from '@waypoint/genome-data/annotation-catalog';

import { webglThemeForMode } from '../../shared/theme';
import type { PixiLinearTrackRenderer, TrackMeasureContentArgs, TrackPaintArgs } from '../types';
import { paintCatalogBatches } from './catalog-graphics-painter';
import { CATALOG_COMPUTED_ALPHA, createCatalogGlyphBatches } from './catalog-glyph-batches';
import { EMPTY_CATALOG_TRACK_HEIGHT_PX } from './catalog-rows';
import {
  catalogTrackData,
  promoterRecord,
  terminatorRecord,
  tssRecord,
  unitRecord,
} from './catalog-test-fixtures';
import { CATALOG_VISUALIZATION_SPECS } from './catalog-visualizations';
import {
  annotationCatalogTrackType,
  createAnnotationCatalogTrackRenderers,
  type AnnotationCatalogRendererDiagnostics,
  type AnnotationCatalogTrackData,
} from './index';

const GENOME_LENGTH_BP = 4_641_652;
const CHROMOSOME = {
  id: 'NC_000913.3',
  displayName: 'NC_000913.3',
  length: GENOME_LENGTH_BP,
  cytobands: [],
};

type CatalogRenderer = PixiLinearTrackRenderer<AnnotationCatalogTrackData>;

function rendererFor(id: string): CatalogRenderer {
  const type = annotationCatalogTrackType(
    BUILTIN_ANNOTATION_VISUALIZATIONS.find((d) => d.id === id)!.id
  );
  return createAnnotationCatalogTrackRenderers().find((r) => r.type === type)!;
}

function mount(renderer: CatalogRenderer): Container {
  return renderer.mount({ chromosome: CHROMOSOME, theme: webglThemeForMode('light') });
}

function paintArgs(
  container: Container,
  data: AnnotationCatalogTrackData | null,
  camera: { viewStartBp: number; pixelsPerBp: number; widthPx?: number },
  overrides: Partial<TrackPaintArgs<AnnotationCatalogTrackData>> = {}
): TrackPaintArgs<AnnotationCatalogTrackData> {
  const widthPx = camera.widthPx ?? 1000;
  return {
    container,
    data,
    presentation: {},
    chromosome: CHROMOSOME,
    pathMapper: {
      pixelsPerBp: camera.pixelsPerBp,
      bpLeftX: (bp: number) => (bp - camera.viewStartBp) * camera.pixelsPerBp,
    },
    viewportBpRange: {
      start: camera.viewStartBp,
      end: camera.viewStartBp + widthPx / camera.pixelsPerBp,
    },
    viewportWidthPx: widthPx,
    viewportHeightPx: 600,
    layoutEntry: { id: 'catalog', top: 0, height: 40, contentClipped: false, hidden: false },
    containerTopPx: 120,
    theme: webglThemeForMode('light'),
    ...overrides,
  } as unknown as TrackPaintArgs<AnnotationCatalogTrackData>;
}

function diagnostics(renderer: CatalogRenderer, container: Container) {
  return renderer.getDiagnostics!(container) as AnnotationCatalogRendererDiagnostics;
}

function graphicsOf(container: Container): Graphics {
  const graphics = container.children[0];
  if (!(graphics instanceof Graphics)) throw new Error('expected a Graphics child');
  return graphics;
}

function startSites(count = 10_000, evidence: 'measured' | 'computed' = 'measured') {
  const spacing = Math.floor(GENOME_LENGTH_BP / count);
  return catalogTrackData({
    kind: 'tss',
    evidence,
    genomeLengthBp: GENOME_LENGTH_BP,
    records: Array.from({ length: count }, (_, i) =>
      tssRecord(i * spacing, i % 2 === 0 ? '+' : '-')
    ),
  });
}

describe('catalog renderer registry (L0)', () => {
  it('has exactly one renderer per visualization descriptor and none without one', () => {
    const renderers = createAnnotationCatalogTrackRenderers();
    const rendererTypes = renderers.map((r) => r.type).sort();
    const descriptorTypes = BUILTIN_ANNOTATION_VISUALIZATIONS.map((d) =>
      annotationCatalogTrackType(d.id)
    ).sort();

    expect(rendererTypes).toEqual(descriptorTypes);
    expect(new Set(rendererTypes).size).toBe(rendererTypes.length);
    expect(CATALOG_VISUALIZATION_SPECS.map((s) => s.id).sort()).toEqual(
      BUILTIN_ANNOTATION_VISUALIZATIONS.map((d) => d.id).sort()
    );
  });

  it('can draw every kind each descriptor accepts', () => {
    const recordFor: Record<FeatureKind, CatalogRecord> = {
      promoter: promoterRecord({ start: 1000, end: 1061, transcriptionStartBp: 1060 }),
      terminator: terminatorRecord({ start: 1000, end: 1040 }),
      tss: tssRecord(1000),
      transcription_unit: unitRecord({ start: 1000, end: 1400 }),
    };
    for (const descriptor of BUILTIN_ANNOTATION_VISUALIZATIONS) {
      const renderer = rendererFor(descriptor.id);
      for (const kind of descriptor.accepts) {
        const container = mount(renderer);
        const data = catalogTrackData({ kind, records: [recordFor[kind]], genomeLengthBp: 2000 });
        renderer.paint(paintArgs(container, data, { viewStartBp: 900, pixelsPerBp: 1 }));
        expect(diagnostics(renderer, container)).toMatchObject({ lod: 'detail', paintedGlyphs: 1 });
        renderer.unmount(container);
      }
    }
  });
});

describe('measureContentHeight', () => {
  const measure = (
    renderer: CatalogRenderer,
    data: AnnotationCatalogTrackData | null,
    presentation: TrackMeasureContentArgs['presentation'] = {}
  ) =>
    renderer.measureContentHeight!({
      data,
      presentation,
      chromosome: null,
    } as unknown as TrackMeasureContentArgs<AnnotationCatalogTrackData>);

  it('returns a readable minimum with no data or no records', () => {
    const renderer = rendererFor('promoter-arrow');
    expect(measure(renderer, null)).toBe(EMPTY_CATALOG_TRACK_HEIGHT_PX);
    expect(measure(renderer, catalogTrackData({ kind: 'tss', records: [] }))).toBe(
      EMPTY_CATALOG_TRACK_HEIGHT_PX
    );
  });

  it('sizes strand rows from the data and honors presentation row height', () => {
    const renderer = rendererFor('promoter-arrow');
    const data = catalogTrackData({ kind: 'tss', records: [tssRecord(1, '+'), tssRecord(5, '-')] });
    expect(measure(renderer, data)).toBe(2 * 16 + 4);
    expect(measure(renderer, data, { rowHeightPx: 24 })).toBe(2 * 24 + 4);
  });

  it('sizes stacked rows from overlaps and caps them with presentation max rows', () => {
    const renderer = rendererFor('transcription-unit-arrows');
    const data = catalogTrackData({
      kind: 'transcription_unit',
      records: [
        unitRecord({ start: 0, end: 100 }),
        unitRecord({ start: 10, end: 100 }),
        unitRecord({ start: 20, end: 100 }),
        unitRecord({ start: 0, end: 100, strand: '-' }),
      ],
    });
    expect(measure(renderer, data)).toBe(4 * 12 + 4);
    expect(measure(renderer, data, { maxRows: 2 })).toBe(3 * 12 + 4);
  });
});

describe('PixiAnnotationCatalogTrackRenderer paint', () => {
  it('draws strand-split density bars zoomed out and glyphs zoomed in', () => {
    const renderer = rendererFor('promoter-arrow');
    const container = mount(renderer);
    const data = startSites();

    renderer.paint(
      paintArgs(container, data, { viewStartBp: 0, pixelsPerBp: 1000 / GENOME_LENGTH_BP })
    );
    const zoomedOut = diagnostics(renderer, container);
    expect(zoomedOut).toMatchObject({
      visualizationId: 'promoter-arrow',
      kind: 'tss',
      recordCount: 10_000,
      lod: 'aggregate',
      paintedGlyphs: 0,
      lanes: 2,
    });
    expect(zoomedOut.aggregateBins).toBeGreaterThan(300);

    renderer.paint(paintArgs(container, data, { viewStartBp: 2_000_000, pixelsPerBp: 0.05 }));
    const zoomedIn = diagnostics(renderer, container);
    expect(zoomedIn.lod).toBe('detail');
    expect(zoomedIn.aggregateBins).toBe(0);
    expect(zoomedIn.paintedGlyphs).toBeGreaterThan(40);
    expect(zoomedIn.decluttered).toBe(0);
    expect(zoomedIn.camera).toEqual({ viewStartBp: 2_000_000, pixelsPerBp: 0.05, widthPx: 1000 });
    expect(graphicsOf(container).eventMode).toBe('none');
    expect(container.eventMode).toBe('none');
  });

  it('declutters glyphs closer than 4 px', () => {
    const renderer = rendererFor('position-ticks');
    const container = mount(renderer);
    const data = startSites();
    const spacing = Math.floor(GENOME_LENGTH_BP / 10_000);
    renderer.paint(
      paintArgs(container, data, { viewStartBp: 1_000_000, pixelsPerBp: 1.5 / spacing })
    );
    const result = diagnostics(renderer, container);
    expect(result.lod).toBe('detail');
    expect(result.decluttered).toBeGreaterThan(0);
    expect(result.paintedGlyphs).toBeGreaterThan(0);
  });

  it('does not rebuild while nothing changes, and rebuilds on camera, data, theme and presentation changes', () => {
    const renderer = rendererFor('position-ticks');
    const container = mount(renderer);
    const data = startSites(2000);
    const camera = { viewStartBp: 100_000, pixelsPerBp: 0.02 };
    const base = paintArgs(container, data, camera);
    const clearSpy = vi.spyOn(graphicsOf(container), 'clear');

    renderer.paint(base);
    renderer.paint({ ...base });
    renderer.paint({ ...base, pathMapper: { ...base.pathMapper } });
    expect(diagnostics(renderer, container).rebuilds).toBe(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);

    renderer.paint(paintArgs(container, data, { ...camera, viewStartBp: 100_500 }));
    expect(diagnostics(renderer, container).rebuilds).toBe(2);
    renderer.paint(paintArgs(container, startSites(2000), { ...camera, viewStartBp: 100_500 }));
    expect(diagnostics(renderer, container).rebuilds).toBe(3);
    const current = paintArgs(container, data, { ...camera, viewStartBp: 100_500 });
    renderer.paint(current);
    expect(diagnostics(renderer, container).rebuilds).toBe(4);
    renderer.paint({ ...current, theme: webglThemeForMode('dark') });
    expect(diagnostics(renderer, container).rebuilds).toBe(5);
    renderer.paint({
      ...current,
      theme: webglThemeForMode('dark'),
      presentation: { color: '#123456' },
    });
    expect(diagnostics(renderer, container).rebuilds).toBe(6);
    renderer.paint({
      ...current,
      theme: webglThemeForMode('dark'),
      presentation: { color: '#123456' },
      layoutEntry: { ...current.layoutEntry, height: 80 },
    });
    expect(diagnostics(renderer, container).rebuilds).toBe(7);
  });

  it('fills measured glyphs and only strokes computed ones', () => {
    const renderer = rendererFor('promoter-arrow');
    const camera = { viewStartBp: 2_000_000, pixelsPerBp: 0.05 };

    const measured = mount(renderer);
    const measuredFill = vi.spyOn(graphicsOf(measured), 'fill');
    renderer.paint(paintArgs(measured, startSites(10_000, 'measured'), camera));
    expect(measuredFill).toHaveBeenCalledWith({ color: 0x14b8a6, alpha: 1 });

    const computed = mount(renderer);
    const computedFill = vi.spyOn(graphicsOf(computed), 'fill');
    const computedStroke = vi.spyOn(graphicsOf(computed), 'stroke');
    renderer.paint(paintArgs(computed, startSites(10_000, 'computed'), camera));
    expect(diagnostics(renderer, computed).paintedGlyphs).toBeGreaterThan(0);
    expect(computedFill).not.toHaveBeenCalled();
    expect(computedStroke).toHaveBeenCalledWith({
      color: 0x14b8a6,
      alpha: CATALOG_COMPUTED_ALPHA,
      width: 1,
    });
  });

  describe('draws computed records fainter or hollow in every visualization', () => {
    const genes = [
      { name: 'geneA', start: 1100, end: 1200, strand: '+' as const },
      { name: 'geneB', start: 1210, end: 1350, strand: '+' as const },
    ];
    const samples: Record<FeatureKind, CatalogRecord[]> = {
      promoter: [
        promoterRecord({
          start: 1000,
          end: 1061,
          transcriptionStartBp: 1060,
          boxes: [{ element: 'minus10', start: 1040, end: 1046 }],
        }),
      ],
      terminator: [
        terminatorRecord({ start: 1000, end: 1040, terminationBp: 1030 }),
        terminatorRecord({ start: 1000, end: 1120, mechanism: 'rho-dependent' }),
        terminatorRecord({ start: 1000, end: 1040, mechanism: 'unclassified' }),
      ],
      tss: [tssRecord(1000)],
      transcription_unit: [
        unitRecord({ start: 1000, end: 1400, genes: ['geneA', 'geneB'] }),
        unitRecord({ start: 1000, end: 1400, strand: '-' }),
      ],
    };
    const cases = BUILTIN_ANNOTATION_VISUALIZATIONS.flatMap((descriptor) =>
      descriptor.accepts.flatMap((kind) =>
        samples[kind].map((record) => [descriptor.id, kind, record] as const)
      )
    );

    type PaintCall = { method: 'fill' | 'stroke'; alpha: number };
    const paintCalls = (
      id: string,
      kind: FeatureKind,
      record: CatalogRecord,
      evidence: AnnotationEvidenceClass
    ): PaintCall[] => {
      const renderer = rendererFor(id);
      const container = mount(renderer);
      const graphics = graphicsOf(container);
      const calls: PaintCall[] = [];
      vi.spyOn(graphics, 'fill').mockImplementation(function (this: Graphics, style) {
        calls.push({ method: 'fill', alpha: (style as { alpha: number }).alpha });
        return this;
      });
      vi.spyOn(graphics, 'stroke').mockImplementation(function (this: Graphics, style) {
        calls.push({ method: 'stroke', alpha: (style as { alpha: number }).alpha });
        return this;
      });
      const data = catalogTrackData({
        kind,
        evidence,
        records: [record],
        genomeLengthBp: 2000,
        genes,
      });
      renderer.paint(paintArgs(container, data, { viewStartBp: 900, pixelsPerBp: 1 }));
      expect(diagnostics(renderer, container)).toMatchObject({ lod: 'detail', paintedGlyphs: 1 });
      renderer.unmount(container);
      return calls;
    };

    it.each(cases)('%s drawing a %s', (id, kind, record) => {
      const measured = paintCalls(id, kind, record, 'measured');
      const computed = paintCalls(id, kind, record, 'computed');

      expect(measured.length).toBeGreaterThan(0);
      expect(computed).toHaveLength(measured.length);
      computed.forEach((call, i) => {
        const twin = measured[i];
        expect(call.alpha).toBeLessThanOrEqual(CATALOG_COMPUTED_ALPHA);
        const hollow = twin.method === 'fill' && call.method === 'stroke';
        expect(hollow || call.alpha < twin.alpha).toBe(true);
      });
      expect(computed.some((call) => call.method === 'fill')).toBe(false);
    });
  });

  it('draws computed density bars at reduced alpha', () => {
    const renderer = rendererFor('position-ticks');
    const camera = { viewStartBp: 0, pixelsPerBp: 1000 / GENOME_LENGTH_BP };
    const alphaFor = (evidence: 'measured' | 'computed') => {
      const container = mount(renderer);
      const fill = vi.spyOn(graphicsOf(container), 'fill');
      renderer.paint(paintArgs(container, startSites(10_000, evidence), camera));
      expect(diagnostics(renderer, container).lod).toBe('aggregate');
      return (fill.mock.lastCall![0] as { alpha: number }).alpha;
    };
    expect(alphaFor('computed')).toBeLessThanOrEqual(CATALOG_COMPUTED_ALPHA);
    expect(alphaFor('computed')).toBeLessThan(alphaFor('measured'));
  });

  it('dashes only the visible part of a computed unit far wider than the view', () => {
    const renderer = rendererFor('transcription-unit-arrows');
    const container = mount(renderer);
    const lineTo = vi.spyOn(graphicsOf(container), 'lineTo');
    const data = catalogTrackData({
      kind: 'transcription_unit',
      evidence: 'computed',
      genomeLengthBp: GENOME_LENGTH_BP,
      records: [unitRecord({ start: 1_000_000, end: 1_100_000 })],
    });
    renderer.paint(paintArgs(container, data, { viewStartBp: 1_050_000, pixelsPerBp: 10 }));
    expect(diagnostics(renderer, container).paintedGlyphs).toBe(1);
    expect(lineTo.mock.calls.length).toBeGreaterThan(100);
    expect(lineTo.mock.calls.length).toBeLessThan(300);
  });

  it('uses the presentation color and the theme passed to this paint', () => {
    const renderer = rendererFor('position-ticks');
    const container = mount(renderer);
    const stroke = vi.spyOn(graphicsOf(container), 'stroke');
    const data = startSites(2000);
    const args = paintArgs(container, data, { viewStartBp: 100_000, pixelsPerBp: 0.02 });

    renderer.paint({ ...args, presentation: { color: '#1d4ed8' } });
    expect(stroke).toHaveBeenLastCalledWith({ color: 0x1d4ed8, alpha: 1, width: 1 });

    renderer.paint({ ...args, theme: webglThemeForMode('dark') });
    const darkColor = (stroke.mock.lastCall![0] as { color: number }).color;
    expect(darkColor).not.toBe(0x14b8a6);
  });

  it('clears the track and reports empty when data goes away', () => {
    const renderer = rendererFor('interval-boxes');
    const container = mount(renderer);
    const data = startSites(2000);
    renderer.paint(paintArgs(container, data, { viewStartBp: 100_000, pixelsPerBp: 0.02 }));
    expect(graphicsOf(container).context.instructions.length).toBeGreaterThan(0);

    renderer.paint(paintArgs(container, null, { viewStartBp: 100_000, pixelsPerBp: 0.02 }));
    expect(diagnostics(renderer, container)).toMatchObject({
      lod: 'empty',
      kind: null,
      recordCount: 0,
      paintedGlyphs: 0,
    });
    expect(graphicsOf(container).context.instructions).toHaveLength(0);
  });

  it('reports overflow and row layout for stacked tracks', () => {
    const renderer = rendererFor('transcription-unit-arrows');
    const container = mount(renderer);
    const data = catalogTrackData({
      kind: 'transcription_unit',
      genomeLengthBp: 10_000,
      records: [
        unitRecord({ start: 0, end: 900 }),
        unitRecord({ start: 100, end: 900 }),
        unitRecord({ start: 200, end: 900 }),
      ],
    });
    const args = paintArgs(container, data, { viewStartBp: 0, pixelsPerBp: 1 });
    renderer.paint({ ...args, presentation: { maxRows: 2 } });
    expect(diagnostics(renderer, container)).toMatchObject({
      lod: 'detail',
      lanes: 2,
      overflowed: 1,
      paintedGlyphs: 2,
      rowLayout: { rowHeightPx: 12, forwardRows: 2, reverseRows: 0, baselineYPx: 26 },
    });
  });

  it('destroys its Graphics on unmount', () => {
    const renderer = rendererFor('terminator-hairpin');
    const container = mount(renderer);
    const graphics = graphicsOf(container);
    renderer.unmount(container);
    expect(graphics.destroyed).toBe(true);
    expect(container.destroyed).toBe(true);
    expect(renderer.getDiagnostics!(container)).toBeNull();
  });

  it('has no hitTest, so the linear renderer never makes a catalog track clickable', () => {
    for (const renderer of createAnnotationCatalogTrackRenderers()) {
      expect('hitTest' in renderer).toBe(false);
      const container = mount(renderer);
      expect(container.eventMode).toBe('none');
      expect(graphicsOf(container).eventMode).toBe('none');
      renderer.unmount(container);
    }
  });
});

describe('paintCatalogBatches', () => {
  it('issues one fill or stroke per non-empty batch and skips empty ones', () => {
    const graphics = new Graphics();
    const fill = vi.spyOn(graphics, 'fill');
    const stroke = vi.spyOn(graphics, 'stroke');
    const batches = createCatalogGlyphBatches({
      color: 0xef4444,
      evidence: 'measured',
      themeMode: 'light',
    });
    batches.line.segment(0, 0, 0, 10);
    batches.line.segment(5, 0, 5, 10);
    batches.body.triangle(0, 0, 4, 2, 0, 4);
    batches.body.circle(10, 10, 3);

    paintCatalogBatches(graphics, batches.ordered);

    expect(stroke).toHaveBeenCalledTimes(1);
    expect(stroke).toHaveBeenCalledWith({ color: 0xef4444, alpha: 1, width: 1.5 });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(fill).toHaveBeenCalledWith({ color: 0xef4444, alpha: 1 });
    expect(graphics.context.instructions.map((i) => i.action)).toEqual(['stroke', 'fill']);
    graphics.destroy();
  });
});
