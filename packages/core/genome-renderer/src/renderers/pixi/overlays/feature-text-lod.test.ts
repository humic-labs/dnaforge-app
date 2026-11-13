import { describe, it, expect } from 'vitest';
import { shouldRenderFeatureTextAtLod, LARGE_GENOME_TEXT_LOD_LENGTH_BP } from './feature-text-lod';
import { OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP } from './annotation-lod-policy';
import { sequenceFullViewportPixelsPerBp } from '../shared/sequence-sizing';

const MG1655_BP = 4_641_652;
const PPB_LADDER = [
  0.009, 0.035, 0.088, 0.176, 0.264, 0.352, 0.44, 0.528, 0.634, 0.704, 0.88, 0.95, 1.021, 1.126,
  1.232, 1.32, 1.408, 1.584, 1.76, 1.936, 2.006, 2.112, 4, 8, 14,
];

const revealedAt = (pixelsPerBp: number, spanPx: number) =>
  pixelsPerBp >= sequenceFullViewportPixelsPerBp(spanPx);

const VIEWPORT_SPANS_PX = [400, 800, 1293, 2600, 3786];

describe('shouldRenderFeatureTextAtLod — monotonic in zoom', () => {
  it('never turns labels OFF as you zoom IN, at any pane width', () => {
    const regressions: string[] = [];
    for (const spanPx of VIEWPORT_SPANS_PX) {
      for (const genomeLength of [2_686, 99_999, 100_000, MG1655_BP]) {
        let seenAllowed = false;
        for (const pixelsPerBp of PPB_LADDER) {
          const allowed = shouldRenderFeatureTextAtLod({
            sequenceVisible: revealedAt(pixelsPerBp, spanPx),
            genomeLength,
            pixelsPerBp,
          });
          if (allowed) seenAllowed = true;
          else if (seenAllowed)
            regressions.push(
              `span ${spanPx}px len ${genomeLength} ppb ${pixelsPerBp}: labels forbidden after an earlier allow`
            );
        }
      }
    }
    expect(regressions).toEqual([]);
  });

  it('specifically permits labels in the band MG1655 blanked out (ppb 0.95 .. 1.94)', () => {
    for (const spanPx of VIEWPORT_SPANS_PX) {
      for (const pixelsPerBp of [0.95, 1.021, 1.408, 1.76, 1.936]) {
        expect(
          shouldRenderFeatureTextAtLod({
            sequenceVisible: revealedAt(pixelsPerBp, spanPx),
            genomeLength: MG1655_BP,
            pixelsPerBp,
          }),
          `span ${spanPx}px ppb ${pixelsPerBp}`
        ).toBe(true);
      }
    }
  });

  it('is monotonic for every genome size, with reveal coupled to zoom', () => {
    for (const genomeLength of [
      2_686,
      99_999,
      LARGE_GENOME_TEXT_LOD_LENGTH_BP,
      MG1655_BP,
      3_088_269_832,
    ]) {
      let seenAllowed = false;
      for (const pixelsPerBp of PPB_LADDER) {
        const allowed = shouldRenderFeatureTextAtLod({
          sequenceVisible: revealedAt(pixelsPerBp, 1293),
          genomeLength,
          pixelsPerBp,
        });
        if (allowed) seenAllowed = true;
        else
          expect(
            seenAllowed,
            `len=${genomeLength} ppb=${pixelsPerBp} forbids labels after an earlier allow`
          ).toBe(false);
      }
    }
  });

  it('still permits labels on a small genome at every zoom', () => {
    for (const pixelsPerBp of PPB_LADDER) {
      expect(
        shouldRenderFeatureTextAtLod({
          sequenceVisible: revealedAt(pixelsPerBp, 1293),
          genomeLength: 2_686,
          pixelsPerBp,
        })
      ).toBe(true);
    }
  });

  it('still permits labels on the wide overview before the sequence is revealed', () => {
    expect(
      shouldRenderFeatureTextAtLod({
        sequenceVisible: false,
        genomeLength: MG1655_BP,
        pixelsPerBp: 0.009,
      })
    ).toBe(true);
  });

  it('starts assembly-scale arc labels exactly when retained rectangles yield to full shapes', () => {
    const assemblyLength = 3_088_269_832;
    expect(
      shouldRenderFeatureTextAtLod({
        sequenceVisible: false,
        genomeLength: assemblyLength,
        pixelsPerBp: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999,
        isArcMode: true,
      })
    ).toBe(false);
    expect(
      shouldRenderFeatureTextAtLod({
        sequenceVisible: false,
        genomeLength: assemblyLength,
        pixelsPerBp: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP,
        isArcMode: true,
      })
    ).toBe(true);
    expect(
      shouldRenderFeatureTextAtLod({
        sequenceVisible: false,
        genomeLength: assemblyLength,
        pixelsPerBp: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999,
        isArcMode: false,
      })
    ).toBe(true);
    expect(
      shouldRenderFeatureTextAtLod({
        sequenceVisible: false,
        genomeLength: MG1655_BP,
        pixelsPerBp: OVERVIEW_LOD_FULL_SHAPES_PIXELS_PER_BP * 0.999,
        isArcMode: true,
      })
    ).toBe(true);
  });
});
