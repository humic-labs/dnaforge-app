import { describe, expect, it } from 'vitest';
import {
  sequenceViewer1DCanvasBackground,
  sequenceViewer1DContentWidth,
  sequenceViewer1DCursor,
  sequenceViewer1DExtraLaneHeight,
  sequenceViewer1DGappedSequenceForLayout,
  sequenceViewer1DHasCutSites,
  sequenceViewer1DHasMutationTrack,
  sequenceViewer1DIsCircular,
} from './sequence-viewer-1d-layout-flags';

describe('sequenceViewer1DIsCircular', () => {
  it('force-linearizes gapped alignments even when the source file is circular', () => {
    expect(sequenceViewer1DIsCircular(true, true)).toBe(false);
    expect(sequenceViewer1DIsCircular(false, true)).toBe(true);
    expect(sequenceViewer1DIsCircular(false, undefined)).toBe(false);
  });
});

describe('sequenceViewer1DHasCutSites / mutation track / gapped layout', () => {
  it('allocates the cut-site band only when sites exist and are shown', () => {
    expect(sequenceViewer1DHasCutSites(true, 2, 0)).toBe(true);
    expect(sequenceViewer1DHasCutSites(true, 0, 3)).toBe(true);
    expect(sequenceViewer1DHasCutSites(false, 2, 3)).toBe(false);
    expect(sequenceViewer1DHasCutSites(true, 0, 0)).toBe(false);
  });

  it('allocates the mutation track from markers or an aligned query', () => {
    expect(sequenceViewer1DHasMutationTrack(0, undefined)).toBe(false);
    expect(sequenceViewer1DHasMutationTrack(2, undefined)).toBe(true);
    expect(sequenceViewer1DHasMutationTrack(0, 'ATG')).toBe(true);
  });

  it('feeds gapped layout only in gapped mode with a gapped sequence', () => {
    expect(sequenceViewer1DGappedSequenceForLayout(true, 'A-T')).toBe('A-T');
    expect(sequenceViewer1DGappedSequenceForLayout(true, undefined)).toBeUndefined();
    expect(sequenceViewer1DGappedSequenceForLayout(false, 'A-T')).toBeUndefined();
  });
});

describe('sequenceViewer1D canvas chrome', () => {
  it('keeps circular content width and extra-lane height out of the parent', () => {
    expect(sequenceViewer1DContentWidth(true, 100, 10)).toBe(1000);
    expect(sequenceViewer1DContentWidth(false, 100, 10)).toBeUndefined();
    expect(sequenceViewer1DExtraLaneHeight([{ height: 12 }, { height: -2 }])).toBe(12);
    expect(sequenceViewer1DExtraLaneHeight([])).toBe(0);
    expect(sequenceViewer1DCursor(true, 'grab')).toBe('text');
    expect(sequenceViewer1DCursor(false, 'grab')).toBe('grab');
    expect(sequenceViewer1DCanvasBackground(true)).toBe('transparent');
  });
});
