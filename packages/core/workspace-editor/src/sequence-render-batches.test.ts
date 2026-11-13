import { describe, expect, it } from 'vitest';
import type { PrimerDisplay } from './types';
import {
  buildLiveRulerDecorations,
  collectRenderedPrimerHits,
  goldenGateScarLabels,
  paintSequenceCutSites,
  primerVisibleSegmentsOnLine,
  sequenceAlignmentModeOptions,
  sequenceCodonMode,
  sequenceLodKind,
} from './sequence-render-batches';

function primer(overrides: Partial<PrimerDisplay>): PrimerDisplay {
  return {
    id: 'p1',
    name: 'p1',
    bases: 'AAAA',
    start: 10,
    end: 20,
    direction: 'forward',
    ...overrides,
  } as PrimerDisplay;
}

describe('sequenceLodKind / codon mode', () => {
  it('forces density for overview LOD', () => {
    expect(sequenceLodKind(true, 'detail')).toBe('density');
    expect(sequenceLodKind(false, undefined)).toBe('detail');
    expect(sequenceLodKind(false, 'feature')).toBe('feature');
  });

  it('builds alignment, draft, or normal codon modes', () => {
    expect(
      sequenceCodonMode({ alignedRef: 'AT', alignedQuery: 'AT' }, undefined, [], [])
    ).toMatchObject({ type: 'alignment' });
    expect(sequenceCodonMode(undefined, undefined, [{ start: 1, end: 2 }], [])).toMatchObject({
      type: 'draft',
    });
    expect(sequenceCodonMode(undefined, undefined, [], [])).toEqual({ type: 'normal' });
  });

  it('requires a gapped coordinate space for alignment options', () => {
    expect(sequenceAlignmentModeOptions({ mode: 'ungapped' } as never)).toBeUndefined();
    expect(
      sequenceAlignmentModeOptions({
        mode: 'gapped',
        gappedSequence: 'AT-G',
        alignedQuery: 'ATGG',
      } as never)
    ).toEqual({ alignedRef: 'AT-G', alignedQuery: 'ATGG' });
  });
});

describe('goldenGateScarLabels', () => {
  it('emits a wrap-safe scar for a forward primer with an overhang cut', () => {
    expect(
      goldenGateScarLabels(
        [
          primer({
            cutPositionInOverhang: 2,
            start: 8,
            end: 18,
          }),
        ],
        20
      )
    ).toEqual([
      expect.objectContaining({
        scarStart: 10,
        scarEnd: 14,
      }),
    ]);
  });

  it('wraps an origin-spanning primer cut back onto the circle', () => {
    expect(
      goldenGateScarLabels([primer({ cutPositionInOverhang: 3, start: 18, end: 4 })], 20)[0]
    ).toMatchObject({ scarStart: 1, scarEnd: 5 });
  });
});

describe('paintSequenceCutSites', () => {
  it('skips drawing when cut sites are hidden or at density LOD', () => {
    const ctx = {} as CanvasRenderingContext2D;
    expect(
      paintSequenceCutSites({
        ctx,
        showCutSites: false,
        lodLevel: 'detail',
        scannedCutSites: [{ enzymeName: 'EcoRI' } as never],
        cutSites: [{ enzymeName: 'BamHI' } as never],
        layout: { totalWidth: 0, totalHeight: 0, isCircular: false, lines: [] },
        config: { showReverseComplement: true } as never,
        viewport: { scrollTop: 0, height: 0 },
        hoveredCutSite: null,
        linePositions: [],
        hoveredEnzymeName: null,
        hoveredPositionInfo: null,
        primers: [],
        sharedLabelPositions: new Map(),
      })
    ).toEqual([]);
    expect(
      paintSequenceCutSites({
        ctx,
        showCutSites: true,
        lodLevel: 'density',
        scannedCutSites: [{ enzymeName: 'EcoRI' } as never],
        cutSites: [],
        layout: { totalWidth: 0, totalHeight: 0, isCircular: false, lines: [] },
        config: { showReverseComplement: true } as never,
        viewport: { scrollTop: 0, height: 0 },
        hoveredCutSite: null,
        linePositions: [],
        hoveredEnzymeName: null,
        hoveredPositionInfo: null,
        primers: [],
        sharedLabelPositions: new Map(),
      })
    ).toEqual([]);
  });
});

describe('buildLiveRulerDecorations / primerVisibleSegmentsOnLine', () => {
  it('shifts saved decorations past live insertions and adds edit marks', () => {
    const decorations = buildLiveRulerDecorations(
      [{ start: 10, end: 12, color: 'blue', layer: 'git', style: 'solid' }],
      [{ start: 2, end: 5 }],
      [{ start: 20, end: 22 }]
    );
    expect(decorations[0]).toMatchObject({ start: 13, end: 15 });
    expect(decorations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ start: 2, end: 4, layer: 'edit', style: 'solid' }),
        expect.objectContaining({ start: 20, end: 21, layer: 'edit', style: 'strikethrough' }),
      ])
    );
  });

  it('clips a linear primer to the visible line', () => {
    expect(primerVisibleSegmentsOnLine({ start: 8, end: 20 }, 10, 16, 100)).toEqual([
      { start: 10, end: 16, charIndexStart: 0 },
    ]);
  });

  it('emits hit boxes for overlapping primers using the lane map', () => {
    const hits = collectRenderedPrimerHits({
      primers: [primer({ start: 8, end: 20 })],
      lineStartPos: 10,
      lineEndPos: 16,
      sequenceLength: 100,
      forwardPrimerY: 40,
      reversePrimerY: 80,
      fwdLaneMap: new Map([['p1', 1]]),
      revLaneMap: new Map(),
      hitLaneHeight: 10,
      trackHeight: 8,
      originX: 5,
      charWidth: 2,
    });
    expect(hits).toEqual([
      {
        primer: expect.objectContaining({ id: 'p1' }),
        x: 5,
        y: 49,
        width: 12,
        height: 8,
      },
    ]);
  });
});
