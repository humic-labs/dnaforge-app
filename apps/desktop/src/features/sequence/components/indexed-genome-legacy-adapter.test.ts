import { beforeAll, describe, expect, it } from 'vitest';

import type { Feature } from '@waypoint/genome-renderer';
import type { GenomeFeature } from '@waypoint/genome-data';

type IndexedGenomeLegacyAdapter = typeof import('./indexed-genome-legacy-adapter');

let adapter: IndexedGenomeLegacyAdapter;

beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => undefined,
    globalCompositeOperation: 'source-over',
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  adapter = await import('./indexed-genome-legacy-adapter');
});

function feature(overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'start' | 'end'>) {
  return {
    chrom: overrides.chrom ?? 'chr11',
    source: overrides.source ?? 'test',
    type: overrides.type ?? 'mRNA',
    start: overrides.start,
    end: overrides.end,
    score: overrides.score ?? null,
    strand: overrides.strand ?? '+',
    phase: overrides.phase ?? null,
    attributes: overrides.attributes ?? { ID: [`tx-${overrides.start}`] },
    raw: overrides.raw ?? '',
  } satisfies GenomeFeature;
}

function rendererFeature(index: number): Feature {
  const start = 1_000 + index * 1_000;
  return {
    id: index,
    type: 'mRNA',
    start,
    end: start + 600,
    direction: index % 2 === 0 ? 'forward' : 'reverse',
    displayName: `TX${index}`,
    color: 0x3b82f6,
    lane: index % 3,
    exons: [
      { start, end: start + 100 },
      { start: start + 500, end: start + 600 },
    ],
    cds: [{ start: start + 40, end: start + 560 }],
    transcriptId: `NM_${index}`,
    qualifiers: {
      ID: `tx-${index}`,
      translation: 'M'.repeat(40),
    },
  };
}

