// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type {
  GenomeAnnotationCompactGlyphGeometryPayloadItem,
  GenomeAnnotationCompactGlyphPayloadItem,
  GenomeAnnotationGlyphPayload,
  GenomeAnnotationGlyphPayloadItem,
} from '../../../shared/indexed-genome';
import { estimateAnnotationGlyphPayloadByteCount } from './indexed-genome-legacy-adapter';

const realJsonByteCount = (payload: GenomeAnnotationGlyphPayload): number =>
  new TextEncoder().encode(JSON.stringify(payload)).byteLength;

const richGlyph = (i: number, nExon: number, nCds: number): GenomeAnnotationGlyphPayloadItem => {
  const base = 12_345_678 + i * 5000;
  return {
    id: `chr1:${base}:NM_${100_000 + i}`,
    type: i % 3 === 0 ? 'mRNA' : i % 3 === 1 ? 'CDS' : 'lnc_RNA',
    label: `GENE${i}-20${i % 9}`,
    startBp: base,
    endBp: base + 3200,
    strand: i % 2 === 0 ? '+' : '-',
    lane: i % 12,
    color: 0x33abcc,
    ...(nExon > 0
      ? {
          exons: Array.from({ length: nExon }, (_, e) => ({
            start: base + e * 300,
            end: base + e * 300 + 180,
          })),
        }
      : {}),
    ...(nCds > 0
      ? {
          cds: Array.from({ length: nCds }, (_, c) => ({
            start: base + 60 + c * 300,
            end: base + 60 + c * 300 + 120,
          })),
        }
      : {}),
    ...(i % 4 === 0 ? { transcriptId: `NM_${100_000 + i}.5` } : {}),
  };
};

const buildRichPayload = (count: number): GenomeAnnotationGlyphPayload => ({
  type: 'annotation-glyphs',
  featureModel: 'resolved-transcript-v2',
  glyphs: Array.from({ length: count }, (_, i) => richGlyph(i, i % 11, i % 6)),
  styleByType: { mRNA: { color: 1 }, CDS: { color: 2 }, lnc_RNA: { color: 3 } },
  laneBounds: { maxAnnotationLane: 11, maxCdsLane: 5 },
  droppedCount: 0,
  typeFilteredCount: count,
});

const buildCompactPayload = (count: number): GenomeAnnotationGlyphPayload => {
  const compactGlyphs: GenomeAnnotationCompactGlyphPayloadItem[] = Array.from(
    { length: count },
    (_, i) => {
      const b = 12_000_000 + i * 7000;
      return [`chr2:${b}:X${i}`, 'mRNA', `LBL${i}`, b, b + 900, i % 2 ? '+' : '-', i % 8];
    }
  );
  const compactGeometry: GenomeAnnotationCompactGlyphGeometryPayloadItem[] = Array.from(
    { length: count },
    (_, i) => {
      const b = 12_000_000 + i * 7000;
      return [
        `chr2:${b}:X${i}`,
        Array.from({ length: (i % 9) * 2 }, (_, k) => b + k * 40),
        Array.from({ length: (i % 5) * 2 }, (_, k) => b + 20 + k * 40),
        `X${i}.2`,
      ];
    }
  );
  return {
    type: 'annotation-glyphs',
    featureModel: 'resolved-transcript-v2',
    glyphs: [],
    compactGlyphs,
    compactGeometry,
    styleByType: { mRNA: { color: 1 } },
    laneBounds: { maxAnnotationLane: 7, maxCdsLane: 4 },
    droppedCount: 3,
    typeFilteredCount: count,
  };
};

const buildRichTrackMetadataPayload = (count: number): GenomeAnnotationGlyphPayload => {
  const payload = buildRichPayload(count);
  return {
    ...payload,
    glyphs: payload.glyphs.map((glyph, index) => ({
      ...glyph,
      trackId: 'transcriptional_cis_regulatory_region',
      trackLane: index % 12,
      trackLaneCapacity: 12,
    })),
  };
};

const buildCompactTrackMetadataPayload = (count: number): GenomeAnnotationGlyphPayload => {
  const payload = buildCompactPayload(count);
  return {
    ...payload,
    compactGlyphs: payload.compactGlyphs?.map((glyph, index) => [
      ...glyph,
      'transcriptional_cis_regulatory_region',
      index % 12,
      12,
    ]),
  };
};

describe('estimateAnnotationGlyphPayloadByteCount', () => {
  it('returns 0 for a null payload', () => {
    expect(estimateAnnotationGlyphPayloadByteCount(null)).toBe(0);
  });

  it('approximates the real JSON byte size of a rich glyph payload within 15%', () => {
    for (const count of [1, 64, 2048]) {
      const payload = buildRichPayload(count);
      const estimate = estimateAnnotationGlyphPayloadByteCount(payload);
      const real = realJsonByteCount(payload);
      const ratio = estimate / real;
      expect(ratio, `count=${count} estimate=${estimate} real=${real}`).toBeGreaterThan(0.85);
      expect(ratio, `count=${count} estimate=${estimate} real=${real}`).toBeLessThan(1.15);
    }
  });

  it('approximates the real JSON byte size of a compact payload within 20%', () => {
    for (const count of [1, 64, 1024]) {
      const payload = buildCompactPayload(count);
      const estimate = estimateAnnotationGlyphPayloadByteCount(payload);
      const real = realJsonByteCount(payload);
      const ratio = estimate / real;
      expect(ratio, `count=${count} estimate=${estimate} real=${real}`).toBeGreaterThan(0.8);
      expect(ratio, `count=${count} estimate=${estimate} real=${real}`).toBeLessThan(1.2);
    }
  });

  it('accounts for track-local metadata in rich and compact payload budgets', () => {
    for (const [kind, build, tolerance] of [
      ['rich', buildRichTrackMetadataPayload, 0.15],
      ['compact', buildCompactTrackMetadataPayload, 0.2],
    ] as const) {
      for (const count of [1, 64, 2_048]) {
        const payload = build(count);
        const estimate = estimateAnnotationGlyphPayloadByteCount(payload);
        const real = realJsonByteCount(payload);
        const ratio = estimate / real;
        expect(ratio, `${kind} count=${count} estimate=${estimate} real=${real}`).toBeGreaterThan(
          1 - tolerance
        );
        expect(ratio, `${kind} count=${count} estimate=${estimate} real=${real}`).toBeLessThan(
          1 + tolerance
        );
      }
    }
  });

  it('does NOT serialize the payload (the whole point — cheap, no giant string)', () => {
    const payload = buildRichPayload(500);
    const stringifySpy = vi.spyOn(JSON, 'stringify');
    try {
      estimateAnnotationGlyphPayloadByteCount(payload);
      expect(stringifySpy).not.toHaveBeenCalled();
    } finally {
      stringifySpy.mockRestore();
    }
  });

  it('scales monotonically with feature count (usable as a change-detection signal)', () => {
    const small = estimateAnnotationGlyphPayloadByteCount(buildRichPayload(10));
    const large = estimateAnnotationGlyphPayloadByteCount(buildRichPayload(1000));
    expect(large).toBeGreaterThan(small * 50);
  });
});
