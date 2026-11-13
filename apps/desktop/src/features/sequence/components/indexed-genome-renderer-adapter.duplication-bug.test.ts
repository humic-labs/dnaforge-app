// @vitest-environment node

import { describe, expect, it } from 'vitest';

import type { IndexedGenomeScene, IndexedGenomeSceneTileSlot } from './indexed-genome-scene';
import { indexedGenomeSceneToRendererGenome } from './indexed-genome-renderer-adapter';

function annotationSlot(
  overrides: Partial<IndexedGenomeSceneTileSlot> & {
    startBp: number;
    endBp: number;
    glyphs: IndexedGenomeSceneTileSlot extends infer S
      ? S extends { payload?: { type: 'annotation-glyphs'; glyphs: infer G } }
        ? G
        : never
      : never;
  }
): IndexedGenomeSceneTileSlot {
  const { glyphs, startBp, endBp, ...rest } = overrides;
  return {
    trackId: 'chr11:annotations',
    kind: 'annotation',
    chrom: 'chr11',
    startBp,
    endBp,
    generation: 8,
    state: 'ready',
    fidelity: 'best_available',
    validationState: 'metadata_match',
    cacheState: 'none',
    byteCount: 128,
    recordCount: glyphs.length,
    currentForViewport: true,
    laneEpoch: 'fingerprint-chr11:chr11:lane-v0',
    payload: {
      type: 'annotation-glyphs',
      featureModel: 'resolved-transcript-v2',
      glyphs,
      droppedCount: 0,
      typeFilteredCount: glyphs.length,
    },
    ...rest,
  };
}

function baseScene(slots: IndexedGenomeSceneTileSlot[]): IndexedGenomeScene {
  return {
    mode: 'tile-native-session-shell',
    sessionId: 'session-chr11',
    sourceId: '/workspace/chr11.fa',
    sourceFingerprint: 'fingerprint-chr11',
    chrom: 'chr11',
    lengthState: 'coordinate_ready',
    length: 135_086_622,
    coordinateReady: true,
    validationState: 'metadata_match',
    laneEpoch: 'fingerprint-chr11:chr11:lane-v0',
    viewport: {
      chrom: 'chr11',
      startBp: 1_000_000,
      endBp: 1_000_500,
      widthPx: 960,
      heightPx: 480,
      pixelsPerBp: 1.92,
      generation: 8,
    },
    tracks: [
      {
        id: 'chr11:annotations',
        kind: 'annotation',
        label: 'Annotations',
        state: 'ready',
        userState: 'Ready',
      },
    ],
    tileSlots: slots,
  };
}