describe('indexed genome legacy adapter', () => {
  it('preserves computed lanes when converting density-filtered features', () => {
    const result = adapter.applyDensityControls(
      [
        feature({ start: 100, end: 500, attributes: { ID: ['tx-a'] } }),
        feature({ start: 200, end: 600, attributes: { ID: ['tx-b'] } }),
      ],
      'chr11',
      1_000,
      new Set(['mRNA']),
      null
    );

    expect(result.features.map((entry) => entry.lane).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('expands an RNA parent bbox to the exact union of its resolved child parts', () => {
    const carrier = {
      ...feature({ start: 100, end: 500, type: 'telomerase_RNA' }),
      _resolvedExons: [{ start: 100, end: 500 }],
      _resolvedCds: [],
      _resolvedTranscriptId: 'TERC',
    };
    const result = adapter.applyDensityControls(
      [carrier],
      'chr11',
      1_000,
      new Set(['telomerase_RNA']),
      null
    );

    expect(result.features[0]).toMatchObject({
      start: 99,
      end: 500,
      exons: [{ start: 100, end: 500 }],
    });
  });

  it('preserves compound CDS semantics through the renderer adapter', () => {
    const carrier = {
      ...feature({ start: 100, end: 500, type: 'CDS' }),
      compositeKind: 'compound-cds' as const,
      _resolvedExons: [
        { start: 101, end: 200 },
        { start: 301, end: 500 },
      ],
      _resolvedCds: [
        { start: 101, end: 200 },
        { start: 301, end: 500 },
      ],
      _resolvedTranscriptId: 'protein-1',
    };
    const result = adapter.applyDensityControls([carrier], 'chr11', 1_000, new Set(['CDS']), null);

    expect(result.features[0]).toMatchObject({
      type: 'CDS',
      compositeKind: 'compound-cds',
      exons: carrier._resolvedExons,
      cds: carrier._resolvedCds,
    });
  });

  it('keeps finite flat-mode annotations in the legacy shared lane pool', () => {
    const gene = feature({
      type: 'gene',
      start: 100,
      end: 500,
      attributes: { ID: ['gene-a'] },
    });
    const transcript = feature({ start: 100, end: 500, attributes: { ID: ['tx-a'] } });
    const visible = new Set(['gene', 'mRNA']);
    const density = adapter.applyDensityControls([gene, transcript], 'chr11', 1_000, visible, 12);
    const payload = adapter.buildAnnotationGlyphPayload(
      [gene, transcript],
      'chr11',
      1_000,
      visible,
      12
    );
    const stablePayload = adapter.buildAnnotationGlyphPayloadWithStableLanes(
      [gene, transcript],
      'chr11',
      1_000,
      visible,
      12,
      density
    );

    expect(density.features.map((entry) => entry.lane).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(density.features.every((entry) => entry.annotationTrackLaneCapacity === undefined)).toBe(
      true
    );
    for (const glyphs of [payload.glyphs, stablePayload.glyphs]) {
      expect(glyphs.map((entry) => entry.lane).sort((a, b) => a - b)).toEqual([0, 1]);
      expect(glyphs.every((entry) => entry.trackLaneCapacity === undefined)).toBe(true);
    }
  });

  it('keeps exact viewport glyph lanes stable against the overview lane assignment', () => {
    const txA = feature({ start: 100, end: 500, attributes: { ID: ['tx-a'] } });
    const txB = feature({ start: 200, end: 600, attributes: { ID: ['tx-b'] } });
    const overview = adapter.applyDensityControls(
      [txA, txB],
      'chr11',
      1_000,
      new Set(['mRNA']),
      null
    );
    const localOnly = adapter.buildAnnotationGlyphPayload(
      [txB],
      'chr11',
      1_000,
      new Set(['mRNA']),
      null
    );
    const stable = adapter.buildAnnotationGlyphPayloadWithStableLanes(
      [txB],
      'chr11',
      1_000,
      new Set(['mRNA']),
      null,
      overview
    );

    expect(overview.features.find((entry) => entry.displayName === 'tx-b')?.lane).toBe(1);
    expect(localOnly.glyphs[0]?.lane).toBe(0);
    expect(stable.glyphs[0]?.lane).toBe(1);
  });

  it('does not mistake a valid global lane in a later fixed track for per-track overflow', () => {
    const gene = feature({
      type: 'gene',
      start: 100,
      end: 500,
      attributes: { ID: ['gene-a'] },
    });
    const transcript = feature({
      start: 100,
      end: 500,
      attributes: { ID: ['tx-a'] },
    });
    const visible = new Set(['gene', 'mRNA']);
    const stacking = { groupByType: true, typeOrder: ['gene', 'mRNA'] } as const;
    const overview = adapter.applyDensityControls(
      [gene, transcript],
      'chr11',
      1_000,
      visible,
      12,
      stacking
    );

    const stable = adapter.buildAnnotationGlyphPayloadWithStableLanes(
      [transcript],
      'chr11',
      1_000,
      visible,
      12,
      overview,
      stacking
    );

    expect(overview.features.find((entry) => entry.type === 'mRNA')?.lane).toBe(13);
    expect(stable.glyphs).toHaveLength(1);
    expect(stable.glyphs[0]?.lane).toBe(13);
    expect(stable.glyphs[0]?.trackLane).toBe(0);
  });

  it('reuses stable global and local lane ownership as one indivisible assignment', () => {
    const gene = feature({
      type: 'gene',
      start: 50,
      end: 550,
      attributes: { ID: ['gene-a'] },
    });
    const blocker = feature({ start: 90, end: 510, attributes: { ID: ['tx-blocker'] } });
    const target = feature({ start: 100, end: 500, attributes: { ID: ['tx-target'] } });
    const visible = new Set(['gene', 'mRNA']);
    const stacking = { groupByType: true, typeOrder: ['gene', 'mRNA'] } as const;
    const overview = adapter.applyDensityControls(
      [gene, blocker, target],
      'chr11',
      1_000,
      visible,
      12,
      stacking
    );

    const stable = adapter.buildAnnotationGlyphPayloadWithStableLanes(
      [target],
      'chr11',
      1_000,
      visible,
      12,
      overview,
      stacking
    );

    expect(overview.features.find((entry) => entry.displayName === 'tx-target')).toMatchObject({
      lane: 14,
      annotationTrackLane: 1,
      annotationTrackLaneCapacity: 12,
    });
    expect(stable.glyphs).toEqual([
      expect.objectContaining({
        label: 'tx-target',
        lane: 14,
        trackId: 'mRNA',
        trackLane: 1,
        trackLaneCapacity: 12,
      }),
    ]);
  });

  it('limits rich broad overview glyphs while preserving every individual annotation', () => {
    const richFeatures = Array.from({ length: 120 }, (_, index) => rendererFeature(index));
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      {
        features: richFeatures,
        droppedCount: 0,
        typeFilteredCount: richFeatures.length,
      },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 135_086_622 },
        widthPx: 960,
        maxGlyphs: 24,
      }
    );

    expect(payload.glyphs.length).toBeLessThanOrEqual(24);
    expect(payload.glyphs.length + (payload.compactGlyphs?.length ?? 0)).toBe(120);
    expect(payload.typeFilteredCount).toBe(120);
    expect(payload.glyphs.length).toBe(24);
    expect(payload.compactGlyphs?.length).toBe(96);
    expect(payload.compactGeometry?.length).toBe(96);
    expect(payload.glyphs.every((glyph) => (glyph.exons?.length ?? 0) > 0)).toBe(true);
    expect(payload.glyphs.every((glyph) => (glyph.cds?.length ?? 0) > 0)).toBe(true);
    expect(payload.glyphs.every((glyph) => glyph.transcriptId?.startsWith('NM_'))).toBe(true);
    expect(payload.glyphs.some((glyph) => 'qualifiers' in glyph)).toBe(false);
    expect(payload.glyphs.every((glyph) => !glyph.id.startsWith('summary|'))).toBe(true);
    expect(payload.compactGlyphs?.every((glyph) => !glyph[0].startsWith('summary|'))).toBe(true);
    expect(payload.glyphs.every((glyph) => /^TX\d+$/.test(glyph.label))).toBe(true);
    expect(payload.glyphs.every((glyph) => !/^\d+\s+mRNA$/i.test(glyph.label))).toBe(true);
    expect(payload.compactGlyphs?.every((glyph) => !/^\d+\s+mRNA$/i.test(glyph[2]))).toBe(true);
    expect(
      adapter.estimateAnnotationGlyphPayloadByteCount({
        type: 'annotation-glyphs',
        featureModel: 'resolved-transcript-v2',
        ...payload,
      })
    ).toBeLessThan(64_000);
  });

  it('preserves raw shape type and local track coordinates in compact broad payloads', () => {
    const promoted: Feature = {
      ...rendererFeature(0),
      type: 'ncRNA',
      annotationTrackId: 'lncRNA',
      annotationTrackLane: 0,
      annotationTrackLaneCapacity: 12,
      lane: 13,
    };
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      { features: [promoted], droppedCount: 0, typeFilteredCount: 1 },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 135_086_622 },
        widthPx: 960,
        maxPayloadBytes: 1,
      }
    );

    expect(payload.glyphs).toEqual([]);
    expect(payload.compactGlyphs?.[0]?.slice(1)).toEqual([
      'ncRNA',
      'TX0',
      promoted.start,
      promoted.end,
      '+',
      13,
      'lncRNA',
      0,
      12,
    ]);
  });

  it('keeps legacy compact tuples seven fields wide through a JSON round trip', () => {
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      { features: [rendererFeature(0)], droppedCount: 0, typeFilteredCount: 1 },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 135_086_622 },
        widthPx: 960,
        maxPayloadBytes: 1,
      }
    );

    const roundTripped = JSON.parse(JSON.stringify(payload)) as typeof payload;
    expect(roundTripped.compactGlyphs?.[0]).toHaveLength(7);
    expect(roundTripped.compactGlyphs?.[0]).not.toContain(null);
  });

  it('keeps the current viewport represented when summary glyphs are capped', () => {
    const richFeatures = Array.from({ length: 240 }, (_, index) => ({
      ...rendererFeature(index),
      start: index * 500_000,
      end: index * 500_000 + 1_000,
    }));
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      {
        features: richFeatures,
        droppedCount: 0,
        typeFilteredCount: richFeatures.length,
      },
      {
        chrom: 'chr11',
        viewportRange: { start: 47_250_000, end: 47_750_000 },
        widthPx: 960,
        maxGlyphs: 24,
      }
    );

    expect(payload.glyphs.length).toBeLessThanOrEqual(24);
    expect(payload.glyphs.length + (payload.compactGlyphs?.length ?? 0)).toBe(240);
    expect(
      payload.glyphs.some((glyph) => glyph.startBp < 48_250_000 && glyph.endBp > 46_750_000)
    ).toBe(true);
  });

  it('keeps transcript-like records on the transcript renderer path even without child exons', () => {
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      {
        features: [
          {
            id: 7,
            type: 'mRNA',
            start: 10_000,
            end: 12_000,
            direction: 'forward',
            displayName: 'single-span-mrna',
            color: 0x3b82f6,
            lane: 0,
          },
        ],
        droppedCount: 0,
        typeFilteredCount: 1,
      },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 20_000 },
        widthPx: 960,
      }
    );

    expect(payload.glyphs[0]).toMatchObject({
      type: 'mRNA',
      exons: [{ start: 10_000, end: 12_000 }],
    });
  });

  it('preserves normalized range carriers for every source type', () => {
    const types = ['gene', 'regulatory_region', 'repeat_region', 'lnc_RNA', 'misc_feature'];
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      {
        features: types.map((type, i) => ({
          id: 100 + i,
          type,
          start: 1_000 + i * 2_000,
          end: 1_000 + i * 2_000 + 800,
          direction: 'forward' as const,
          displayName: `${type}-${i}`,
          color: 0x3b82f6,
          lane: 0,
        })),
        droppedCount: 0,
        typeFilteredCount: types.length,
      },
      { chrom: 'chr11', viewportRange: { start: 0, end: 20_000 }, widthPx: 960 }
    );
    const allGlyphs = [...payload.glyphs];
    expect(allGlyphs.length).toBe(types.length);
    expect(allGlyphs.every((g) => (g.exons?.length ?? 0) > 0)).toBe(true);
    const gene = allGlyphs.find((g) => g.type === 'gene');
    expect(gene?.exons).toEqual([{ start: 1_000, end: 1_800 }]);
  });

  it('preserves every broad overview annotation identity and visible transcript geometry within the overview budget', () => {
    const richFeatures = Array.from({ length: 8_000 }, (_, index) => rendererFeature(index));
    const payload = adapter.annotationSummaryGlyphPayloadFromRendererFeatures(
      {
        features: richFeatures,
        droppedCount: 0,
        typeFilteredCount: richFeatures.length,
      },
      {
        chrom: 'chr11',
        viewportRange: { start: 0, end: 135_086_622 },
        widthPx: 960,
        maxGlyphs: 2_048,
        maxPayloadBytes: 4_000_000,
      }
    );
    const totalGlyphs = payload.glyphs.length + (payload.compactGlyphs?.length ?? 0);
    const richGeometryCount =
      payload.glyphs.filter((glyph) => (glyph.exons?.length ?? 0) > 0).length +
      (payload.compactGeometry?.length ?? 0);

    expect(totalGlyphs).toBe(richFeatures.length);
    expect(richGeometryCount).toBe(richFeatures.length);
    expect(payload.glyphs.length).toBeGreaterThan(0);
    expect(payload.compactGlyphs?.length).toBeGreaterThan(0);
    expect(payload.compactGeometry?.length).toBeGreaterThan(0);
    expect(
      adapter.estimateAnnotationGlyphPayloadByteCount({
        type: 'annotation-glyphs',
        featureModel: 'resolved-transcript-v2',
        ...payload,
      })
    ).toBeLessThanOrEqual(4_000_000);
  });

  it('keeps pseudogenes as their own track, with or without a transcript model', () => {
    const base = { chrom: 'chrIV', source: 'RefSeq', score: null, phase: null, raw: '' };
    const modelled = {
      ...base,
      type: 'pseudogene',
      start: 721070,
      end: 721481,
      strand: '-',
      attributes: { ID: ['CCW22.pseudogene.1'], Name: ['CCW22'] },
      geneId: 'CCW22.pseudogene.1',
      transcripts: [
        {
          ...base,
          type: 'mRNA',
          start: 721070,
          end: 721481,
          strand: '-',
          attributes: { ID: ['CCW22.mrna.1'] },
          transcriptId: 'CCW22.mrna.1',
          geneId: 'CCW22.pseudogene.1',
          exons: [{ start: 721071, end: 721481 }],
          cds: [],
        },
      ],
    };
    const modelless = {
      ...base,
      type: 'gene',
      start: 100,
      end: 400,
      strand: '+',
      attributes: { ID: ['gene-ydbA'], pseudo: ['true'] },
      geneId: 'gene-ydbA',
      transcripts: [],
    };
    const coding = {
      ...modelled,
      type: 'gene',
      attributes: { ID: ['PUS9.gene.1'] },
      transcripts: modelled.transcripts.map((t) => ({ ...t, attributes: { ID: ['PUS9.mrna.1'] } })),
    };
    const resolved = adapter.resolveAnnotationFeaturesForViewer(
      [modelled, modelless, coding] as unknown as GenomeFeature[],
      'resolved-transcript-v2',
      true
    );
    expect(resolved.map((f) => [f.type, f.attributes.ID?.[0]])).toEqual([
      ['pseudogene', 'CCW22.mrna.1'],
      ['pseudogene', 'gene-ydbA'],
      ['mRNA', 'PUS9.mrna.1'],
    ]);
    expect(resolved[0]._resolvedExons).toEqual([{ start: 721071, end: 721481 }]);
    expect('transcripts' in resolved[1]).toBe(false);
  });
});
