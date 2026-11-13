import { describe, it, expect } from 'vitest';
import { computeUnifiedLayout, type UnifiedLayoutInputs } from './track-layout';
import type { Genome, RenderState } from '../../../types';

const GENOME_LENGTH = 4_646_332;

function inputs(over: Partial<UnifiedLayoutInputs> = {}): UnifiedLayoutInputs {
  const pixelsPerBp = over.pixelsPerBp ?? 10;
  return {
    overlays: [],
    genome: {
      id: 'w3110',
      name: 'W3110',
      length: GENOME_LENGTH,
      features: [],
    } as unknown as Genome,
    state: {
      width: 1200,
      height: 800,
      offsetBp: 0,
      bpPerPixel: 1 / pixelsPerBp,
    } as unknown as RenderState,
    pixelsPerBp,
    viewportHeight: 800,
    hasSequence: true,
    sequenceAvailable: true,
    translationLanes: 0,
    annotationLanes: 3,
    cdsLanes: 0,
    ...over,
  };
}

const strandSlotHeight = (l: { fwdStrandTop: number; revStrandBottom: number }) =>
  l.revStrandBottom - l.fwdStrandTop;

describe('computeUnifiedLayout — linear dsDNA zoom spacing', () => {
  it('shrinks the dsDNA slot as you zoom OUT when the envelope is not reserved', () => {
    const zoomedIn = computeUnifiedLayout(inputs({ pixelsPerBp: 12 }));
    const zoomedOut = computeUnifiedLayout(inputs({ pixelsPerBp: 3 }));

    expect(strandSlotHeight(zoomedOut)).toBeLessThan(strandSlotHeight(zoomedIn));
  });

  it('shifts the annotation block as the dsDNA slot changes size', () => {
    const zoomedIn = computeUnifiedLayout(inputs({ pixelsPerBp: 12 }));
    const zoomedOut = computeUnifiedLayout(inputs({ pixelsPerBp: 3 }));

    expect(zoomedIn.annotationTop).not.toBeCloseTo(zoomedOut.annotationTop, 3);
  });

  it('keeps fwd and rev strands height-normalized at every zoom', () => {
    for (const pixelsPerBp of [1, 2, 3, 6, 12, 24]) {
      const l = computeUnifiedLayout(inputs({ pixelsPerBp }));
      const fwdHeight = l.fwdStrandBottom - l.fwdStrandTop;
      const revHeight = l.revStrandBottom - l.revStrandTop;

      expect(revHeight).toBeCloseTo(fwdHeight, 6);
      expect(l.revStrandTop).toBeCloseTo(l.fwdStrandBottom, 6);
    }
  });

  it('grows the dsDNA slot monotonically with zoom', () => {
    const heights = [1, 2, 4, 8, 16].map((pixelsPerBp) =>
      strandSlotHeight(computeUnifiedLayout(inputs({ pixelsPerBp })))
    );
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThanOrEqual(heights[i - 1]);
    }
  });

  it('keeps the indexed outer layout fixed while its visible strand pair follows zoom', () => {
    const zoomedIn = computeUnifiedLayout(
      inputs({ pixelsPerBp: 12, reserveSequenceLayoutEnvelope: true })
    );
    const zoomedOut = computeUnifiedLayout(
      inputs({ pixelsPerBp: 3, reserveSequenceLayoutEnvelope: true })
    );

    expect(strandSlotHeight(zoomedOut)).toBeLessThan(strandSlotHeight(zoomedIn));
    expect((zoomedOut.fwdStrandTop + zoomedOut.revStrandBottom) / 2).toBeCloseTo(
      (zoomedIn.fwdStrandTop + zoomedIn.revStrandBottom) / 2,
      6
    );
    expect(zoomedOut.strandEnvelopeTop).toBeCloseTo(zoomedIn.strandEnvelopeTop, 6);
    expect(zoomedOut.strandEnvelopeBottom).toBeCloseTo(zoomedIn.strandEnvelopeBottom, 6);
    expect(zoomedOut.fwdStrandTop).toBeGreaterThan(zoomedOut.strandEnvelopeTop);
    expect(zoomedOut.revStrandBottom).toBeLessThan(zoomedOut.strandEnvelopeBottom);
    expect(zoomedOut.annotationTop).toBeCloseTo(zoomedIn.annotationTop, 6);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedIn.rulerY);
    expect(zoomedOut.rulerY).toBeGreaterThan(zoomedOut.revStrandBottom);
    expect(zoomedOut.rulerY).toBeLessThan(zoomedOut.strandEnvelopeBottom);
    expect(zoomedOut.totalHeight).toBeCloseTo(zoomedIn.totalHeight, 6);
    expect(zoomedOut.trackContentHeight).toBeCloseTo(zoomedIn.trackContentHeight, 6);
    expect(zoomedOut.maxTrackScrollTop).toBeCloseTo(zoomedIn.maxTrackScrollTop, 6);
  });

  it('reserving the envelope does not alter visible strand geometry at the same zoom', () => {
    for (const pixelsPerBp of [1, 4, 12]) {
      const live = computeUnifiedLayout(inputs({ pixelsPerBp }));
      const reserved = computeUnifiedLayout(
        inputs({ pixelsPerBp, reserveSequenceLayoutEnvelope: true })
      );
      expect(strandSlotHeight(reserved)).toBeCloseTo(strandSlotHeight(live), 6);
    }
  });
});