describe(' duplication bug — adapter merge does not dedup by qualifiers.ID', () => {
  it('assigns distinct renderer-local ids when two full-GRCh38 annotations hash to the same legacy id', () => {
    const sourceFingerprint =
      'assembly-annotation-source-sha256.v1:00f15f3d0fe7619f9f549c01ef96b4edaa328ce7146dcce0cf152302be20fa8b';
    const assemblyChrom =
      'chr1+chr2+chr3+chr4+chr5+chr6+chr7+chr8+chr9+chr10+chr11+chr12+chr13+chr14+chr15+chr16+chr17+chr18+chr19+chr20+chr21+chr22+chrX+chrY';
    const slot = annotationSlot({
      startBp: 0,
      endBp: 1_500_000_000,
      chrom: assemblyChrom,
      glyphs: [
        {
          id: '69ggwi',
          type: 'mRNA',
          trackId: 'mRNA',
          label: 'XM_005271325.5',
          startBp: 77_888_623,
          endBp: 77_943_895,
          strand: '+',
          lane: 3,
          color: 0x3b82f6,
          exons: [{ start: 77_888_623, end: 77_943_895 }],
          transcriptId: 'NEXN.mrna.3',
        },
        {
          id: '2j4kmu',
          type: 'mRNA',
          trackId: 'mRNA',
          label: 'NM_001304521.2',
          startBp: 1_360_396_579,
          endBp: 1_360_414_285,
          strand: '-',
          lane: 6,
          color: 0x3b82f6,
          exons: [{ start: 1_360_396_579, end: 1_360_414_285 }],
          transcriptId: 'IMPDH1.mrna.1',
        },
      ],
    });
    const genome = indexedGenomeSceneToRendererGenome(
      {
        ...baseScene([slot]),
        sourceFingerprint,
        chrom: assemblyChrom,
        length: 3_088_269_832,
        viewport: {
          ...baseScene([slot]).viewport!,
          chrom: assemblyChrom,
          startBp: 0,
          endBp: 1_500_000_000,
        },
      },
      {
        includeSequenceWindow: false,
        enableTransitionRetention: false,
      }
    );

    const features = genome.features ?? [];
    expect(features).toHaveLength(2);
    expect(new Set(features.map((feature) => feature.canonicalIdentity)).size).toBe(2);
    expect(new Set(features.map((feature) => feature.id)).size).toBe(features.length);
  });

  it('preserves distinct X/Y loci that share a transcript id inside one authoritative assembly payload', () => {
    const slot = annotationSlot({
      startBp: 0,
      endBp: 2_000_000,
      glyphs: [
        {
          id: 'chrX-SHOX',
          type: 'mRNA',
          label: 'SHOX X',
          startBp: 100_000,
          endBp: 120_000,
          strand: '+',
          lane: 0,
          color: 0x3b82f6,
          exons: [{ start: 100_000, end: 100_100 }],
          transcriptId: 'SHOX.mrna.2',
        },
        {
          id: 'chrY-SHOX',
          type: 'mRNA',
          label: 'SHOX Y',
          startBp: 1_100_000,
          endBp: 1_120_000,
          strand: '+',
          lane: 0,
          color: 0x3b82f6,
          exons: [{ start: 1_100_000, end: 1_100_100 }],
          transcriptId: 'SHOX.mrna.2',
        },
      ],
    });

    const genome = indexedGenomeSceneToRendererGenome(baseScene([slot]), {
      includeSequenceWindow: false,
    });

    expect(genome.features?.map((feature) => feature.displayName)).toEqual(['SHOX X', 'SHOX Y']);
  });

  it('produces TWO features when two slots carry the same glyph.id with different (start, end)', () => {
    const slot1 = annotationSlot({
      startBp: 999_000,
      endBp: 1_000_300,
      glyphs: [
        {
          id: 'DLG2.mrna.52',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 999_500,
          endBp: 1_000_200,
          strand: '-',
          lane: 5,
          color: 0x3b82f6,
          exons: [
            { start: 999_520, end: 999_580 },
            { start: 1_000_120, end: 1_000_200 },
          ],
        },
      ],
    });
    const slot2 = annotationSlot({
      startBp: 1_000_100,
      endBp: 1_000_500,
      glyphs: [
        {
          id: 'DLG2.mrna.52',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 1_000_150,
          endBp: 1_000_400,
          strand: '-',
          lane: 8,
          color: 0x3b82f6,
          exons: [{ start: 1_000_180, end: 1_000_240 }],
        },
      ],
    });

    const genome = indexedGenomeSceneToRendererGenome(baseScene([slot1, slot2]), {
      includeSequenceWindow: false,
    });

    const dlg2 = (genome.features ?? []).filter((f) => f.qualifiers?.ID === 'DLG2.mrna.52');

    expect(dlg2).toHaveLength(1);
    expect(dlg2[0].start).toBe(999_500);
    expect(dlg2[0].end).toBe(1_000_200);
  });

  it('correctly dedups when two slots carry the same glyph.id with IDENTICAL coords', () => {
    const sharedGlyph = {
      id: 'DLG2.mrna.52',
      type: 'mRNA' as const,
      label: 'DLG2',
      startBp: 1_000_000,
      endBp: 1_000_400,
      strand: '-' as const,
      lane: 5,
      color: 0x3b82f6,
      exons: [{ start: 1_000_010, end: 1_000_090 }],
    };
    const slot1 = annotationSlot({
      startBp: 999_000,
      endBp: 1_000_500,
      glyphs: [sharedGlyph],
    });
    const slot2 = annotationSlot({
      startBp: 999_000,
      endBp: 1_000_500,
      glyphs: [{ ...sharedGlyph }],
    });

    const genome = indexedGenomeSceneToRendererGenome(baseScene([slot1, slot2]), {
      includeSequenceWindow: false,
    });

    const dlg2 = (genome.features ?? []).filter((f) => f.qualifiers?.ID === 'DLG2.mrna.52');
    expect(dlg2).toHaveLength(1);
  });
});
