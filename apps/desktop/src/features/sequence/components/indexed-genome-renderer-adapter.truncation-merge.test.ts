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
      startBp: 84_250_000,
      endBp: 84_550_000,
      widthPx: 960,
      heightPx: 480,
      pixelsPerBp: 0.0032,
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

describe(' truncation-aware merge — current detail must not shrink detail', () => {
  it('wider detail mrna.48 (27 exons, span 1.9Mb) survives a narrower 2-exon detail mrna.48', () => {
    const wideDetailSlot = annotationSlot({
      startBp: 83_400_000,
      endBp: 85_500_000,
      fidelity: 'best_available',
      glyphs: [
        {
          id: 'DLG2.mrna.48',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 83_455_011,
          endBp: 85_379_239,
          strand: '-',
          lane: 35,
          color: 0x3b82f6,
          transcriptId: 'DLG2.mrna.48',
          exons: Array.from({ length: 27 }, (_, i) => ({
            start: 83_455_012 + i * 100,
            end: 83_455_012 + i * 100 + 50,
          })),
        },
      ],
    });
    const narrowDetailSlot = annotationSlot({
      startBp: 84_250_000,
      endBp: 84_550_000,
      fidelity: 'best_available',
      glyphs: [
        {
          id: 'DLG2.mrna.48',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 84_251_237,
          endBp: 84_534_731,
          strand: '-',
          lane: 35,
          color: 0x3b82f6,
          transcriptId: 'DLG2.mrna.48',
          exons: [
            { start: 84_251_238, end: 84_251_291 },
            { start: 84_534_570, end: 84_534_731 },
          ],
        },
      ],
    });

    const genome = indexedGenomeSceneToRendererGenome(
      baseScene([wideDetailSlot, narrowDetailSlot]),
      {
        includeSequenceWindow: false,
      }
    );
    const m48 = (genome.features ?? []).filter((f) => f.transcriptId === 'DLG2.mrna.48');
    expect(m48).toHaveLength(1);
    expect(m48[0].start).toBe(83_455_011);
    expect(m48[0].end).toBe(85_379_239);
    expect(m48[0].exons?.length).toBe(27);
  });

  it('viewport-only feature (no summary entry) still renders normally', () => {
    const viewportSlot = annotationSlot({
      startBp: 84_250_000,
      endBp: 84_550_000,
      fidelity: 'best_available',
      glyphs: [
        {
          id: 'NEW.mrna.1',
          type: 'mRNA',
          label: 'NEW',
          startBp: 84_300_000,
          endBp: 84_500_000,
          strand: '+',
          lane: 12,
          color: 0x10b981,
          transcriptId: 'NEW.mrna.1',
          exons: [
            { start: 84_300_010, end: 84_300_090 },
            { start: 84_499_900, end: 84_500_000 },
          ],
        },
      ],
    });
    const genome = indexedGenomeSceneToRendererGenome(baseScene([viewportSlot]), {
      includeSequenceWindow: false,
    });
    const nf = (genome.features ?? []).filter((f) => f.transcriptId === 'NEW.mrna.1');
    expect(nf).toHaveLength(1);
    expect(nf[0].start).toBe(84_300_000);
    expect(nf[0].end).toBe(84_500_000);
  });

  it('slot processing order does not matter — narrower-first then wider still wins by extent', () => {
    const wideDetailSlot = annotationSlot({
      startBp: 83_400_000,
      endBp: 85_500_000,
      fidelity: 'best_available',
      glyphs: [
        {
          id: 'DLG2.mrna.48',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 83_455_011,
          endBp: 85_379_239,
          strand: '-',
          lane: 35,
          color: 0x3b82f6,
          transcriptId: 'DLG2.mrna.48',
          exons: Array.from({ length: 27 }, (_, i) => ({
            start: 83_455_012 + i * 100,
            end: 83_455_012 + i * 100 + 50,
          })),
        },
      ],
    });
    const narrowDetailSlot = annotationSlot({
      startBp: 84_250_000,
      endBp: 84_550_000,
      fidelity: 'best_available',
      glyphs: [
        {
          id: 'DLG2.mrna.48',
          type: 'mRNA',
          label: 'DLG2',
          startBp: 84_251_237,
          endBp: 84_534_731,
          strand: '-',
          lane: 35,
          color: 0x3b82f6,
          transcriptId: 'DLG2.mrna.48',
          exons: [
            { start: 84_251_238, end: 84_251_291 },
            { start: 84_534_570, end: 84_534_731 },
          ],
        },
      ],
    });

    const genome = indexedGenomeSceneToRendererGenome(
      baseScene([narrowDetailSlot, wideDetailSlot]),
      {
        includeSequenceWindow: false,
      }
    );
    const m48 = (genome.features ?? []).filter((f) => f.transcriptId === 'DLG2.mrna.48');
    expect(m48).toHaveLength(1);
    expect(m48[0].end - m48[0].start).toBe(85_379_239 - 83_455_011);
  });
});
